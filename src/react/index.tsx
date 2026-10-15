'use client';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { ConnectionStatus, ConnectionTest } from '../kit.js';

export interface QboConnectionStatusViewProps {
  status: ConnectionStatus | null;
  test: ConnectionTest | null;
  busy?: 'test' | 'disconnect' | 'refresh' | null;
  error?: string | null;
  /** Where the Connect link points. Default `${basePath}/connect` is applied by the container. */
  connectHref: string;
  onTest(): void;
  onDisconnect(): void;
  onRefresh?(): void;
}

const box: CSSProperties = { border: '1px solid #d0d5dd', borderRadius: 8, padding: 16, maxWidth: 480, font: '14px system-ui, sans-serif' };
const btn: CSSProperties = { padding: '6px 12px', marginRight: 8, borderRadius: 6, border: '1px solid #98a2b3', background: '#fff', cursor: 'pointer' };

/** Presentational and unstyled-ish: override via `className` on a wrapper or copy it. */
export function QboConnectionStatusView(p: QboConnectionStatusViewProps) {
  const s = p.status;
  const label = !s ? 'Checking…' : s.needsReconnect ? 'Reconnect required' : s.connected ? 'Connected' : 'Not connected';
  return (
    <section style={box} aria-label="QuickBooks connection" data-testid="qbo-status">
      <h3 style={{ margin: '0 0 8px' }}>
        QuickBooks: <span data-testid="qbo-label">{label}</span>
      </h3>
      {s && (
        <dl style={{ margin: '0 0 12px' }}>
          <dt>Environment</dt>
          <dd data-testid="qbo-env">{s.environment}</dd>
          {s.realmId && (<><dt>Company (realm) id</dt><dd>{s.realmId}</dd></>)}
          {s.refreshTokenExpiresAt && (<><dt>Authorization valid until</dt><dd>{s.refreshTokenExpiresAt}</dd></>)}
        </dl>
      )}
      {s?.environment === 'sandbox' && <p style={{ color: '#b54708' }}>Sandbox environment: no real books are touched.</p>}
      {p.test && (
        <p role="status" data-testid="qbo-test">
          {p.test.connected ? `API check passed${p.test.companyName ? `: ${p.test.companyName}` : ''}` : `API check failed: ${p.test.error ?? 'unknown error'}`}
        </p>
      )}
      {p.error && <p role="alert" style={{ color: '#b42318' }}>{p.error}</p>}
      <div>
        <a href={p.connectHref} style={{ ...btn, textDecoration: 'none', color: 'inherit', display: 'inline-block' }}>
          {s?.connected ? 'Reconnect' : 'Connect'}
        </a>
        <button type="button" style={btn} onClick={p.onTest} disabled={!s?.connected || !!p.busy}>
          {p.busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" style={btn} onClick={p.onDisconnect} disabled={!s?.connected || !!p.busy}>
          {p.busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    </section>
  );
}

export interface QboConnectionStatusProps {
  /** Where the route handlers are mounted. Default `/api/quickbooks`. */
  basePath?: string;
  fetch?: typeof fetch;
}

/** Container: loads status, wires Test and Disconnect to the route handlers. */
export function QboConnectionStatus({ basePath = '/api/quickbooks', fetch: f }: QboConnectionStatusProps) {
  const doFetch = f ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState<'test' | 'disconnect' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, method: 'GET' | 'POST'): Promise<T> => {
      const res = await doFetch(`${basePath}/${path}`, { method, credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
      return body as T;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [basePath]
  );

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<ConnectionStatus>('status', 'GET'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <QboConnectionStatusView
      status={status}
      test={test}
      busy={busy}
      error={error}
      connectHref={`${basePath}/connect`}
      onTest={async () => {
        setBusy('test');
        try {
          setTest(await call<ConnectionTest>('test', 'POST'));
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(null);
        }
      }}
      onDisconnect={async () => {
        if (typeof window !== 'undefined' && !window.confirm('Disconnect QuickBooks? Syncing will stop until you reconnect.')) return;
        setBusy('disconnect');
        try {
          await call('disconnect', 'POST');
          setTest(null);
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(null);
        }
      }}
      onRefresh={refresh}
    />
  );
}
