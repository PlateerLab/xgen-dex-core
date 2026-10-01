import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';

export interface MobileSessionHttpModule {
  newRequestId(): string;
  sessionRequest(id: string, origin: string, path: string, method: string, authorization: string | null, dpop: string | null, body: string | null): Promise<unknown>;
  cancelRequest(id: string): unknown;
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const ids = new Set<string>();
function fail(): never { throw new NativePlatformTransportError(); }
function jwt(value: unknown): value is string { return typeof value === 'string' && value.length <= 8192 && JWT.test(value); }
/** Separate from enrollment. Refresh has no Authorization; logout requires its own DPoP credential. */
export function createMobileSessionFetch(module: MobileSessionHttpModule | null, origin: string): typeof fetch {
  const selected = new URL(origin);
  if (selected.protocol !== 'https:' || selected.origin !== origin || selected.username || selected.password || selected.search || selected.hash) fail();
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    if (!module || typeof input !== 'string' || !init || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') fail();
    const url = new URL(input); const path = url.pathname;
    if (url.origin !== selected.origin || url.username || url.password || url.search || url.hash || `${url.origin}${path}` !== input) fail();
    const login = /^\/api\/auth\/platform-sessions\/native\/login-key\/(?:begin|complete)$/.test(path);
    const refresh = /^\/api\/auth\/platform-sessions\/native\/refresh\/(?:begin|complete)$/.test(path);
    const logout = new RegExp(`^/api/me/platform-sessions/${UUID}$`, 'i').test(path);
    if (!(login || refresh || logout) || init.method !== (logout ? 'DELETE' : 'POST')) fail();
    const h = init.headers as Record<string, unknown>;
    if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).some((k) => !['Accept', 'Content-Type', 'Authorization', 'DPoP'].includes(k))
      || h.Accept !== 'application/json' || h['Content-Type'] !== 'application/json') fail();
    if (login ? typeof h.Authorization !== 'string' || !h.Authorization.startsWith('Bearer ') || !TOKEN.test(h.Authorization.slice(7)) || h.DPoP !== undefined
      : refresh ? h.Authorization !== undefined || h.DPoP !== undefined
        : typeof h.Authorization !== 'string' || !h.Authorization.startsWith('DPoP ') || !jwt(h.Authorization.slice(5)) || !jwt(h.DPoP)) fail();
    if (typeof init.body !== 'string' || new TextEncoder().encode(init.body).length > 32768) fail();
    try { const parsed: unknown = JSON.parse(init.body); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(); } catch { fail(); }
    let id: string; try { id = module.newRequestId(); } catch { fail(); }
    if (!new RegExp(`^${UUID}$`, 'i').test(id) || ids.has(id)) fail(); ids.add(id);
    const signal = init.signal;
    const cancel = () => { try { void Promise.resolve(module.cancelRequest(id)).catch(() => undefined); } catch { /* safe cancellation */ } };
    let rejectAbort!: (e: unknown) => void; const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { cancel(); rejectAbort(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const raw = await Promise.race([module.sessionRequest(id, origin, path, init.method!, h.Authorization as string ?? null, h.DPoP as string ?? null, init.body), aborted]);
      signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(); const r = raw as Record<string, unknown>;
      if (Object.keys(r).some((k) => !['status', 'body'].includes(k)) || typeof r.status !== 'number' || !Number.isInteger(r.status)
        || r.status < 200 || r.status > 599 || (r.status >= 300 && r.status < 400) || typeof r.body !== 'string'
        || new TextEncoder().encode(r.body).length > 65536) fail();
      return { status: r.status, ok: r.status >= 200 && r.status < 300,
        json: async () => { signal?.throwIfAborted(); return JSON.parse(r.body as string) as unknown; } } as Response;
    } catch { signal?.throwIfAborted(); fail(); }
    finally { signal?.removeEventListener('abort', onAbort); ids.delete(id); }
  }) as typeof fetch;
}
