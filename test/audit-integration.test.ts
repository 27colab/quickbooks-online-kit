import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});

describe('audit of client calls', () => {
  it('records successes with ids and failures with status/tid, and never leaks tokens', async () => {
    const { fake, kit, audit } = await setup();
    closers.push(fake.close);
    const { customer } = await kit.client.findOrCreateCustomer({ displayName: 'Audit Me' });
    await kit.client.createEstimate({ customerId: '', lines: [{ itemId: '1', unitPrice: 1 }] }).catch(() => {});
    const rows = await audit.list();
    const ok = rows.find((r) => r.action === 'customer.findOrCreate')!;
    expect(ok).toMatchObject({ success: true, category: 'api', environment: 'sandbox', refs: { customerId: customer.Id } });
    const bad = rows.find((r) => r.action === 'estimate.create')!;
    expect(bad).toMatchObject({ success: false, level: 'ERROR', httpStatus: 400 });
    expect(bad.intuitTid).toMatch(/^tid-/);
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/access-|refresh-|Bearer/);
    const health = await kit.health();
    expect(health?.failures).toBe(1);
  });
});
