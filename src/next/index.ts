import type { QuickBooksKit } from '../kit.js';

export interface RouteHandlerOptions {
  kit: QuickBooksKit;
  /**
   * REQUIRED. Return `true` to allow the request (e.g. check your admin session).
   * Applied to every endpoint except `callback`, which is protected by the signed OAuth state.
   * To bind the state to the logged-in admin, return the same binding string from `stateBinding`.
   */
  authorize: (req: Request) => boolean | Promise<boolean>;
  /** Optional per-request binding mixed into the OAuth state signature (e.g. admin user id). */
  stateBinding?: (req: Request) => string | Promise<string>;
  /** Where the callback sends the browser afterwards. Receives the outcome. */
  redirectAfterCallback: (result: { ok: true } | { ok: false; error: string }, req: Request) => string;
}

export type Handler = (req: Request) => Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * Framework-neutral route handlers on the Web `Request`/`Response` API, so they drop
 * straight into Next.js App Router files:
 *
 * ```ts
 * // app/api/quickbooks/[action]/route.ts
 * const h = createRouteHandlers({ kit, authorize, redirectAfterCallback });
 * export const GET = h.GET;
 * export const POST = h.POST;
 * ```
 */
export function createRouteHandlers(opts: RouteHandlerOptions) {
  const { kit } = opts;
  const guard = async (req: Request) => ((await opts.authorize(req)) ? null : json({ error: 'Forbidden' }, 403));
  const binding = async (req: Request) => (opts.stateBinding ? await opts.stateBinding(req) : '');

  const actions: Record<string, { method: 'GET' | 'POST'; run: Handler; public?: boolean }> = {
    /** GET: redirect the admin to Intuit's consent screen. */
    connect: {
      method: 'GET',
      run: async (req) => Response.redirect(kit.connectUrl(await binding(req)), 302),
    },
    /** GET: Intuit redirects here. Authenticated by the signed `state`, not by `authorize`. */
    callback: {
      method: 'GET',
      public: true,
      run: async (req) => {
        try {
          await kit.handleCallback(req.url, await binding(req));
          return Response.redirect(new URL(opts.redirectAfterCallback({ ok: true }, req), req.url).toString(), 302);
        } catch (e) {
          const to = opts.redirectAfterCallback({ ok: false, error: (e as Error).message }, req);
          return Response.redirect(new URL(to, req.url).toString(), 302);
        }
      },
    },
    /** GET: offline connection state. */
    status: { method: 'GET', run: async () => json(await kit.status()) },
    /** POST: live API check (CompanyInfo). */
    test: { method: 'POST', run: async () => json(await kit.testConnection()) },
    /** POST: revoke and forget tokens. */
    disconnect: { method: 'POST', run: async () => json(await kit.disconnect()) },
    /** GET: health summary + recent audit entries. */
    audit: {
      method: 'GET',
      run: async (req) => {
        const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 50, 500);
        return json({
          health: await kit.health(),
          entries: kit.audit.list ? await kit.audit.list({ limit }) : [],
        });
      },
    },
  };

  const dispatch = (method: 'GET' | 'POST') => async (req: Request, ctx?: { params?: any }): Promise<Response> => {
    const params = ctx?.params && typeof ctx.params.then === 'function' ? await ctx.params : ctx?.params;
    const raw = params?.action ?? params?.qbo ?? new URL(req.url).pathname.split('/').pop();
    const name = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    const action = actions[name as string];
    if (!action || action.method !== method) return json({ error: 'Not found' }, 404);
    if (method === 'POST') {
      // Cheap CSRF guard for cookie-authenticated admins: browsers always send Origin on cross-site POSTs.
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: 'Cross-origin request refused' }, 403);
    }
    if (!action.public) {
      const denied = await guard(req);
      if (denied) return denied;
    }
    try {
      return await action.run(req);
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };

  return { GET: dispatch('GET'), POST: dispatch('POST'), actions: Object.keys(actions) };
}
