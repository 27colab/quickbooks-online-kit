# quickbooks-online-kit

A small, dependency-free TypeScript toolkit for talking to **QuickBooks Online**: OAuth2 connect flow with refresh-token rotation, pluggable token storage, a typed REST client for the handful of operations most small integrations need, an audit log, and optional drop-in Next.js route handlers plus a React "connection status" panel.

> **Status: v0.1, reference implementation.** It was extracted and rewritten from an internal integration and is covered by tests against an in-process fake QuickBooks server. It has **not** been run against a live production QuickBooks company by anyone other than its author, and I make no claim that it is production-hardened. Read the code, run it against an Intuit sandbox, and judge for yourself. Not affiliated with or endorsed by Intuit. Issues are triaged occasionally.

```
npm install @27colab/quickbooks-online-kit
```

Requires Node 20+. Zero runtime dependencies (uses global `fetch` and `node:crypto`). `react` is an optional peer dependency, only for the `/react` entry.

## What's in the box

| Piece | What it does |
|---|---|
| `createQuickBooks()` | Wires everything together from one config object |
| OAuth | Authorize URL, callback parsing, code exchange, refresh, revoke; signed `state` for CSRF protection; realm id captured from the callback |
| `TokenStore` | Tiny interface (`get/set/delete`). Adapters: `MemoryTokenStore`, `FileTokenStore` (atomic, 0600), `SqliteTokenStore` (any `better-sqlite3`/`node:sqlite`-shaped handle, keyed per tenant) |
| `TokenManager` | Single-flight refresh, rotation persisted before use, adopts tokens another process already rotated, optional cross-process `lock` hook |
| `QboClient` | Find-or-create customer, sparse update, items and price map (paginated), estimate, estimate to invoice (with double-invoice guard), sales receipt, record payment, raw `request()`/`query()` |
| Errors | `QboError` with parsed `Fault` (type, codes, detail, `intuit_tid`), `QboReconnectRequiredError`, `QboNotConnectedError` |
| Audit | `AuditLog` interface, memory and JSONL implementations, `summarizeHealth()` |
| `/next` | Web-standard `Request`/`Response` route handlers: connect, callback, status, test, disconnect, audit |
| `/react` | `<QboConnectionStatus />` (connect / test / disconnect) and the presentational `<QboConnectionStatusView />` |
| `/testing` | `startFakeQbo()`: an in-process fake of Intuit's OAuth and the REST endpoints above, for your own tests |

## Setup

### 1. Create an Intuit developer app (sandbox)

1. Sign in at <https://developer.intuit.com> and create an app with the **QuickBooks Online and Payments** scope `com.intuit.quickbooks.accounting`.
2. Under *Keys & credentials → Development*, copy the **Client ID** and **Client secret**.
3. Add a **Redirect URI** that exactly matches the one you pass to the kit, e.g. `http://localhost:3000/api/quickbooks/callback`.
4. A sandbox company is created for you under *Sandbox*. Production keys require completing Intuit's app assessment, which is outside this library.

### 2. Configure

```ts
import { createQuickBooks, FileTokenStore, JsonlAuditLog } from '@27colab/quickbooks-online-kit';

export const qbo = createQuickBooks({
  clientId: process.env.QBO_CLIENT_ID!,
  clientSecret: process.env.QBO_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/api/quickbooks/callback`,
  environment: process.env.QBO_ENVIRONMENT, // 'sandbox' (default) | 'production'
  stateSecret: process.env.QBO_STATE_SECRET!, // any long random string
  store: new FileTokenStore('.data/qbo-tokens.json'),
  audit: new JsonlAuditLog('.data/qbo-audit.jsonl'),
});
```

Anything that is not exactly `production`/`prod` resolves to **sandbox**. Stored tokens remember the environment they were issued for and are ignored if you switch, so sandbox tokens are never sent to production.

### 3. Mount the routes (Next.js App Router)

```ts
// app/api/quickbooks/[action]/route.ts
import { createRouteHandlers } from '@27colab/quickbooks-online-kit/next';
import { qbo } from '@/lib/qbo';

const h = createRouteHandlers({
  kit: qbo,
  authorize: async (req) => isAdmin(req),            // REQUIRED: your session check
  redirectAfterCallback: (r) => (r.ok ? '/admin/quickbooks?connected=1' : `/admin/quickbooks?error=${encodeURIComponent(r.error)}`),
});
export const GET = h.GET;
export const POST = h.POST;
```

| Route | Method | Notes |
|---|---|---|
| `/connect` | GET | Redirects to Intuit's consent screen |
| `/callback` | GET | Intuit redirects here; protected by the signed `state`, not by `authorize` |
| `/status` | GET | Offline: reads the store only |
| `/test` | POST | Live `CompanyInfo` call (refreshes tokens if needed) |
| `/disconnect` | POST | Revokes at Intuit (best effort) and deletes local tokens |
| `/audit` | GET | Health summary and recent audit entries |

`authorize` is mandatory on purpose: these endpoints can connect, disconnect and read your accounting data. POSTs also reject a cross-origin `Origin` header. The handlers never return tokens.

```tsx
// app/admin/quickbooks/page.tsx
import { QboConnectionStatus } from '@/components/qbo'; // re-export from '@27colab/quickbooks-online-kit/react' in a 'use client' file
export default () => <QboConnectionStatus basePath="/api/quickbooks" />;
```

### 4. Use the client

```ts
const { client } = qbo;

const { customer } = await client.findOrCreateCustomer({ givenName: 'Ada', familyName: 'Example', email: 'ada@example.com' });
const prices = await client.buildPriceMap();            // { 'Consulting': { id, unitPrice, ... } }

const estimate = await client.createEstimate({
  customerId: customer.Id,
  lines: [{ itemId: prices['Consulting']!.id, qty: 2, unitPrice: prices['Consulting']!.unitPrice }],
});
const invoice = await client.convertEstimateToInvoice(estimate.Id); // throws ALREADY_INVOICED on a repeat
await client.recordPayment({ customerId: customer.Id, invoiceId: invoice.Id, amount: invoice.TotalAmt });
```

Errors are typed:

```ts
try { await client.createEstimate(...) } catch (e) {
  if (e instanceof QboError) console.log(e.status, e.faultType, e.code, e.errors, e.intuitTid);
  if (e instanceof QboReconnectRequiredError) /* send the admin to /connect */;
}
```

## Design notes

**Token refresh.** Intuit rotates refresh tokens: after a refresh the old one should be discarded. If two requests refresh at once and both use the same old token, one of them loses. The kit (a) coalesces concurrent callers in one process into one refresh, (b) writes the new tokens to the store before returning them, and (c) if Intuit answers `invalid_grant` but the store already holds a different, newer refresh token (another process won), it adopts those instead of failing. For multi-instance deployments add the `lock` option (a Postgres advisory lock, Redis lock, etc.) to avoid the second refresh altogether. These behaviours are tested; see `test/tokens.test.ts`.

**401 handling.** One forced refresh then one retry. 429 and GET 5xx are retried with `Retry-After`/backoff. POSTs are never blindly retried on 5xx, and every create carries a `requestid` so a retry cannot create a duplicate.

**Query safety.** All values interpolated into QBO queries go through `qboQuote`, which escapes `'` and `\`.

**Audit log.** Every client call, token refresh and connection action records action, outcome, duration, HTTP status, `intuit_tid` and QBO ids it touched. Tokens and request bodies are never recorded. `metadata` is yours; keep PII and secrets out of it.

**Token storage.** Tokens are stored as plain JSON. Use disk or volume encryption, or wrap a store with your own encrypting adapter, if that matters for you. Never commit the token file (`.gitignore` already excludes `*.tokens.json`; put yours under a git-ignored directory).

### Why not `node-quickbooks` + `intuit-oauth`?

The original integration used both. They work, and I'm not claiming they're abandoned (`node-quickbooks` was still publishing in 2026). I replaced them because for this use case they were a poor fit:

- callback-based API with no bundled types (the original needed `declare module` stubs), so every call was hand-wrapped in a Promise and typed `any`;
- two packages pulling around 17 direct dependencies (`winston`, `jsonwebtoken`, an old pinned `bluebird`, `underscore`, `oauth-1.0a`, ...) for a handful of REST calls;
- token refresh and rotation handling lived partly outside the library, which is exactly where the races are; owning it made it testable;
- the QBO REST API is simple enough that a `fetch` wrapper is less code than the glue.

If you need the long tail of QBO entities (reports, attachments, batch, CDC, every entity), use those libraries or call `client.request()` here for what's missing.

## Testing your own code

```ts
import { startFakeQbo } from '@27colab/quickbooks-online-kit/testing';

const fake = await startFakeQbo();
const qbo = createQuickBooks({ /* ... */ endpoints: fake.endpoints, clientId: fake.clientId, clientSecret: fake.clientSecret });
fake.failNext(1, 429);        // inject faults
fake.expireAccessTokens();    // force the 401 -> refresh path
```

The fake supports only what this kit uses (a minimal `select * from X where field = 'v'` query dialect, create/sparse-update/read for six entity types). It is deliberately not a full QBO emulator, and passing against it does not prove behaviour against the real API.

## Scope and limitations

- Accounting scope only; no Payments API, webhooks, reports, attachments, CDC or batch.
- One connection per `createQuickBooks()` instance. For multi-tenant apps create one per tenant with a per-tenant store key.
- Fixtures and examples are invented. Minor version is pinned to 75; check Intuit's changelog before relying on newer fields.

## Development

```
npm install
npm test        # vitest, fake QBO server, no network
npm run typecheck
npm run build
```

## License

MIT © 27 Colab LLC
