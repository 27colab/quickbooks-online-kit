import { QboOAuthError, QboNotConnectedError, QboReconnectRequiredError } from './errors.js';
import type { QboOAuth } from './oauth.js';
import { noopAudit, type AuditLog } from './audit.js';
import type { QboEnvironment, StoredTokens, TokenStore } from './types.js';

export interface TokenManagerOptions {
  store: TokenStore;
  oauth: QboOAuth;
  audit?: AuditLog;
  /** Refresh this long before the access token actually expires. Default 60s. */
  refreshSkewMs?: number;
  /**
   * Optional cross-process mutex (e.g. a Postgres advisory lock or Redis lock).
   * Without it, concurrent *processes* are protected only by the re-read-on-failure
   * fallback; concurrent calls inside one process are always single-flighted.
   */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
}

/**
 * Hands out valid access tokens and owns refresh. Guarantees:
 *  - concurrent callers in one process share ONE refresh request (single-flight);
 *  - the rotated refresh token is persisted BEFORE the new access token is returned,
 *    so a crash cannot leave you holding a dead refresh token;
 *  - if the refresh is rejected (`invalid_grant`) but another process already rotated
 *    the stored token, the stored tokens are adopted instead of failing.
 */
export class TokenManager {
  private inflight: Promise<StoredTokens> | null = null;
  private readonly skew: number;
  private readonly audit: AuditLog;
  private readonly now: () => number;

  constructor(private readonly opts: TokenManagerOptions) {
    this.skew = opts.refreshSkewMs ?? 60_000;
    this.audit = opts.audit ?? noopAudit;
    this.now = opts.now ?? Date.now;
  }

  get environment(): QboEnvironment {
    return this.opts.oauth.environment;
  }

  /** Persist tokens from the initial authorization-code exchange. */
  async save(tokens: StoredTokens): Promise<void> {
    await this.opts.store.set(tokens);
  }

  async clear(): Promise<void> {
    await this.opts.store.delete();
  }

  async load(): Promise<StoredTokens | null> {
    const t = await this.opts.store.get();
    if (t && t.environment !== this.environment) return null; // never use sandbox tokens against prod
    return t;
  }

  /** A usable token set, refreshing first when needed (or when `force` is set). */
  async getTokens({ force = false, rejectedAccessToken }: { force?: boolean; rejectedAccessToken?: string } = {}): Promise<StoredTokens> {
    const current = await this.load();
    if (!current) throw new QboNotConnectedError();

    if (force) {
      // The caller got a 401 using `rejectedAccessToken`. If someone already replaced it, just use that.
      if (rejectedAccessToken && current.accessToken !== rejectedAccessToken) return current;
    } else if (current.accessTokenExpiresAt - this.skew > this.now()) {
      return current;
    }

    if (!this.inflight) {
      this.inflight = this.refreshLocked(current).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async getAccessToken(): Promise<string> {
    return (await this.getTokens()).accessToken;
  }

  private refreshLocked(seen: StoredTokens): Promise<StoredTokens> {
    const run = () => this.refreshOnce(seen);
    return this.opts.lock ? this.opts.lock(run) : run();
  }

  private async refreshOnce(seen: StoredTokens): Promise<StoredTokens> {
    const started = this.now();
    // Another process may have refreshed while we waited (lock) or since we read.
    const latest = (await this.load()) ?? seen;
    if (latest.refreshToken !== seen.refreshToken && latest.accessTokenExpiresAt - this.skew > this.now()) {
      return latest;
    }
    if (latest.refreshTokenExpiresAt && latest.refreshTokenExpiresAt <= this.now()) {
      await this.fail(started, 'Refresh token expired', 400, true);
      throw new QboReconnectRequiredError();
    }
    try {
      const fresh = await this.opts.oauth.refresh(latest);
      await this.opts.store.set(fresh); // persist rotation before anyone uses it
      await this.audit.record({
        timestamp: new Date(this.now()).toISOString(),
        level: 'INFO',
        category: 'token_refresh',
        action: 'token.refresh',
        success: true,
        environment: this.environment,
        durationMs: this.now() - started,
        refs: { rotated: String(fresh.refreshToken !== latest.refreshToken) },
      });
      return fresh;
    } catch (err) {
      if (err instanceof QboOAuthError && err.oauthError === 'invalid_grant') {
        // Lost a cross-process race? Adopt what the winner stored.
        const stored = await this.load();
        if (stored && stored.refreshToken !== latest.refreshToken) {
          return stored;
        }
        await this.fail(started, err.message, err.status, true);
        throw new QboReconnectRequiredError();
      }
      await this.fail(started, (err as Error).message, (err as QboOAuthError).status, false);
      throw err;
    }
  }

  private async fail(started: number, error: string, httpStatus: number | undefined, manual: boolean) {
    await this.audit.record({
      timestamp: new Date(this.now()).toISOString(),
      level: manual ? 'ERROR' : 'WARNING',
      category: 'token_refresh',
      action: 'token.refresh',
      success: false,
      environment: this.environment,
      durationMs: this.now() - started,
      httpStatus,
      error,
      requiresManualIntervention: manual,
    });
  }
}
