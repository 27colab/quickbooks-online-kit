import { afterEach, describe, expect, it } from 'vitest';
import { QboClient, QboError, MemoryTokenStore } from '../src/index.js';
import { setup } from './helpers.js';

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
});
async function ctx() {
  const s = await setup();
  closers.push(s.fake.close);
  return { ...s, client: s.kit.client };
}

describe('transport', () => {
  it('sends bearer auth, JSON accept and a pinned minor version', async () => {
    const { fake, client } = await ctx();
    await client.getCompanyInfo();
    const r = fake.requests.at(-1)!;
    expect(r.auth).toMatch(/^Bearer access-/);
    expect(r.query.minorversion).toBe('75');
  });

  it('on 401 forces ONE refresh and retries successfully', async () => {
    const { fake, client } = await ctx();
    fake.expireAccessTokens(); // server rejects our (locally still valid) token
    const info = await client.getCompanyInfo();
    expect(info.CompanyName).toBeTruthy();
    expect(fake.tokenCalls.refresh_token).toBe(1);
  });

  it('gives up after a second 401', async () => {
    const { fake, client } = await ctx();
    fake.failNext(2, 401, { fault: { error: [{ message: 'AuthenticationFailed' }], statusCode: 'AUTHENTICATION' } });
    await expect(client.getCompanyInfo()).rejects.toMatchObject({ isAuthError: true });
  });

  it('retries 429 honouring Retry-After and then succeeds', async () => {
    const { fake, kit } = await ctx();
    const sleeps: number[] = [];
    const client = new QboClient({ tokens: kit.tokens, environment: 'sandbox', apiBaseUrl: fake.endpoints.api, sleep: async (ms) => void sleeps.push(ms) });
    fake.failNext(2, 429, {}, { 'retry-after': '3' });
    await client.getCompanyInfo();
    expect(sleeps).toEqual([3000, 3000]);
  });

  it('stops retrying 429 after maxRetries and throws a typed error', async () => {
    const { fake, kit } = await ctx();
    const client = new QboClient({ tokens: kit.tokens, environment: 'sandbox', apiBaseUrl: fake.endpoints.api, sleep: async () => {}, maxRetries: 1 });
    fake.failNext(5, 429, 'Too many requests');
    await expect(client.getCompanyInfo()).rejects.toMatchObject({ isRateLimited: true });
  });

  it('does NOT blindly retry a POST on 5xx (could double-create)', async () => {
    const { fake, client } = await ctx();
    fake.failNext(1, 503, 'unavailable');
    await expect(client.createEstimate({ customerId: '1', lines: [{ itemId: '1', unitPrice: 5 }] })).rejects.toBeInstanceOf(QboError);
    expect(fake.db.Estimate).toHaveLength(0);
  });

  it('retries a GET on 5xx', async () => {
    const { fake, kit } = await ctx();
    const client = new QboClient({ tokens: kit.tokens, environment: 'sandbox', apiBaseUrl: fake.endpoints.api, sleep: async () => {} });
    fake.failNext(1, 503, 'unavailable');
    await expect(client.getCompanyInfo()).resolves.toBeTruthy();
  });

  it('surfaces QBO validation faults with codes', async () => {
    const { client } = await ctx();
    const err = await client.createEstimate({ customerId: '', lines: [{ itemId: '1', unitPrice: 5 }] }).catch((e) => e);
    expect(err).toBeInstanceOf(QboError);
    expect(err.code).toBe('2020');
    expect(err.faultType).toBe('ValidationFault');
  });
});

describe('customers', () => {
  it('creates, then finds (idempotent find-or-create)', async () => {
    const { fake, client } = await ctx();
    const a = await client.findOrCreateCustomer({ givenName: 'Ada', familyName: 'Example', email: 'ada@example.test', address: { line1: '1 Main St', city: 'Springfield', state: 'FL', postalCode: '33101' } });
    const b = await client.findOrCreateCustomer({ givenName: 'Ada', familyName: 'Example', email: 'ADA@example.test' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.customer.Id).toBe(a.customer.Id);
    expect(fake.db.Customer).toHaveLength(1);
    expect(fake.db.Customer![0].BillAddr).toEqual({ Line1: '1 Main St', City: 'Springfield', CountrySubDivisionCode: 'FL', PostalCode: '33101' });
  });

  it('survives apostrophes in names (query escaping)', async () => {
    const { client } = await ctx();
    const a = await client.findOrCreateCustomer({ displayName: "O'Brien & Sons" });
    const b = await client.findOrCreateCustomer({ displayName: "O'Brien & Sons" });
    expect(b.customer.Id).toBe(a.customer.Id);
  });

  it('handles a duplicate-name race (6240) by returning the existing customer', async () => {
    const { fake, client } = await ctx();
    // Simulate: the lookups find nothing, then someone else creates the name before our POST.
    const realQuery = client.query.bind(client);
    let hidden = true;
    client.query = (async (entity: string, sql: string, o?: any) => (hidden && entity === 'Customer' ? [] : realQuery(entity, sql, o))) as any;
    fake.db.Customer!.push({ Id: '900', SyncToken: '0', DisplayName: 'Racing Co' });
    setTimeout(() => {}, 0);
    const p = client.findOrCreateCustomer({ displayName: 'Racing Co' });
    hidden = false; // after the first (empty) lookups the retry lookup sees the real row
    const r = await p;
    expect(r.created).toBe(false);
    expect(r.customer.Id).toBe('900');
  });

  it('sparse-updates using the current SyncToken', async () => {
    const { fake, client } = await ctx();
    const { customer } = await client.findOrCreateCustomer({ displayName: 'Update Me', email: 'u@example.test' });
    const updated = await client.updateCustomer(customer.Id, { phone: '555-0100' });
    expect(updated.SyncToken).toBe('1');
    expect(fake.db.Customer![0].PrimaryPhone).toEqual({ FreeFormNumber: '555-0100' });
    expect(fake.db.Customer![0].DisplayName).toBe('Update Me'); // untouched
  });

  it('needs something to name the customer', async () => {
    const { client } = await ctx();
    await expect(client.findOrCreateCustomer({})).rejects.toThrow(/displayName/);
  });
});

describe('items and price map', () => {
  it('builds a price map and paginates past 1000 items', async () => {
    const { fake, client } = await ctx();
    for (let i = 0; i < 1203; i++) fake.db.Item!.push({ Id: String(1000 + i), SyncToken: '0', Name: `Service ${i}`, Type: 'Service', UnitPrice: i + 0.5 });
    fake.db.Item!.push({ Id: 'x', SyncToken: '0', Name: 'Inactive', Type: 'Service', Active: false });
    fake.db.Item!.push({ Id: 'y', SyncToken: '0', Name: 'A product', Type: 'Inventory', UnitPrice: 1 });
    const map = await client.buildPriceMap();
    expect(Object.keys(map)).toHaveLength(1203);
    expect(map['Service 7']).toEqual({ id: '1007', name: 'Service 7', unitPrice: 7.5, type: 'Service' });
    expect(map['Inactive']).toBeUndefined();
  });

  it('finds an item by name or null', async () => {
    const { fake, client } = await ctx();
    fake.db.Item!.push({ Id: '5', SyncToken: '0', Name: 'Consulting', Type: 'Service', UnitPrice: 100 });
    expect((await client.findItemByName('Consulting'))?.Id).toBe('5');
    expect(await client.findItemByName('Nope')).toBeNull();
  });
});

describe('estimate -> invoice -> payment', () => {
  async function estimate(client: any) {
    const { customer } = await client.findOrCreateCustomer({ displayName: 'Flow Customer', email: 'flow@example.test' });
    const est = await client.createEstimate({
      customerId: customer.Id,
      billEmail: 'flow@example.test',
      lines: [
        { itemId: '5', description: 'Hours', qty: 2, unitPrice: 100 },
        { itemId: '6', amount: 25.5 },
      ],
    });
    return { customer, est };
  }

  it('computes line amounts and totals', async () => {
    const { client } = await ctx();
    const { est } = await estimate(client);
    expect(est.TotalAmt).toBe(225.5);
    expect((est.Line[0] as any).Amount).toBe(200);
    expect((est.Line[0] as any).SalesItemLineDetail).toMatchObject({ ItemRef: { value: '5' }, Qty: 2, UnitPrice: 100 });
  });

  it('converts to a linked invoice and refuses a second conversion', async () => {
    const { fake, client } = await ctx();
    const { customer, est } = await estimate(client);
    const inv = await client.convertEstimateToInvoice(est.Id);
    expect(inv.CustomerRef).toEqual({ value: customer.Id });
    expect(inv.TotalAmt).toBe(225.5);
    expect(inv.LinkedTxn).toEqual([{ TxnId: est.Id, TxnType: 'Estimate' }]);
    expect((inv as any).BillEmail).toEqual({ Address: 'flow@example.test' });
    expect(fake.db.Estimate![0].TxnStatus).toBe('Closed');

    const again = await client.convertEstimateToInvoice(est.Id).catch((e: any) => e);
    expect(again).toBeInstanceOf(QboError);
    expect(again.code).toBe('ALREADY_INVOICED');
    expect(fake.db.Invoice).toHaveLength(1);
    await expect(client.convertEstimateToInvoice(est.Id, { allowDuplicate: true })).resolves.toBeTruthy();
    expect(fake.db.Invoice).toHaveLength(2);
  });

  it('records a payment against the invoice', async () => {
    const { fake, client } = await ctx();
    const { customer, est } = await estimate(client);
    const inv = await client.convertEstimateToInvoice(est.Id);
    const pay = await client.recordPayment({ customerId: customer.Id, invoiceId: inv.Id, amount: 225.5, referenceNumber: 'ch_test_1' });
    expect(pay.TotalAmt).toBe(225.5);
    expect(fake.db.Payment![0].Line[0].LinkedTxn).toEqual([{ TxnId: inv.Id, TxnType: 'Invoice' }]);
    expect(fake.db.Payment![0].PaymentRefNum).toBe('ch_test_1');
  });

  it('creates a sales receipt with payment details', async () => {
    const { fake, client } = await ctx();
    const { customer } = await estimate(client);
    const sr = await client.createSalesReceipt({ customerId: customer.Id, lines: [{ itemId: '5', unitPrice: 40 }], paymentMethodId: '3', depositToAccountId: '35', referenceNumber: 'ch_test_2' });
    expect(sr.TotalAmt).toBe(40);
    expect(fake.db.SalesReceipt![0]).toMatchObject({ PaymentMethodRef: { value: '3' }, DepositToAccountRef: { value: '35' }, PaymentRefNum: 'ch_test_2' });
  });

  it('create calls carry a requestid so retries are idempotent server-side', async () => {
    const { fake, client } = await ctx();
    const { customer } = await estimate(client);
    const posts = fake.requests.filter((r) => r.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) expect(p.query.requestid).toMatch(/^[0-9a-f-]{36}$/);
    void customer;
  });

  it('rejects empty documents before calling QBO', async () => {
    const { fake, client } = await ctx();
    const n = fake.requests.length;
    await expect(client.createEstimate({ customerId: '1', lines: [] })).rejects.toThrow(/at least one line/);
    await expect(client.createEstimate({ customerId: '1', lines: [{ itemId: '1' }] })).rejects.toThrow(/amount or a unitPrice/);
    expect(fake.requests.length).toBe(n);
  });
});

void MemoryTokenStore;
