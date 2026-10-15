import { MemoryAuditLog, summarizeHealth, type AuditLog, type HealthSummary } from './audit.js';
import { QboClient } from './client.js';
import type { Endpoints } from './config.js';
import { resolveEnvironment } from './config.js';
import { QboError, QboNotConnectedError, QboReconnectRequiredError } from './errors.js';
import { QboOAuth } from './oauth.js';
import { createState, verifyState } from './state.js';
import { TokenManager } from './token-manager.js';
import type { FetchLike, QboEnvironment, TokenStore } from './types.js';

export interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** 'sandbox' (default) or 'production'. Tokens are bound to the environment they were issued for. */
  environment?: QboEnvironment | string;
  store: TokenStore;
  audit?: AuditLog;
  /** Secret for signing the OAuth `state` (CSRF). Any long random string; can reuse an app secret. */
  stateSecret: string;
  fetch?: FetchLike;
  endpoints?: Partial<Endpoints>;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  minorVersion?: number;
}

export interface ConnectionStatus {
  connected: boolean;
  environment: QboEnvironment;
  realmId?: string;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  needsReconnect: boolean;
  reason?: string;
}

export interface ConnectionTest {
  connected: boolean;
  environment: QboEnvironment;
  companyName?: string;
  error?: string;
  needsReconnect?: boolean;
}

export interface QuickBooksKit {
  environment: QboEnvironment;
  oauth: QboOAuth;
  tokens: TokenManager;
  client: QboClient;
  audit: AuditLog;
  /** URL to send the admin's browser to. */
  connectUrl(binding?: string): string;
  /** Verify `state`, exchange the code, persist tokens. Returns the realm id. */
  handleCallback(callbackUrl: string, binding?: string): Promise<{ realmId: string }>;
  /** Offline: reads the store only, makes no network call. */
  status(): Promise<ConnectionStatus>;
  /** Online: calls CompanyInfo (refreshing if needed) and audits the result. */
  testConnection(): Promise<ConnectionTest>;
  /** Revoke at Intuit (best effort) and delete stored tokens. */
  disconnect(): Promise<{ revoked: boolean }>;
  health(windowMs?: number): Promise<HealthSummary | null>;
}

export function createQuickBooks(config: QuickBooksConfig): QuickBooksKit {
  const environment = resolveEnvironment(config.environment as string | undefined);
  const audit = config.audit ?? new MemoryAuditLog();
  const oauth = new QboOAuth({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    environment,
    endpoints: config.endpoints,
    fetch: config.fetch,
  });
  const tokens = new TokenManager({ store: config.store, oauth, audit, lock: config.lock });
  const client = new QboClient({
    tokens,
    environment,
    audit,
    fetch: config.fetch,
    apiBaseUrl: config.endpoints?.api,
    minorVersion: config.minorVersion,
  });

  const record = (action: string, success: boolean, extra: { error?: string; manual?: boolean; realmId?: string } = {}) =>
    audit.record({
      timestamp: new Date().toISOString(),
      level: success ? 'INFO' : 'ERROR',
      category: 'connection',
      action,
      success,
      environment,
      refs: extra.realmId ? { realmId: extra.realmId } : undefined,
      error: extra.error,
      requiresManualIntervention: extra.manual,
    });

  return {
    environment,
    oauth,
    tokens,
    client,
    audit,
    connectUrl: (binding = '') => oauth.authorizeUrl(createState(config.stateSecret, binding)),

    async handleCallback(callbackUrl, binding = '') {
      try {
        const { code, realmId, state } = oauth.parseCallback(callbackUrl);
        if (!verifyState(config.stateSecret, state, { binding })) {
          throw new Error('Invalid or expired OAuth state');
        }
        await tokens.save(await oauth.exchangeCode(code, realmId));
        await record('connection.connect', true, { realmId });
        return { realmId };
      } catch (err) {
        await record('connection.connect', false, { error: (err as Error).message });
        throw err;
      }
    },

    async status() {
      const t = await tokens.load();
      if (!t) return { connected: false, environment, needsReconnect: false, reason: 'not connected' };
      const refreshExpired = !!t.refreshTokenExpiresAt && t.refreshTokenExpiresAt <= Date.now();
      return {
        connected: !refreshExpired,
        environment,
        realmId: t.realmId,
        accessTokenExpiresAt: new Date(t.accessTokenExpiresAt).toISOString(),
        refreshTokenExpiresAt: t.refreshTokenExpiresAt ? new Date(t.refreshTokenExpiresAt).toISOString() : undefined,
        needsReconnect: refreshExpired,
        reason: refreshExpired ? 'refresh token expired' : undefined,
      };
    },

    async testConnection() {
      try {
        const info = await client.getCompanyInfo();
        await record('connection.test', true);
        return { connected: true, environment, companyName: info.CompanyName };
      } catch (err) {
        const e = err as Error;
        const needsReconnect = e instanceof QboReconnectRequiredError;
        await record('connection.test', false, { error: e.message, manual: needsReconnect });
        if (e instanceof QboNotConnectedError || needsReconnect || e instanceof QboError) {
          return { connected: false, environment, error: e.message, needsReconnect };
        }
        throw err;
      }
    },

    async disconnect() {
      const t = await tokens.load();
      let revoked = false;
      if (t) {
        try {
          await oauth.revoke(t.refreshToken);
          revoked = true;
        } catch {
          /* still delete locally; the user can revoke in the Intuit dashboard */
        }
      }
      await tokens.clear();
      await record('connection.disconnect', true);
      return { revoked };
    },

    async health(windowMs = 24 * 3600_000) {
      if (!audit.list) return null;
      const entries = await audit.list({ limit: 1000, since: Date.now() - windowMs });
      return summarizeHealth(entries, windowMs);
    },
  };
}

