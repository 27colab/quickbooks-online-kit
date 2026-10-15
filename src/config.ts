import type { QboEnvironment } from './types.js';

export interface Endpoints {
  authorize: string;
  token: string;
  revoke: string;
  api: string;
}

const AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export const DEFAULT_ENDPOINTS: Record<QboEnvironment, Endpoints> = {
  sandbox: {
    authorize: AUTHORIZE,
    token: TOKEN,
    revoke: REVOKE,
    api: 'https://sandbox-quickbooks.api.intuit.com',
  },
  production: {
    authorize: AUTHORIZE,
    token: TOKEN,
    revoke: REVOKE,
    api: 'https://quickbooks.api.intuit.com',
  },
};

/** Intuit scope for the Accounting API. */
export const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';

export function resolveEnvironment(value: string | undefined | null): QboEnvironment {
  const v = (value ?? '').toLowerCase();
  if (v === 'production' || v === 'prod') return 'production';
  return 'sandbox'; // default to the safe one
}
