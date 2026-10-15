/** One entry of a QuickBooks `Fault.Error` array. */
export interface QboFaultError {
  message: string;
  detail?: string;
  code?: string;
  element?: string;
}

export class QboError extends Error {
  override name = 'QboError';
  constructor(
    message: string,
    readonly status: number,
    readonly faultType?: string,
    readonly errors: QboFaultError[] = [],
    readonly intuitTid?: string
  ) {
    super(message);
  }
  /** First QBO error code, e.g. "6240" (duplicate name) or "3200" (auth). */
  get code(): string | undefined {
    return this.errors[0]?.code;
  }
  get isAuthError(): boolean {
    return this.status === 401 || this.faultType === 'AUTHENTICATION';
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get isDuplicate(): boolean {
    return this.code === '6240' || this.code === '6140';
  }
}

/** The stored refresh token was rejected; the user must go through Connect again. */
export class QboReconnectRequiredError extends Error {
  override name = 'QboReconnectRequiredError';
  constructor(message = 'QuickBooks authorization expired or was revoked. Reconnect the account.') {
    super(message);
  }
}

export class QboNotConnectedError extends Error {
  override name = 'QboNotConnectedError';
  constructor() {
    super('QuickBooks is not connected. Run the connect flow first.');
  }
}

export class QboOAuthError extends Error {
  override name = 'QboOAuthError';
  constructor(
    message: string,
    readonly status: number,
    readonly oauthError?: string
  ) {
    super(message);
  }
}

/**
 * Parse a QBO error body. QBO answers with `{ Fault: { Error: [...], type }, time }`
 * (JSON, when `Accept: application/json` is sent) but the gateway can also return
 * `{ fault: { error: [{message, detail}], statusCode } }` for auth problems, or plain text/XML.
 */
export function parseFault(
  status: number,
  body: unknown,
  intuitTid?: string
): QboError {
  const fallback = `QuickBooks request failed with HTTP ${status}`;
  if (body && typeof body === 'object') {
    const b = body as Record<string, any>;
    const fault = b.Fault ?? b.fault;
    if (fault && typeof fault === 'object') {
      const raw: any[] = fault.Error ?? fault.error ?? [];
      const errors: QboFaultError[] = raw.map((e) => ({
        message: String(e.Message ?? e.message ?? ''),
        detail: e.Detail ?? e.detail ?? undefined,
        code: e.code != null ? String(e.code) : undefined,
        element: e.element ?? undefined,
      }));
      const first = errors[0];
      const text = first
        ? [first.message, first.detail].filter(Boolean).join(': ')
        : fallback;
      return new QboError(text || fallback, status, fault.type ?? fault.statusCode, errors, intuitTid);
    }
  }
  if (typeof body === 'string' && body.trim()) {
    return new QboError(`${fallback}: ${body.trim().slice(0, 300)}`, status, undefined, [], intuitTid);
  }
  return new QboError(fallback, status, undefined, [], intuitTid);
}
