import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless OAuth `state` value: `<nonce>.<issuedAtMs>.<hmac>`.
 * Protects the callback against CSRF without needing a session. Optionally binds a
 * caller-supplied `binding` string (e.g. a user id) into the signature.
 */
export function createState(secret: string, binding = '', now = Date.now()): string {
  const nonce = randomBytes(12).toString('base64url');
  const body = `${nonce}.${now}`;
  return `${body}.${sign(secret, body, binding)}`;
}

export function verifyState(
  secret: string,
  state: string | null | undefined,
  { binding = '', maxAgeMs = 10 * 60 * 1000, now = Date.now() } = {}
): boolean {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issued, mac] = parts as [string, string, string];
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || now - issuedAt > maxAgeMs || issuedAt - now > 60_000) return false;
  const expected = Buffer.from(sign(secret, `${nonce}.${issued}`, binding));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function sign(secret: string, body: string, binding: string): string {
  return createHmac('sha256', secret).update(`${body}|${binding}`).digest('base64url');
}
