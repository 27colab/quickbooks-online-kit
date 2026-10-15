import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { FileTokenStore, JsonlAuditLog, MemoryAuditLog, MemoryTokenStore, SqliteTokenStore, summarizeHealth, type AuditEntry, type StoredTokens, type TokenStore } from '../src/index.js';

const sample: StoredTokens = {
  accessToken: 'a', refreshToken: 'r', realmId: '123', accessTokenExpiresAt: 10, refreshTokenExpiresAt: 20, environment: 'sandbox', updatedAt: 1,
};

function contract(name: string, make: () => TokenStore) {
  describe(`${name} TokenStore`, () => {
    it('get/set/delete round trip', async () => {
      const s = make();
      expect(await s.get()).toBeNull();
      await s.set(sample);
      expect(await s.get()).toEqual(sample);
      await s.set({ ...sample, refreshToken: 'r2' });
      expect((await s.get())?.refreshToken).toBe('r2');
      await s.delete();
      expect(await s.get()).toBeNull();
      await s.delete(); // idempotent
    });
  });
}

contract('memory', () => new MemoryTokenStore());
contract('file', () => new FileTokenStore(join(mkdtempSync(join(tmpdir(), 'qbo-')), 'nested', 'tokens.json')));
contract('sqlite', () => new SqliteTokenStore(new Database(':memory:')));

describe('store specifics', () => {
  it('memory store returns copies', async () => {
    const s = new MemoryTokenStore(sample);
    const t = (await s.get())!;
    t.refreshToken = 'mutated';
    expect((await s.get())?.refreshToken).toBe('r');
  });
  it('file store writes with owner-only permissions', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'qbo-')), 't.json');
    await new FileTokenStore(p).set(sample);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
  it('sqlite keeps tenants apart by key', async () => {
    const db = new Database(':memory:');
    const a = new SqliteTokenStore(db, 'tenant-a');
    const b = new SqliteTokenStore(db, 'tenant-b');
    await a.set(sample);
    expect(await b.get()).toBeNull();
    await b.set({ ...sample, realmId: '999' });
    expect((await a.get())?.realmId).toBe('123');
  });
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  timestamp: new Date().toISOString(), level: 'INFO', category: 'api', action: 'customer.create', success: true, environment: 'sandbox', ...over,
});

describe('audit log', () => {
  it('memory log is newest-first and bounded', () => {
    const log = new MemoryAuditLog(3);
    for (let i = 0; i < 5; i++) log.record(entry({ action: `a${i}` }));
    expect(log.list().map((e) => e.action)).toEqual(['a4', 'a3', 'a2']);
  });
  it('jsonl log persists, tolerates a torn line and a missing file', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'qbo-')), 'audit.jsonl');
    const log = new JsonlAuditLog(p);
    expect(await log.list()).toEqual([]);
    await log.record(entry({ action: 'one' }));
    await log.record(entry({ action: 'two', success: false, error: 'boom' }));
    const { appendFile } = await import('node:fs/promises');
    await appendFile(p, '{"torn":');
    const rows = await log.list();
    expect(rows.map((r) => r.action)).toEqual(['two', 'one']);
  });
  it('summarises health', () => {
    const h = summarizeHealth(
      [
        entry({ timestamp: '2026-01-01T00:00:00Z' }),
        entry({ success: false, category: 'token_refresh', action: 'token.refresh', requiresManualIntervention: true, timestamp: '2026-01-02T00:00:00Z' }),
        entry({ success: false, category: 'connection', action: 'connection.test', timestamp: '2026-01-03T00:00:00Z' }),
        entry({ success: false, action: 'estimate.create', timestamp: '2026-01-04T00:00:00Z' }),
      ],
      1000
    );
    expect(h).toMatchObject({ total: 4, failures: 3, tokenRefreshFailures: 1, connectionFailures: 1, needsManualIntervention: 1, lastSuccessAt: '2026-01-01T00:00:00Z', lastFailureAt: '2026-01-04T00:00:00Z' });
    expect(h.failuresByAction['estimate.create']).toBe(1);
  });
});
