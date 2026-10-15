import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeQboOptions {
  clientId?: string;
  clientSecret?: string;
  /** Access token lifetime handed out, seconds. Default 3600. */
  accessTtlSeconds?: number;
  /** Rotate the refresh token on every refresh (Intuit's real behaviour). Default true. */
  rotateRefreshTokens?: boolean;
  realmId?: string;
}

export interface FakeQbo {
  /** Use as `endpoints: { token, revoke, api }` (and `authorize`) for the kit. */
  endpoints: { authorize: string; token: string; revoke: string; api: string };
  clientId: string;
  clientSecret: string;
  realmId: string;
  /** Mint a code as if the user had approved the consent screen. */
  issueAuthCode(): string;
  /** Stored entities by type name, e.g. `db.Customer`. */
  db: Record<string, any[]>;
  /** Every request seen, in order. */
  requests: Array<{ method: string; path: string; query: Record<string, string>; body: any; auth?: string }>;
  tokenCalls: { authorization_code: number; refresh_token: number };
  /** Make the next N API calls answer with this status/body (e.g. 401, 429, QBO fault). */
  failNext(count: number, status: number, body?: unknown, headers?: Record<string, string>): void;
  /** Make token refresh answer with a delay (to widen race windows). */
  setRefreshDelayMs(ms: number): void;
  /** Invalidate all issued access tokens (server-side expiry/revocation). */
  expireAccessTokens(): void;
  /** Invalidate all refresh tokens (user revoked in Intuit). */
  revokeAll(): void;
  close(): Promise<void>;
}

/** A small in-process QuickBooks Online imitation: OAuth2 + the REST endpoints this kit uses. */
export async function startFakeQbo(options: FakeQboOptions = {}): Promise<FakeQbo> {
  const clientId = options.clientId ?? 'fake-client-id';
  const clientSecret = options.clientSecret ?? 'fake-client-secret';
  const realmId = options.realmId ?? '1000000000000001';
  const ttl = options.accessTtlSeconds ?? 3600;
  const rotate = options.rotateRefreshTokens ?? true;

  let seq = 0;
  const codes = new Set<string>();
  const accessTokens = new Set<string>();
  let validRefresh = new Set<string>();
  let failures: Array<{ status: number; body: unknown; headers: Record<string, string> }> = [];
  let refreshDelay = 0;
  const db: Record<string, any[]> = { Customer: [], Item: [], Estimate: [], Invoice: [], SalesReceipt: [], Payment: [] };
  const requests: FakeQbo['requests'] = [];
  const tokenCalls = { authorization_code: 0, refresh_token: 0 };
  const seenRequestIds = new Map<string, any>();

  const newId = () => String(++seq);
  const mint = (prefix: string) => `${prefix}-${newId()}-${Math.random().toString(36).slice(2, 8)}`;

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', intuit_tid: `tid-${seq}`, ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  const fault = (type: string, message: string, detail: string, code: string) => ({
    Fault: { Error: [{ Message: message, Detail: detail, code }], type },
    time: new Date().toISOString(),
  });

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    if (req.headers.authorization !== `Basic ${basic}`) return send(res, 401, { error: 'invalid_client' });
    const params = new URLSearchParams(await readBody(req));
    const grant = params.get('grant_type');
    if (grant === 'authorization_code') {
      tokenCalls.authorization_code++;
      const code = params.get('code') ?? '';
      if (!codes.delete(code)) return send(res, 400, { error: 'invalid_grant' });
    } else if (grant === 'refresh_token') {
      tokenCalls.refresh_token++;
      if (refreshDelay) await new Promise((r) => setTimeout(r, refreshDelay));
      const rt = params.get('refresh_token') ?? '';
      if (!validRefresh.has(rt)) return send(res, 400, { error: 'invalid_grant' });
      if (rotate) validRefresh.delete(rt); // the old one is dead the moment a new one is issued
    } else {
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    const access = mint('access');
    const refresh = grant === 'refresh_token' && !rotate ? params.get('refresh_token')! : mint('refresh');
    accessTokens.add(access);
    validRefresh.add(refresh);
    send(res, 200, {
      token_type: 'bearer',
      access_token: access,
      refresh_token: refresh,
      expires_in: ttl,
      x_refresh_token_expires_in: 8726400,
    });
  }

  function runQuery(sql: string) {
    const m = /^select \* from (\w+)(?: where (.+?))?(?: startposition (\d+))?(?: maxresults (\d+))?$/i.exec(sql.trim());
    if (!m) return { error: 'unparseable' };
    const entity = m[1]!;
    const conds = (m[2] ?? '').split(/ and /i).filter(Boolean);
    let rows = (db[entity] ?? []).slice();
    for (const c of conds) {
      const cm = /^(\w+) = (?:'((?:\\.|[^'\\])*)'|(true|false))$/i.exec(c.trim());
      if (!cm) return { error: `unsupported condition: ${c}` };
      const field = cm[1]!;
      const val = cm[2] !== undefined ? cm[2].replace(/\\(.)/g, '$1') : cm[3] === 'true';
      rows = rows.filter((r) => {
        const actual = field === 'PrimaryEmailAddr' ? r.PrimaryEmailAddr?.Address : r[field];
        if (field === 'Active') return (r.Active ?? true) === val;
        return typeof val === 'string' && typeof actual === 'string' ? actual.toLowerCase() === val.toLowerCase() : actual === val;
      });
    }
    const start = Number(m[3] ?? 1);
    const max = Number(m[4] ?? 100);
    rows = rows.slice(start - 1, start - 1 + max);
    return { rows, entity };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const raw = await readBody(req);
    const query = Object.fromEntries(url.searchParams);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, path: url.pathname, query, body, auth: req.headers.authorization });

    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const pre = failures.shift();
    if (pre) return send(res, pre.status, pre.body ?? {}, pre.headers);
    if (!accessTokens.has(bearer)) {
      return send(res, 401, fault('AUTHENTICATION', 'message=AuthenticationFailed; errorCode=003200; statusCode=401', 'Token expired', '3200'));
    }
    const m = new RegExp(`^/v3/company/${realmId}/(\\w+)(?:/(\\w+))?$`).exec(url.pathname);
    if (!m) return send(res, 404, fault('SYSTEM', 'Not found', url.pathname, '404'));
    const [, resource, id] = m as unknown as [string, string, string | undefined];

    if (resource === 'companyinfo') {
      return send(res, 200, { CompanyInfo: { Id: realmId, SyncToken: '0', CompanyName: 'Sandbox Company Inc.', Country: 'US' }, time: 'now' });
    }
    if (resource === 'query') {
      const r = runQuery(query.query ?? '');
      if ('error' in r) return send(res, 400, fault('ValidationFault', 'Invalid query', String(r.error), '4000'));
      return send(res, 200, { QueryResponse: { [r.entity]: r.rows, maxResults: r.rows.length }, time: 'now' });
    }
    const entity = ({ customer: 'Customer', item: 'Item', estimate: 'Estimate', invoice: 'Invoice', salesreceipt: 'SalesReceipt', payment: 'Payment' } as Record<string, string>)[resource];
    if (!entity) return send(res, 404, fault('SYSTEM', 'Unknown resource', resource, '404'));

    if (req.method === 'GET') {
      const row = db[entity]!.find((r) => r.Id === id);
      return row ? send(res, 200, { [entity]: row, time: 'now' }) : send(res, 400, fault('ValidationFault', 'Object Not Found', `Object Not Found : Something you're trying to use has been made inactive. Id=${id}`, '610'));
    }

    // POST = create, or update when Id present
    const rid = query.requestid;
    if (rid && seenRequestIds.has(rid)) return send(res, 200, { [entity]: seenRequestIds.get(rid), time: 'now' });
    if (body.Id) {
      const row = db[entity]!.find((r) => r.Id === body.Id);
      if (!row) return send(res, 400, fault('ValidationFault', 'Object Not Found', `Id=${body.Id}`, '610'));
      if (row.SyncToken !== body.SyncToken) return send(res, 400, fault('ValidationFault', 'Stale Object Error', 'SyncToken mismatch', '5010'));
      Object.assign(row, body, { SyncToken: String(Number(row.SyncToken) + 1) });
      return send(res, 200, { [entity]: row, time: 'now' });
    }
    if (entity === 'Customer') {
      const dup = db.Customer!.find((c) => c.DisplayName.toLowerCase() === String(body.DisplayName).toLowerCase());
      if (dup) {
        return send(res, 400, fault('ValidationFault', 'Duplicate Name Exists Error', `The name supplied already exists. : Id=${dup.Id}`, '6240'));
      }
    }
    if (entity === 'Invoice' || entity === 'Estimate' || entity === 'SalesReceipt') {
      if (!body.CustomerRef?.value) return send(res, 400, fault('ValidationFault', 'Invalid Reference Id', 'CustomerRef is required', '2020'));
      body.TotalAmt = (body.Line ?? []).reduce((s: number, l: any) => s + (l.Amount ?? 0), 0);
    }
    const row = { ...body, Id: newId(), SyncToken: '0', domain: 'QBO', sparse: false };
    db[entity]!.push(row);
    if (entity === 'Invoice') {
      for (const lt of body.LinkedTxn ?? []) {
        const est = db.Estimate!.find((e) => e.Id === lt.TxnId);
        if (est) {
          est.LinkedTxn = [...(est.LinkedTxn ?? []), { TxnId: row.Id, TxnType: 'Invoice' }];
          est.TxnStatus = 'Closed';
        }
      }
    }
    if (rid) seenRequestIds.set(rid, row);
    return send(res, 200, { [entity]: row, time: 'now' });
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/oauth2/v1/tokens/bearer') return await handleToken(req, res);
      if (url.pathname === '/oauth2/tokens/revoke') {
        const b = JSON.parse((await readBody(req)) || '{}');
        validRefresh.delete(b.token);
        return send(res, 200, {});
      }
      if (url.pathname.startsWith('/v3/company/')) return await handleApi(req, res, url);
      send(res, 404, {});
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: {
      authorize: `${origin}/connect/oauth2`,
      token: `${origin}/oauth2/v1/tokens/bearer`,
      revoke: `${origin}/oauth2/tokens/revoke`,
      api: origin,
    },
    clientId,
    clientSecret,
    realmId,
    issueAuthCode() {
      const c = mint('code');
      codes.add(c);
      return c;
    },
    db,
    requests,
    tokenCalls,
    failNext(count, status, body, headers = {}) {
      for (let i = 0; i < count; i++) failures.push({ status, body, headers });
    },
    setRefreshDelayMs(ms) {
      refreshDelay = ms;
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    revokeAll() {
      validRefresh = new Set();
      accessTokens.clear();
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
