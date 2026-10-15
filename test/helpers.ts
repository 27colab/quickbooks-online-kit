import { createQuickBooks, MemoryAuditLog, MemoryTokenStore, type QuickBooksKit, type TokenStore } from '../src/index.js';
import { startFakeQbo, type FakeQbo } from '../src/testing/index.js';

export async function setup(opts: { store?: TokenStore; environment?: 'sandbox' | 'production'; connect?: boolean } = {}) {
  const fake = await startFakeQbo();
  const audit = new MemoryAuditLog();
  const store = opts.store ?? new MemoryTokenStore();
  const kit = makeKit(fake, store, audit, opts.environment);
  if (opts.connect !== false) await connect(kit, fake);
  return { fake, kit, store, audit };
}

export function makeKit(fake: FakeQbo, store: TokenStore, audit = new MemoryAuditLog(), environment: 'sandbox' | 'production' = 'sandbox'): QuickBooksKit {
  return createQuickBooks({
    clientId: fake.clientId,
    clientSecret: fake.clientSecret,
    redirectUri: 'http://localhost:3000/api/quickbooks/callback',
    environment,
    store,
    audit,
    stateSecret: 'test-state-secret',
    endpoints: fake.endpoints,
  });
}

/** Run the whole connect flow against the fake: authorize URL -> consent -> callback. */
export async function connect(kit: QuickBooksKit, fake: FakeQbo) {
  const auth = new URL(kit.connectUrl());
  const cb = new URL('http://localhost:3000/api/quickbooks/callback');
  cb.searchParams.set('code', fake.issueAuthCode());
  cb.searchParams.set('state', auth.searchParams.get('state')!);
  cb.searchParams.set('realmId', fake.realmId);
  await kit.handleCallback(cb.toString());
}
