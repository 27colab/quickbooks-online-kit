import { afterEach, describe, expect, it } from 'vitest';
import { createRouteHandlers } from '../src/next/index.js';
import { setup } from './helpers.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

const base = 'http://localhost:3000/api/quickbooks';
const call = (h: ReturnType<typeof createRouteHandlers>, method: 'GET' | 'POST', action: string, init: RequestInit = {}, qs = '') =>
  h[method](new Request(`${base}/${action}${qs}`, { method, ...init }), { params: Promise.resolve({ action }) });

async function handlers(connect = true, allowed = true) {
  const s = await setup({ connect });
  closers.push(s.fake.close);
  const h = createRouteHandlers({
    kit: s.kit,
    authorize: (req) => allowed && req.headers.get('x-admin') !== 'no',
    redirectAfterCallback: (r) => (r.ok ? '/admin?qbo=connected' : `/admin?qbo=error&message=${encodeURIComponent(r.error)}`),
  });
  return { ...s, h };
}

describe('route handlers', () => {
  it('denies every protected endpoint without authorization', async () => {
    const { h } = await handlers(true, false);
    for (const [m, a] of [['GET', 'connect'], ['GET', 'status'], ['POST', 'test'], ['POST', 'disconnect'], ['GET', 'audit']] as const) {
      expect((await call(h, m, a)).status).toBe(403);
    }
  });

  it('connect redirects to the consent screen with a signed state', async () => {
    const { h, fake } = await handlers(false);
    const res = await call(h, 'GET', 'connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(fake.endpoints.authorize);
    expect(loc.searchParams.get('state')).toMatch(/\./);
  });

  it('full connect -> callback -> status -> test -> disconnect', async () => {
    const { h, fake } = await handlers(false);
    const state = new URL((await call(h, 'GET', 'connect')).headers.get('location')!).searchParams.get('state')!;
    const cb = await call(h, 'GET', 'callback', {}, `?code=${fake.issueAuthCode()}&realmId=${fake.realmId}&state=${state}`);
    expect(cb.headers.get('location')).toBe('http://localhost:3000/admin?qbo=connected');

    const status = await (await call(h, 'GET', 'status')).json();
    expect(status).toMatchObject({ connected: true, realmId: fake.realmId });
    expect(JSON.stringify(status)).not.toMatch(/access-|refresh-/); // no tokens over the wire

    const test = await (await call(h, 'POST', 'test')).json();
    expect(test).toMatchObject({ connected: true, companyName: 'Sandbox Company Inc.' });

    const audit = await (await call(h, 'GET', 'audit')).json();
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/access-|refresh-/);

    expect(await (await call(h, 'POST', 'disconnect')).json()).toEqual({ revoked: true });
    expect((await (await call(h, 'GET', 'status')).json()).connected).toBe(false);
  });

  it('callback works without authorize (state is the credential) but rejects forged state', async () => {
    const { h, fake } = await handlers(false);
    const res = await call(h, 'GET', 'callback', { headers: { 'x-admin': 'no' } }, `?code=${fake.issueAuthCode()}&realmId=1&state=forged`);
    expect(res.headers.get('location')).toContain('qbo=error');
    expect(fake.tokenCalls.authorization_code).toBe(0);
  });

  it('refuses cross-origin POSTs', async () => {
    const { h } = await handlers();
    expect((await call(h, 'POST', 'disconnect', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call(h, 'GET', 'status')).status).toBe(200);
  });

  it('404s unknown actions and wrong methods', async () => {
    const { h } = await handlers();
    expect((await call(h, 'GET', 'nope')).status).toBe(404);
    expect((await call(h, 'GET', 'disconnect')).status).toBe(404);
  });

  it('resolves the action from a catch-all segment array too', async () => {
    const { h } = await handlers();
    const res = await h.GET(new Request(`${base}/status`), { params: { qbo: ['status'] } });
    expect(res.status).toBe(200);
  });
});
