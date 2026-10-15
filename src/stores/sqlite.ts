import type { StoredTokens, TokenStore } from '../types.js';

/** The subset of `better-sqlite3` (and `node:sqlite`'s `DatabaseSync`) this adapter needs. */
export interface SqliteDatabaseLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
}

/**
 * Stores one JSON row per `key` in a `qbo_tokens` table. Pass a different `key` per tenant.
 * Tokens are stored as plain text: encrypt at rest (disk/volume level) or wrap this
 * store with your own encrypting TokenStore if that matters for your threat model.
 */
export class SqliteTokenStore implements TokenStore {
  constructor(
    private readonly db: SqliteDatabaseLike,
    private readonly key = 'default'
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS qbo_tokens (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
  }

  async get(): Promise<StoredTokens | null> {
    const row = this.db.prepare('SELECT value FROM qbo_tokens WHERE key = ?').get(this.key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as StoredTokens) : null;
  }

  async set(tokens: StoredTokens): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO qbo_tokens (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      )
      .run(this.key, JSON.stringify(tokens), tokens.updatedAt);
  }

  async delete(): Promise<void> {
    this.db.prepare('DELETE FROM qbo_tokens WHERE key = ?').run(this.key);
  }
}
