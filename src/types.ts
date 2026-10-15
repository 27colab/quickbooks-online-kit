export type QboEnvironment = 'sandbox' | 'production';

/** Everything we persist for one QuickBooks connection. Times are epoch milliseconds. */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  /** When the access token stops being valid. */
  accessTokenExpiresAt: number;
  /** When the refresh token stops being valid (Intuit: ~100 days, rolling). */
  refreshTokenExpiresAt?: number;
  environment: QboEnvironment;
  /** Bumped on every write; lets stores and tests detect rotation. */
  updatedAt: number;
}

/**
 * Storage-agnostic persistence for tokens. One store instance holds one connection;
 * if you serve many tenants, create a store per tenant (adapters take a `key`).
 */
export interface TokenStore {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  delete(): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
}
