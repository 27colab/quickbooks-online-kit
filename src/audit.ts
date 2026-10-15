import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { QboEnvironment } from './types.js';

export type AuditLevel = 'INFO' | 'WARNING' | 'ERROR';

/** Free-form: the client uses `api`, `oauth`, `token_refresh`, `connection`; add your own. */
export type AuditCategory = string;

export interface AuditEntry {
  timestamp: string;
  level: AuditLevel;
  category: AuditCategory;
  /** e.g. `customer.create`, `estimate.toInvoice`, `token.refresh`. */
  action: string;
  success: boolean;
  environment: QboEnvironment;
  durationMs?: number;
  httpStatus?: number;
  intuitTid?: string;
  /** QBO ids touched by the call, e.g. `{ customerId, estimateId, invoiceId }`. Never tokens. */
  refs?: Record<string, string | undefined>;
  error?: string;
  /** Set when retrying will not help (e.g. refresh token revoked). */
  requiresManualIntervention?: boolean;
  /** Caller-supplied context (e.g. your own order id). Do not put PII or secrets here. */
  metadata?: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: AuditEntry): void | Promise<void>;
  /** Newest first. Optional so write-only sinks (e.g. a logger) are valid. */
  list?(options?: { limit?: number; since?: number }): Promise<AuditEntry[]> | AuditEntry[];
}

export class MemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];
  constructor(private readonly capacity = 1000) {}
  record(entry: AuditEntry) {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
  }
  list({ limit = 100, since = 0 } = {}) {
    return this.entries
      .filter((e) => Date.parse(e.timestamp) >= since)
      .slice()
      .reverse()
      .slice(0, limit);
  }
}

/** Append-only JSON Lines file. */
export class JsonlAuditLog implements AuditLog {
  constructor(private readonly path: string) {}
  async record(entry: AuditEntry) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + '\n');
  }
  async list({ limit = 100, since = 0 } = {}) {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    const out: AuditEntry[] = [];
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (Date.parse(e.timestamp) >= since) out.push(e);
      } catch {
        /* skip a torn line */
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}

export const noopAudit: AuditLog = { record() {} };

export interface HealthSummary {
  windowMs: number;
  total: number;
  failures: number;
  tokenRefreshFailures: number;
  connectionFailures: number;
  needsManualIntervention: number;
  failuresByAction: Record<string, number>;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

/** Pure summary over audit entries (newest-first or any order). */
export function summarizeHealth(entries: AuditEntry[], windowMs: number): HealthSummary {
  const s: HealthSummary = {
    windowMs,
    total: entries.length,
    failures: 0,
    tokenRefreshFailures: 0,
    connectionFailures: 0,
    needsManualIntervention: 0,
    failuresByAction: {},
  };
  for (const e of entries) {
    if (e.success) {
      if (!s.lastSuccessAt || e.timestamp > s.lastSuccessAt) s.lastSuccessAt = e.timestamp;
      continue;
    }
    s.failures++;
    s.failuresByAction[e.action] = (s.failuresByAction[e.action] ?? 0) + 1;
    if (e.category === 'token_refresh') s.tokenRefreshFailures++;
    if (e.category === 'connection') s.connectionFailures++;
    if (e.requiresManualIntervention) s.needsManualIntervention++;
    if (!s.lastFailureAt || e.timestamp > s.lastFailureAt) s.lastFailureAt = e.timestamp;
  }
  return s;
}
