import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';

export interface MobileEnrollmentHttpModule {
  newRequestId(): string;
  request(id: string, origin: string, path: string, method: string, token: string, body: string | null): Promise<unknown>;
  cancelRequest(id: string): unknown;
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ALLOWED = new RegExp(`^(?:/api/auth/platform-devices/native/mobile/registration/(?:challenge|complete|status/${UUID})|/api/auth/platform-devices/trust-overview|/api/me/devices/native/mobile/${UUID}/approval-requests(?:/begin)?)$`, 'i');
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const ids = new Set<string>();
function fail(): never { throw new NativePlatformTransportError(); }
/** The OS module owns a dedicated TLS transport. Never route enrollment through RN/global fetch. */
export function createMobileEnrollmentFetch(module: MobileEnrollmentHttpModule | null, origin: string): typeof fetch {
  const selected = new URL(origin);
  if (selected.protocol !== 'https:' || selected.pathname !== '/' || selected.search || selected.hash || selected.username || selected.password) fail();
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    if (!module || typeof input !== 'string' || !init || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') fail();
    const url = new URL(input);
    const path = url.pathname;
    if (url.origin !== selected.origin || url.search || url.hash || url.username || url.password || !ALLOWED.test(path) || `${url.origin}${path}` !== input) fail();
    const read = path === '/api/auth/platform-devices/trust-overview' || path.includes('/registration/status/');
    if (init.method !== (read ? 'GET' : 'POST')) fail();
    const headers = init.headers as Record<string, unknown>;
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).some((k) => !['Accept', 'Authorization', 'Content-Type'].includes(k))
      || headers.Accept !== 'application/json' || typeof headers.Authorization !== 'string' || !headers.Authorization.startsWith('Bearer ') || !TOKEN.test(headers.Authorization.slice(7))) fail();
    const body = init.body === undefined ? null : init.body;
    if (read ? body !== null || headers['Content-Type'] !== undefined : typeof body !== 'string' || headers['Content-Type'] !== 'application/json') fail();
    if (typeof body === 'string') {
      if (new TextEncoder().encode(body).length > 32768) fail();
      try { const value: unknown = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); } catch { fail(); }
    }
    let id: string;
    try { id = module.newRequestId(); } catch { fail(); }
    if (!new RegExp(`^${UUID}$`, 'i').test(id) || ids.has(id)) fail();
    ids.add(id);
    const signal = init.signal;
    const cancel = () => { try { const result = module.cancelRequest(id); void Promise.resolve(result).catch(() => undefined); } catch { /* no raw native error */ } };
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { cancel(); rejectAbort(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      signal?.throwIfAborted();
      const native = module.request(id, selected.origin, path, init.method!, headers.Authorization.slice(7), body as string | null);
      // Cancellation returns promptly even if a native bridge completion arrives late.
      const raw = await Promise.race([native, aborted]);
      signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
      const result = raw as Record<string, unknown>;
      if (Object.keys(result).some((k) => !['status', 'body'].includes(k)) || typeof result.status !== 'number' || !Number.isInteger(result.status)
        || result.status < 200 || result.status > 599 || (result.status >= 300 && result.status < 400) || typeof result.body !== 'string'
        || new TextEncoder().encode(result.body).length > 65536) fail();
      return { status: result.status, ok: result.status >= 200 && result.status < 300,
        json: async () => { signal?.throwIfAborted(); return JSON.parse(result.body as string) as unknown; } } as Response;
    } catch { signal?.throwIfAborted(); fail(); }
    finally { ids.delete(id); signal?.removeEventListener('abort', onAbort); }
  }) as typeof fetch;
}
