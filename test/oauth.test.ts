import { afterEach, describe, expect, it } from 'vitest';
import { createQuickBooks, createState, QboOAuth, verifyState } from '../src/index.js';
import { makeKit, setup } from './helpers.js';
import { MemoryTokenStore } from '../src/index.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

describe('authorize URL', () => {
  it('has the Intuit parameters and the accounting scope', () => {
    const oauth = new QboOAuth({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://app.example/cb', environment: 'sandbox' });
    const u = new URL(oauth.authorizeUrl('abc'));
    expect(u.origin + u.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    expect(u.searchParams.get('state')).toBe('abc');
  });

  it('requires credentials', () => {
    expect(() => new QboOAuth({ clientId: '', clientSecret: '', redirectUri: 'x', environment: 'sandbox' })).toThrow(/required/);
  });
});

describe('callback parsing', () => {
  const oauth = new QboOAuth({ clientId: 'c', clientSecret: 's', redirectUri: 'https://a/cb', environment: 'sandbox' });
  it('extracts code, realm and state', () => {
    expect(oauth.parseCallback('https://a/cb?code=C&realmId=R&state=S')).toEqual({ code: 'C', realmId: 'R', state: 'S' });
  });
  it('surfaces access_denied', () => {
    expect(() => oauth.parseCallback('https://a/cb?error=access_denied')).toThrow(/access_denied/);
  });
  it('rejects a missing realm id', () => {
    expect(() => oauth.parseCallback('https://a/cb?code=C&state=S')).toThrow(/realmId/);
  });
});

describe('state (CSRF)', () => {
  it('round-trips and rejects tampering, expiry and wrong binding', () => {
    const s = createState('k', 'admin-1', 1_000);
    expect(verifyState('k', s, { binding: 'admin-1', now: 2_000 })).toBe(true);
    expect(verifyState('other', s, { binding: 'admin-1', now: 2_000 })).toBe(false);
    expect(verifyState('k', s, { binding: 'admin-2', now: 2_000 })).toBe(false);
    expect(verifyState('k', s, { binding: 'admin-1', now: 1_000 + 11 * 60_000 })).toBe(false);
    expect(verifyState('k', s.slice(0, -2) + 'xx', { binding: 'admin-1', now: 2_000 })).toBe(false);
    expect(verifyState('k', null)).toBe(false);
    expect(verifyState('k', 'a.b')).toBe(false);
  });
});

describe('connect flow end to end (fake server)', () => {
  it('stores tokens with realm id and reports status', async () => {
    const { fake, kit, store } = await setup();
    closers.push(fake.close);
    const t = await store.get();
    expect(t?.realmId).toBe(fake.realmId);
    expect(t?.environment).toBe('sandbox');
    expect(t?.refreshTokenExpiresAt).toBeGreaterThan(Date.now());
    const st = await kit.status();
    expect(st).toMatchObject({ connected: true, needsReconnect: false, realmId: fake.realmId, environment: 'sandbox' });
    expect(fake.tokenCalls.authorization_code).toBe(1);
  });

  it('rejects a callback with a forged state and never exchanges the code', async () => {
    const { fake, kit } = await setup({ connect: false });
    closers.push(fake.close);
    const cb = `http://localhost/cb?code=${fake.issueAuthCode()}&state=forged.1.x&realmId=${fake.realmId}`;
    await expect(kit.handleCallback(cb)).rejects.toThrow(/state/);
    expect(fake.tokenCalls.authorization_code).toBe(0);
    expect((await kit.status()).connected).toBe(false);
  });

  it('fails cleanly when the code is bad', async () => {
    const { fake, kit } = await setup({ connect: false });
    closers.push(fake.close);
    const state = new URL(kit.connectUrl()).searchParams.get('state');
    await expect(kit.handleCallback(`http://localhost/cb?code=nope&state=${state}&realmId=1`)).rejects.toThrow(/invalid_grant/);
  });
});

describe('sandbox vs production switch', () => {
  it('uses the right default hosts and defaults to sandbox', async () => {
    const mk = (environment?: string) =>
      createQuickBooks({ clientId: 'a', clientSecret: 'b', redirectUri: 'http://x/cb', store: new MemoryTokenStore(), stateSecret: 's', environment });
    expect(mk().environment).toBe('sandbox');
    expect(mk('weird').environment).toBe('sandbox');
    expect(mk('production').environment).toBe('production');
    expect(mk('production').oauth.endpoints.api).toBe('https://quickbooks.api.intuit.com');
    expect(mk('sandbox').oauth.endpoints.api).toBe('https://sandbox-quickbooks.api.intuit.com');
  });

  it('refuses to use sandbox tokens when configured for production', async () => {
    const { fake, store } = await setup();
    closers.push(fake.close);
    const prod = makeKit(fake, store, undefined, 'production');
    expect(await prod.status()).toMatchObject({ connected: false });
    expect((await prod.testConnection()).connected).toBe(false);
  });
});

