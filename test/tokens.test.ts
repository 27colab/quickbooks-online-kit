import { afterEach, describe, expect, it } from 'vitest';
import { QboReconnectRequiredError, QboNotConnectedError, TokenManager, MemoryTokenStore } from '../src/index.js';
import { connect, makeKit, setup } from './helpers.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

async function expireLocally(store: MemoryTokenStore) {
  const t = (await store.get())!;
  await store.set({ ...t, accessTokenExpiresAt: Date.now() - 1000 });
}

describe('refresh with rotation', () => {
  it('does not refresh while the access token is fresh', async () => {
    const { fake, kit } = await setup();
    closers.push(fake.close);
    await kit.tokens.getAccessToken();
    await kit.tokens.getAccessToken();
    expect(fake.tokenCalls.refresh_token).toBe(0);
  });

  it('refreshes when expired and persists the ROTATED refresh token', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const before = (await store.get())!;
    await expireLocally(store as MemoryTokenStore);
    const t = await kit.tokens.getTokens();
    const after = (await store.get())!;
    expect(fake.tokenCalls.refresh_token).toBe(1);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).toBe(t.accessToken);
    expect(after.realmId).toBe(before.realmId); // realm id survives refresh
    expect(after.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('refreshes slightly early (skew) so a token never dies mid-request', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const t = (await store.get())!;
    await store.set({ ...t, accessTokenExpiresAt: Date.now() + 30_000 }); // inside the 60s skew
    await kit.tokens.getAccessToken();
    expect(fake.tokenCalls.refresh_token).toBe(1);
  });

  it('keeps working across many consecutive rotations', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    for (let i = 0; i < 5; i++) {
      await expireLocally(store as MemoryTokenStore);
      await kit.tokens.getAccessToken();
    }
    expect(fake.tokenCalls.refresh_token).toBe(5);
    expect((await kit.testConnection()).connected).toBe(true);
  });
});

describe('refresh races', () => {
  it('single-flights 25 concurrent callers into ONE refresh request', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    fake.setRefreshDelayMs(40);
    await expireLocally(store as MemoryTokenStore);
    const results = await Promise.all(Array.from({ length: 25 }, () => kit.tokens.getAccessToken()));
    expect(fake.tokenCalls.refresh_token).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('two processes racing on one store both end up with working tokens', async () => {
    // Two independent managers = two "processes" sharing one store, no lock configured.
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const other = makeKit(fake, store);
    fake.setRefreshDelayMs(40);
    await expireLocally(store as MemoryTokenStore);
    const [a, b] = await Promise.all([kit.tokens.getAccessToken(), other.tokens.getAccessToken()]);
    // Both succeed: the loser's invalid_grant is recovered by adopting the winner's stored tokens.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(fake.tokenCalls.refresh_token).toBe(2);
    const t = (await store.get())!;
    expect([a, b]).toContain(t.accessToken);
    // And the stored refresh token is still valid for the next round.
    await expireLocally(store as MemoryTokenStore);
    await expect(kit.tokens.getAccessToken()).resolves.toBeTruthy();
  });

  it('a cross-process lock serialises refreshes so only one hits Intuit', async () => {
    const { fake, store } = await setup();
    closers.push(fake.close);
    let chain: Promise<unknown> = Promise.resolve();
    const lock = <T,>(fn: () => Promise<T>) => {
      const run = chain.then(fn, fn);
      chain = run.catch(() => undefined);
      return run;
    };
    const { createQuickBooks } = await import('../src/index.js');
    const mk = () =>
      createQuickBooks({ clientId: fake.clientId, clientSecret: fake.clientSecret, redirectUri: 'http://x/cb', store, stateSecret: 's', endpoints: fake.endpoints, lock });
    const a = mk();
    const b = mk();
    await expireLocally(store as MemoryTokenStore);
    fake.setRefreshDelayMs(30);
    await Promise.all([a.tokens.getAccessToken(), b.tokens.getAccessToken()]);
    expect(fake.tokenCalls.refresh_token).toBe(1);
  });

  it('a 401 on an old token adopts a newer stored token instead of refreshing again', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const stale = (await store.get())!;
    // Someone else refreshes in the meantime.
    await expireLocally(store as MemoryTokenStore);
    const fresh = await kit.tokens.getTokens();
    const calls = fake.tokenCalls.refresh_token;
    const got = await kit.tokens.getTokens({ force: true, rejectedAccessToken: stale.accessToken });
    expect(got.accessToken).toBe(fresh.accessToken);
    expect(fake.tokenCalls.refresh_token).toBe(calls);
  });
});

describe('failure modes', () => {
  it('revoked authorization -> QboReconnectRequiredError, audited as needing manual intervention', async () => {
    const { fake, kit, store, audit } = await setup();
    closers.push(fake.close);
    fake.revokeAll();
    await expireLocally(store as MemoryTokenStore);
    await expect(kit.tokens.getAccessToken()).rejects.toBeInstanceOf(QboReconnectRequiredError);
    const entry = audit.list().find((e) => e.category === 'token_refresh' && !e.success)!;
    expect(entry.requiresManualIntervention).toBe(true);
    const test = await kit.testConnection();
    expect(test).toMatchObject({ connected: false, needsReconnect: true });
    // tokens are kept (not silently deleted) so an admin can see what happened
    expect(await store.get()).not.toBeNull();
  });

  it('locally expired refresh token short-circuits without calling Intuit', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const t = (await store.get())!;
    await store.set({ ...t, accessTokenExpiresAt: 0, refreshTokenExpiresAt: Date.now() - 1 });
    await expect(kit.tokens.getAccessToken()).rejects.toBeInstanceOf(QboReconnectRequiredError);
    expect(fake.tokenCalls.refresh_token).toBe(0);
    expect(await kit.status()).toMatchObject({ connected: false, needsReconnect: true });
  });

  it('not connected', async () => {
    const { fake, kit } = await setup({ connect: false });
    closers.push(fake.close);
    await expect(kit.tokens.getAccessToken()).rejects.toBeInstanceOf(QboNotConnectedError);
  });

  it('disconnect revokes upstream and clears the store', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    expect(await kit.disconnect()).toEqual({ revoked: true });
    expect(await store.get()).toBeNull();
    expect((await kit.status()).connected).toBe(false);
    // reconnect works afterwards
    await connect(kit, fake);
    expect((await kit.status()).connected).toBe(true);
  });
});

void TokenManager;
