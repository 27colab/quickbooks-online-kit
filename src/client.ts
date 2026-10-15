import { randomUUID } from 'node:crypto';
import { noopAudit, type AuditLog } from './audit.js';
import { DEFAULT_ENDPOINTS } from './config.js';
import { parseFault, QboError } from './errors.js';
import type {
  CompanyInfo, Customer, CustomerInput, DocumentInput, Estimate, Invoice, Item, LineInput,
  Payment, PaymentInput, PriceMap, SalesLine, SalesReceipt, Transaction,
} from './models.js';
import type { TokenManager } from './token-manager.js';
import type { FetchLike, QboEnvironment } from './types.js';

export interface ClientOptions {
  tokens: TokenManager;
  environment: QboEnvironment;
  audit?: AuditLog;
  /** Override the API origin (tests, proxies). */
  apiBaseUrl?: string;
  /** QBO minor version to pin. Default 75. */
  minorVersion?: number;
  fetch?: FetchLike;
  /** Retries for 429 and for 5xx on GET. Default 2. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Escape a value for use inside a single-quoted QBO query literal. */
export function qboQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

type Refs = Record<string, string | undefined>;

export class QboClient {
  private readonly base: string;
  private readonly audit: AuditLog;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.base = opts.apiBaseUrl ?? DEFAULT_ENDPOINTS[opts.environment].api;
    this.audit = opts.audit ?? noopAudit;
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  // ---- low level -------------------------------------------------------

  /**
   * Authenticated request against `/v3/company/{realm}/...`. Handles one forced token
   * refresh on 401, bounded retries on 429/5xx(GET), and parses QBO faults into QboError.
   * `requestId` makes POSTs idempotent across retries.
   */
  async request<T = any>(
    method: 'GET' | 'POST',
    path: string,
    { query, body, requestId }: { query?: Record<string, string>; body?: unknown; requestId?: string } = {}
  ): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 2;
    let tokens = await this.opts.tokens.getTokens();
    let refreshedOn401 = false;
    let attempt = 0;
    for (;;) {
      const url = new URL(`${this.base}/v3/company/${tokens.realmId}/${path}`);
      url.searchParams.set('minorversion', String(this.opts.minorVersion ?? 75));
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
      if (requestId) url.searchParams.set('requestid', requestId);

      const res = await this.fetchFn(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const tid = res.headers.get('intuit_tid') ?? undefined;
      if (res.ok) return (await res.json()) as T;

      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      const error = parseFault(res.status, parsed, tid);

      if (res.status === 401 && !refreshedOn401) {
        refreshedOn401 = true;
        tokens = await this.opts.tokens.getTokens({ force: true, rejectedAccessToken: tokens.accessToken });
        continue;
      }
      const retryable = res.status === 429 || (res.status >= 500 && method === 'GET');
      if (retryable && attempt < maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1);
        await this.sleep(Math.min(wait, 30_000));
        continue;
      }
      throw error;
    }
  }

  /** Run a SELECT. Auto-paginates when `all` is set (QBO caps a page at 1000). */
  async query<T = any>(entity: string, sql: string, { all = false } = {}): Promise<T[]> {
    const pageSize = 1000;
    const out: T[] = [];
    for (let start = 1; ; start += pageSize) {
      const statement = all ? `${sql} STARTPOSITION ${start} MAXRESULTS ${pageSize}` : sql;
      const res = await this.request<{ QueryResponse?: Record<string, T[]> }>('GET', 'query', {
        query: { query: statement },
      });
      const rows = res.QueryResponse?.[entity] ?? [];
      out.push(...rows);
      if (!all || rows.length < pageSize) return out;
    }
  }

  private async create<T>(entity: string, payload: unknown): Promise<T> {
    const res = await this.request<Record<string, T>>('POST', entity.toLowerCase(), {
      body: payload,
      requestId: randomUUID(),
    });
    return res[entity] as T;
  }

  private async read<T>(entity: string, id: string): Promise<T> {
    const res = await this.request<Record<string, T>>('GET', `${entity.toLowerCase()}/${encodeURIComponent(id)}`);
    return res[entity] as T;
  }

  // ---- audit wrapper ---------------------------------------------------

  private async audited<T>(action: string, refs: Refs, fn: () => Promise<T>, refsFrom?: (r: T) => Refs): Promise<T> {
    const started = this.now();
    const base = {
      category: 'api',
      action,
      environment: this.opts.environment,
    } as const;
    try {
      const result = await fn();
      await this.audit.record({
        ...base,
        timestamp: new Date().toISOString(),
        level: 'INFO',
        success: true,
        durationMs: this.now() - started,
        refs: { ...refs, ...(refsFrom?.(result) ?? {}) },
      });
      return result;
    } catch (err) {
      const e = err as Error;
      const qbo = err instanceof QboError ? err : undefined;
      await this.audit.record({
        ...base,
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        success: false,
        durationMs: this.now() - started,
        httpStatus: qbo?.status,
        intuitTid: qbo?.intuitTid,
        refs,
        error: e.message,
        requiresManualIntervention: e.name === 'QboReconnectRequiredError',
      });
      throw err;
    }
  }

  // ---- company ---------------------------------------------------------

  getCompanyInfo(): Promise<CompanyInfo> {
    return this.audited('company.get', {}, async () => {
      const t = await this.opts.tokens.getTokens();
      const res = await this.request<{ CompanyInfo: CompanyInfo }>('GET', `companyinfo/${t.realmId}`);
      return res.CompanyInfo;
    });
  }

  // ---- customers -------------------------------------------------------

  async findCustomerByEmail(email: string): Promise<Customer | null> {
    const rows = await this.query<Customer>(
      'Customer',
      `SELECT * FROM Customer WHERE PrimaryEmailAddr = ${qboQuote(email)}`
    );
    return rows[0] ?? null;
  }

  async findCustomerByDisplayName(name: string): Promise<Customer | null> {
    const rows = await this.query<Customer>(
      'Customer',
      `SELECT * FROM Customer WHERE DisplayName = ${qboQuote(name)}`
    );
    return rows[0] ?? null;
  }

  /**
   * Find by email (when given), else by display name; create when missing. Safe to call
   * repeatedly. If QBO rejects a create as a duplicate name (error 6240, e.g. a race with
   * another writer), the existing customer is returned instead.
   */
  findOrCreateCustomer(input: CustomerInput): Promise<{ customer: Customer; created: boolean }> {
    return this.audited(
      'customer.findOrCreate',
      {},
      async () => {
        const payload = toCustomerPayload(input);
        const found =
          (input.email ? await this.findCustomerByEmail(input.email) : null) ??
          (await this.findCustomerByDisplayName(payload.DisplayName as string));
        if (found) return { customer: found, created: false };
        try {
          return { customer: await this.create<Customer>('Customer', payload), created: true };
        } catch (err) {
          if (err instanceof QboError && err.isDuplicate) {
            const existing = await this.findCustomerByDisplayName(payload.DisplayName as string);
            if (existing) return { customer: existing, created: false };
          }
          throw err;
        }
      },
      (r) => ({ customerId: r.customer.Id })
    );
  }

  /** Sparse update: only the fields in `input` change. */
  updateCustomer(id: string, input: CustomerInput): Promise<Customer> {
    return this.audited(
      'customer.update',
      { customerId: id },
      async () => {
        const existing = await this.read<Customer>('Customer', id);
        const payload = { ...toCustomerPayload(input, false), Id: id, SyncToken: existing.SyncToken, sparse: true };
        return this.create<Customer>('Customer', payload);
      }
    );
  }

  // ---- items / prices --------------------------------------------------

  listItems(type = 'Service'): Promise<Item[]> {
    return this.audited('item.list', {}, () =>
      this.query<Item>('Item', `SELECT * FROM Item WHERE Type = ${qboQuote(type)} AND Active = true`, { all: true })
    );
  }

  async findItemByName(name: string): Promise<Item | null> {
    const rows = await this.query<Item>('Item', `SELECT * FROM Item WHERE Name = ${qboQuote(name)}`);
    return rows[0] ?? null;
  }

  /** `{ [itemName]: { id, name, unitPrice, type } }` for all active items of a type. */
  async buildPriceMap(type = 'Service'): Promise<PriceMap> {
    const map: PriceMap = {};
    for (const item of await this.listItems(type)) {
      map[item.Name] = { id: item.Id, name: item.Name, unitPrice: item.UnitPrice, type: item.Type };
    }
    return map;
  }

  // ---- estimates / invoices / sales receipts ---------------------------

  createEstimate(input: DocumentInput): Promise<Estimate> {
    return this.audited(
      'estimate.create',
      { customerId: input.customerId },
      () => this.create<Estimate>('Estimate', toDocumentPayload(input)),
      (r) => ({ estimateId: r.Id })
    );
  }

  getEstimate(id: string): Promise<Estimate> {
    return this.read<Estimate>('Estimate', id);
  }

  createInvoice(input: DocumentInput): Promise<Invoice> {
    return this.audited(
      'invoice.create',
      { customerId: input.customerId },
      () => this.create<Invoice>('Invoice', toDocumentPayload(input)),
      (r) => ({ invoiceId: r.Id })
    );
  }

  /**
   * Create an invoice from an estimate's lines and link it (`LinkedTxn`). Refuses when the
   * estimate already has a linked invoice, so a retried request cannot double-bill; pass
   * `allowDuplicate: true` to override.
   */
  convertEstimateToInvoice(estimateId: string, { allowDuplicate = false, txnDate }: { allowDuplicate?: boolean; txnDate?: string } = {}): Promise<Invoice> {
    return this.audited(
      'estimate.toInvoice',
      { estimateId },
      async () => {
        const estimate = await this.getEstimate(estimateId);
        const already = estimate.LinkedTxn?.find((t) => t.TxnType === 'Invoice');
        if (already && !allowDuplicate) {
          throw new QboError(`Estimate ${estimateId} was already invoiced (invoice ${already.TxnId})`, 409, 'VALIDATION', [
            { message: 'Estimate already invoiced', detail: already.TxnId, code: 'ALREADY_INVOICED' },
          ]);
        }
        const lines = estimate.Line.filter(
          (l): l is SalesLine => l.DetailType === 'SalesItemLineDetail' && !!(l as SalesLine).SalesItemLineDetail
        ).map(
          (l): SalesLine => ({
            DetailType: 'SalesItemLineDetail',
            Amount: l.Amount,
            Description: l.Description,
            SalesItemLineDetail: {
              ItemRef: l.SalesItemLineDetail.ItemRef,
              Qty: l.SalesItemLineDetail.Qty,
              UnitPrice: l.SalesItemLineDetail.UnitPrice,
              TaxCodeRef: l.SalesItemLineDetail.TaxCodeRef,
            },
          })
        );
        if (lines.length === 0) throw new Error(`Estimate ${estimateId} has no item lines to invoice`);
        const payload = {
          CustomerRef: estimate.CustomerRef,
          TxnDate: txnDate ?? today(),
          Line: lines,
          LinkedTxn: [{ TxnId: estimateId, TxnType: 'Estimate' }],
          ...(estimate.BillEmail ? { BillEmail: estimate.BillEmail } : {}),
        };
        return this.create<Invoice>('Invoice', payload);
      },
      (r) => ({ invoiceId: r.Id })
    );
  }

  createSalesReceipt(input: DocumentInput & { paymentMethodId?: string; depositToAccountId?: string; referenceNumber?: string }): Promise<SalesReceipt> {
    return this.audited(
      'salesReceipt.create',
      { customerId: input.customerId },
      () => {
        const payload: Record<string, unknown> = toDocumentPayload(input);
        if (input.paymentMethodId) payload.PaymentMethodRef = { value: input.paymentMethodId };
        if (input.depositToAccountId) payload.DepositToAccountRef = { value: input.depositToAccountId };
        if (input.referenceNumber) payload.PaymentRefNum = input.referenceNumber;
        return this.create<SalesReceipt>('SalesReceipt', payload);
      },
      (r) => ({ salesReceiptId: r.Id })
    );
  }

  /** Record a payment against one invoice. */
  recordPayment(input: PaymentInput): Promise<Payment> {
    return this.audited(
      'payment.record',
      { customerId: input.customerId, invoiceId: input.invoiceId },
      () => {
        const payload: Record<string, unknown> = {
          CustomerRef: { value: input.customerId },
          TotalAmt: input.amount,
          TxnDate: input.txnDate ?? today(),
          Line: [
            {
              Amount: input.amount,
              LinkedTxn: [{ TxnId: input.invoiceId, TxnType: 'Invoice' }],
            },
          ],
        };
        if (input.paymentMethodId) payload.PaymentMethodRef = { value: input.paymentMethodId };
        if (input.depositToAccountId) payload.DepositToAccountRef = { value: input.depositToAccountId };
        if (input.referenceNumber) payload.PaymentRefNum = input.referenceNumber;
        return this.create<Payment>('Payment', payload);
      },
      (r) => ({ paymentId: r.Id })
    );
  }
}

// ---- payload builders (exported for tests and advanced use) --------------

export function toCustomerPayload(input: CustomerInput, requireName = true): Record<string, unknown> {
  const full = `${input.givenName ?? ''} ${input.familyName ?? ''}`.trim();
  const displayName = input.displayName ?? (full || input.companyName || input.email);
  if (requireName && !displayName) throw new Error('A customer needs a displayName, name, company or email');
  const p: Record<string, unknown> = {};
  if (displayName) p.DisplayName = displayName;
  if (input.email) p.PrimaryEmailAddr = { Address: input.email };
  if (input.phone) p.PrimaryPhone = { FreeFormNumber: input.phone };
  if (input.givenName) p.GivenName = input.givenName;
  if (input.familyName) p.FamilyName = input.familyName;
  if (input.companyName) p.CompanyName = input.companyName;
  const a = input.address;
  if (a && (a.line1 || a.city || a.state || a.postalCode)) {
    p.BillAddr = {
      ...(a.line1 ? { Line1: a.line1 } : {}),
      ...(a.city ? { City: a.city } : {}),
      ...(a.state ? { CountrySubDivisionCode: a.state } : {}),
      ...(a.postalCode ? { PostalCode: a.postalCode } : {}),
    };
  }
  return p;
}

export function toLine(l: LineInput): SalesLine {
  const qty = l.qty ?? 1;
  const amount = l.amount ?? (l.unitPrice !== undefined ? round2(qty * l.unitPrice) : undefined);
  if (amount === undefined) throw new Error(`Line for item ${l.itemId} needs an amount or a unitPrice`);
  return {
    DetailType: 'SalesItemLineDetail',
    Amount: amount,
    ...(l.description ? { Description: l.description } : {}),
    SalesItemLineDetail: {
      ItemRef: { value: l.itemId },
      Qty: qty,
      ...(l.unitPrice !== undefined ? { UnitPrice: l.unitPrice } : {}),
      ...(l.taxCodeId ? { TaxCodeRef: { value: l.taxCodeId } } : {}),
    },
  };
}

export function toDocumentPayload(input: DocumentInput): Record<string, unknown> {
  if (input.lines.length === 0) throw new Error('A document needs at least one line');
  return {
    CustomerRef: { value: input.customerId },
    TxnDate: input.txnDate ?? today(),
    Line: input.lines.map(toLine),
    ...(input.docNumber ? { DocNumber: input.docNumber } : {}),
    ...(input.privateNote ? { PrivateNote: input.privateNote } : {}),
    ...(input.customerMemo ? { CustomerMemo: { value: input.customerMemo } } : {}),
    ...(input.billEmail ? { BillEmail: { Address: input.billEmail } } : {}),
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

export type { Transaction };
