import { describe, expect, it } from 'vitest';
import { parseFault, QboError, qboQuote } from '../src/index.js';

describe('parseFault', () => {
  it('parses the standard Fault envelope', () => {
    const e = parseFault(400, {
      Fault: { Error: [{ Message: 'Duplicate Name Exists Error', Detail: 'The name supplied already exists. : Id=58', code: '6240', element: 'DisplayName' }], type: 'ValidationFault' },
      time: '2026-01-01T00:00:00Z',
    }, 'tid-1');
    expect(e).toBeInstanceOf(QboError);
    expect(e.status).toBe(400);
    expect(e.faultType).toBe('ValidationFault');
    expect(e.code).toBe('6240');
    expect(e.isDuplicate).toBe(true);
    expect(e.errors[0]?.element).toBe('DisplayName');
    expect(e.message).toBe('Duplicate Name Exists Error: The name supplied already exists. : Id=58');
    expect(e.intuitTid).toBe('tid-1');
  });

  it('parses multiple errors and keeps them all', () => {
    const e = parseFault(400, { Fault: { Error: [{ Message: 'a', code: '1' }, { Message: 'b', Detail: 'd', code: 2 }], type: 'ValidationFault' } });
    expect(e.errors.map((x) => x.code)).toEqual(['1', '2']);
    expect(e.message).toBe('a');
  });

  it('parses the lowercase gateway auth fault', () => {
    const e = parseFault(401, { fault: { error: [{ message: 'JWT token is invalid', detail: 'Token expired' }], statusCode: 'AUTHENTICATION' } });
    expect(e.isAuthError).toBe(true);
    expect(e.message).toContain('JWT token is invalid');
  });

  it('survives plain text, empty and weird bodies', () => {
    expect(parseFault(502, 'Bad Gateway').message).toContain('Bad Gateway');
    expect(parseFault(500, null).message).toBe('QuickBooks request failed with HTTP 500');
    expect(parseFault(500, { Fault: {} }).message).toBe('QuickBooks request failed with HTTP 500');
    expect(parseFault(500, 42).status).toBe(500);
  });

  it('flags rate limiting', () => {
    expect(parseFault(429, '').isRateLimited).toBe(true);
  });
});

describe('qboQuote', () => {
  it('escapes quotes and backslashes (no query injection)', () => {
    expect(qboQuote("O'Brien")).toBe("'O\\'Brien'");
    expect(qboQuote("x' OR Id != '")).toBe("'x\\' OR Id != \\''");
    expect(qboQuote('a\\b')).toBe("'a\\\\b'");
  });
});
