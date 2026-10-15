import { ACCOUNTING_SCOPE, DEFAULT_ENDPOINTS, type Endpoints } from './config.js';
import { QboOAuthError } from './errors.js';
import type { FetchLike, QboEnvironment, StoredTokens } from './types.js';

export interface OAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: QboEnvironment;
  scopes?: string[];
  endpoints?: Partial<Endpoints>;
  fetch?: FetchLike;
  now?: () => number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}

/** Thin, dependency-free wrapper over Intuit's OAuth 2.0 endpoints. */
export class QboOAuth {
  readonly endpoints: Endpoints;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: OAuthOptions) {
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error('QuickBooks clientId and clientSecret are required');
    }
    this.endpoints = { ...DEFAULT_ENDPOINTS[opts.environment], ...opts.endpoints };
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.now = opts.now ?? Date.now;
  }

  get environment(): QboEnvironment {
    return this.opts.environment;
  }

  authorizeUrl(state: string): string {
    const url = new URL(this.endpoints.authorize);
    url.searchParams.set('client_id', this.opts.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', (this.opts.scopes ?? [ACCOUNTING_SCOPE]).join(' '));
    url.searchParams.set('redirect_uri', this.opts.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Parse the redirect Intuit sends the browser to. Throws on an `error` response. */
  parseCallback(callbackUrl: string): { code: string; realmId: string; state: string | null } {
    const url = new URL(callbackUrl);
    const error = url.searchParams.get('error');
    if (error) throw new QboOAuthError(`Authorization denied: ${error}`, 400, error);
    const code = url.searchParams.get('code');
    const realmId = url.searchParams.get('realmId');
    if (!code) throw new QboOAuthError('Callback is missing the "code" parameter', 400);
    if (!realmId) throw new QboOAuthError('Callback is missing the "realmId" parameter', 400);
    return { code, realmId, state: url.searchParams.get('state') };
  }

  async exchangeCode(code: string, realmId: string): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.opts.redirectUri,
    });
    const res = await this.tokenRequest(body);
    return this.toStored(res, realmId);
  }

  /**
   * Refresh. Intuit rotates refresh tokens: the response may carry a NEW refresh token
   * and the old one should be discarded. Callers must persist the result before use.
   */
  async refresh(current: Pick<StoredTokens, 'refreshToken' | 'realmId'>): Promise<StoredTokens> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    });
    const res = await this.tokenRequest(body);
    return this.toStored(res, current.realmId);
  }

  /** Revoke the refresh token (disconnect). Failure is surfaced, caller decides. */
  async revoke(token: string): Promise<void> {
    const res = await this.fetchFn(this.endpoints.revoke, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      throw new QboOAuthError(`Token revocation failed with HTTP ${res.status}`, res.status);
    }
  }

  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const res = await this.fetchFn(this.endpoints.token, {
      method: 'POST',
      headers: this.headers(),
      body: body.toString(),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || !json?.access_token) {
      const code: string | undefined = json?.error;
      throw new QboOAuthError(
        `Token endpoint returned HTTP ${res.status}${code ? ` (${code})` : ''}`,
        res.status,
        code
      );
    }
    return json as TokenResponse;
  }

  private toStored(res: TokenResponse, realmId: string): StoredTokens {
    const now = this.now();
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      realmId,
      accessTokenExpiresAt: now + res.expires_in * 1000,
      refreshTokenExpiresAt: res.x_refresh_token_expires_in
        ? now + res.x_refresh_token_expires_in * 1000
        : undefined,
      environment: this.opts.environment,
      updatedAt: now,
    };
  }
}
