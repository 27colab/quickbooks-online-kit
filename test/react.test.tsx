import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QboConnectionStatusView } from '../src/react/index.js';

const noop = () => {};
const render = (status: any, extra: any = {}) =>
  renderToStaticMarkup(<QboConnectionStatusView status={status} test={null} connectHref="/api/quickbooks/connect" onTest={noop} onDisconnect={noop} {...extra} />);

describe('QboConnectionStatusView', () => {
  it('shows loading, connected, not connected and reconnect states', () => {
    expect(render(null)).toContain('Checking…');
    const connected = render({ connected: true, environment: 'production', realmId: '42', needsReconnect: false });
    expect(connected).toContain('Connected');
    expect(connected).toContain('Reconnect');
    expect(connected).not.toContain('Sandbox environment');
    expect(render({ connected: false, environment: 'sandbox', needsReconnect: false })).toContain('Not connected');
    expect(render({ connected: false, environment: 'sandbox', needsReconnect: true })).toContain('Reconnect required');
  });

  it('warns on sandbox, disables actions when disconnected, and reports test results', () => {
    const html = render({ connected: false, environment: 'sandbox', needsReconnect: false });
    expect(html).toContain('Sandbox environment');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    const ok = render({ connected: true, environment: 'sandbox', needsReconnect: false }, { test: { connected: true, environment: 'sandbox', companyName: 'Acme' } });
    expect(ok).toContain('API check passed: Acme');
    const bad = render({ connected: true, environment: 'sandbox', needsReconnect: false }, { test: { connected: false, environment: 'sandbox', error: 'nope' } });
    expect(bad).toContain('API check failed: nope');
  });

  it('escapes server-provided strings', () => {
    const html = render({ connected: true, environment: 'sandbox', needsReconnect: false }, { error: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
  });
});
