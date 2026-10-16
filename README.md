# @27colab/quickbooks-online-kit

A dependency-free TypeScript toolkit for QuickBooks Online: OAuth2 with refresh-token rotation, pluggable token storage, a typed REST client for common operations, and an audit log.

[![CI](https://github.com/27colab/quickbooks-online-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/quickbooks-online-kit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@27colab/quickbooks-online-kit)](https://www.npmjs.com/package/@27colab/quickbooks-online-kit)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

> **Status: v0.1 reference implementation.** Covered by tests against an in-process fake QuickBooks server. It has **not** been run against a live production QuickBooks company by anyone other than its author, and nothing here claims it is hardened for that. Run it against an Intuit sandbox and judge for yourself. Not affiliated with or endorsed by Intuit.

## Why

- **Refresh-token rotation handled.** Concurrent callers share one refresh, new tokens are persisted before use, and a token another process already rotated is adopted instead of failing (optional `lock` hook for multi-instance setups).
- **Typed, no glue.** Find-or-create customer, estimate → invoice (with a double-invoice guard), payments and more, with parsed `Fault` errors (`QboError`, `intuit_tid`). Zero runtime dependencies.
- **Testable offline.** `startFakeQbo()` fakes Intuit's OAuth and REST endpoints, including fault injection and forced token expiry. 70 tests, no network.

## Install

```bash
npm install @27colab/quickbooks-online-kit
```

Node 20+, ESM, TypeScript types included. `react` is an optional peer dependency, only for the `/react` entry.

## Quickstart

Runs offline against the fake: connect, create a customer and estimate, convert it to an invoice, and see the repeat conversion refused.

```ts
import { createQuickBooks, MemoryTokenStore, QboError } from '@27colab/quickbooks-online-kit';
import { startFakeQbo } from '@27colab/quickbooks-online-kit/testing';

const fake = await startFakeQbo();                   // in-process stand-in for Intuit's OAuth + REST
try {
  const qbo = createQuickBooks({
    clientId: fake.clientId, clientSecret: fake.clientSecret, endpoints: fake.endpoints,
    redirectUri: 'http://localhost:3000/api/quickbooks/callback',
    stateSecret: 'any-long-random-string', store: new MemoryTokenStore(),
  });
  const state = new URL(qbo.connectUrl()).searchParams.get('state')!;
  const cb = new URL('http://localhost:3000/api/quickbooks/callback');
  for (const [k, v] of Object.entries({ code: fake.issueAuthCode(), state, realmId: fake.realmId })) cb.searchParams.set(k, v);
  await qbo.handleCallback(cb.toString());                // connect flow; consent screen played by the fake

  const { client } = qbo;
  const { customer } = await client.findOrCreateCustomer({ givenName: 'Ada', familyName: 'Example', email: 'ada@example.com' });
  fake.db.Item!.push({ Id: '900', Name: 'Consulting', UnitPrice: 150, Type: 'Service', Active: true });
  const item = (await client.buildPriceMap())['Consulting']!;
  const estimate = await client.createEstimate({ customerId: customer.Id, lines: [{ itemId: item.id, qty: 2, unitPrice: item.unitPrice }] });
  const invoice = await client.convertEstimateToInvoice(estimate.Id);
  await client.convertEstimateToInvoice(estimate.Id).catch((e) => console.log('invoice total', invoice.TotalAmt, '| second conversion:', e instanceof QboError ? e.code : e));
} finally {
  await fake.close();
}
```

Output:

```
invoice total 300 | second conversion: ALREADY_INVOICED
```

For real use, drop the fake: pass your Intuit credentials, a real `store` (`FileTokenStore`, `SqliteTokenStore` or your own `TokenStore`) and leave `endpoints` unset. The default environment is **sandbox**; anything other than `production`/`prod` resolves to sandbox.

## Bring your own keys

An Intuit developer account with an app (scope `com.intuit.quickbooks.accounting`): Client ID, Client secret and a Redirect URI that exactly matches the one you configure, plus a long random `stateSecret` for CSRF protection. Production keys require Intuit's own app assessment, which is outside this library.

## API

| Export | Purpose |
|---|---|
| `createQuickBooks(config)` | Wires OAuth, token manager, client and audit from one config; `connectUrl()`, `handleCallback()`, `status()`, `testConnection()`. |
| `QboClient` | Customers, items and price map, estimates, estimate → invoice, sales receipts, payments, raw `request()` / `query()`. |
| `TokenStore` | `MemoryTokenStore`, `FileTokenStore`, `SqliteTokenStore`, or implement `get/set/delete`. |
| `QboError`, `QboReconnectRequiredError` | Parsed Intuit faults; signal to send the admin back to `/connect`. |
| `AuditLog` | `MemoryAuditLog`, `JsonlAuditLog`, `summarizeHealth()`. Tokens and bodies are never recorded. |
| `/next` | `createRouteHandlers`: connect, callback, status, test, disconnect, audit (`authorize` is mandatory). |
| `/react` | `<QboConnectionStatus />` and a presentational view. |
| `/testing` | `startFakeQbo()`. |

Setup walkthrough and full reference: **[docs.27colab.com/integrations/quickbooks-online-kit](https://docs.27colab.com/integrations/quickbooks-online-kit/)**

## Limits

- Accounting scope only: no Payments API, webhooks, reports, attachments, CDC or batch.
- One connection per `createQuickBooks()` instance; create one per tenant with a per-tenant store key.
- Tokens are stored as plain JSON by the built-in stores; add disk encryption or your own encrypting adapter if that matters.
- The fake supports only what this kit uses; passing against it does not prove behaviour against the real API.
- Why not `node-quickbooks` + `intuit-oauth`? They still work and are maintained. This kit trades their breadth for bundled types, promise-based calls, no dependencies and token rotation that is owned and tested here.

## Not for you if…

- You need the long tail of QBO entities, reports, attachments, batch or change data capture. Use `node-quickbooks` or call `client.request()` for what is missing.
- You need the Payments API or webhooks.
- You need something proven against live production books.

## Develop

```bash
npm ci && npm test && npm run typecheck
```

MIT, see [LICENSE](LICENSE).

---

Built by [Jesus Vasquez](https://github.com/vasquezjesus2710) · [27 Colab](https://27colab.com)
