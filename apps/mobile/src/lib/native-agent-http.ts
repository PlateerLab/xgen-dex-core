import { AgentSessionProtocolError } from '@dex/protocol/agent-session';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';

export interface MobileAgentHttpModule {
  newRequestId(): string;
  readRequest(id: string, origin: string, pathWithQuery: string, accessToken: string, dpop: string): Promise<unknown>;
  cancelRequest(id: string): unknown;
}
export class MobileAgentTransportBusy extends Error { constructor() { super('Mobile native read is still settling'); } }
export class MobileAgentTransportUnavailable extends Error { constructor() { super('Mobile Canonical bridge is unavailable'); } }
export class MobileAgentResponseInvalid extends Error { constructor() { super('Invalid Mobile Canonical response'); } }
export type MobileAgentFetch = typeof fetch & { assertAvailable(): void };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ids = new Set<string>();
// Account/screen owners share the native module. Store only a public request ID, never credentials.
const pending = new WeakMap<MobileAgentHttpModule, Map<string, string>>();
function fail(): never { throw new NativePlatformTransportError(); }
function nativeFailure(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'mobile_transport_invalid') throw new MobileAgentTransportUnavailable();
  if (code === 'mobile_transport_busy') throw new MobileAgentTransportBusy();
  if (code === 'mobile_transport_response_invalid') throw new MobileAgentResponseInvalid();
  if (error instanceof AgentSessionProtocolError || error instanceof MobileAgentResponseInvalid) throw error; fail();
}
function jwt(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length <= 8192 && JWT.test(value); }
function decimal(value: string, min: number, max: number): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}
/** Exact, ordered query strings emitted by AgentSessionReadClient; no arbitrary native GET. */
export function mobileAgentReadPath(value: string): boolean {
  if (value.trim() !== value) return false;
  if (value === '/api/agentflow/me/agent-state' || new RegExp(`^/api/agentflow/agent-sessions/${UUID}/snapshot$`).test(value)) return true;
  const events = new RegExp(`^(?:/api/agentflow/me/agent-events|/api/agentflow/agent-sessions/${UUID}/events)\\?after_sequence=([0-9]+)&limit=([0-9]+)$`).exec(value);
  if (events) return decimal(events[1]!, 0, Number.MAX_SAFE_INTEGER) && decimal(events[2]!, 1, 200);
  const list = new RegExp(`^/api/agentflow/me/agent-sessions\\?limit=([0-9]+)(?:&before_id=${UUID})?$`).exec(value);
  if (list) return decimal(list[1]!, 1, 100);
  const messages = new RegExp(`^/api/agentflow/agent-sessions/${UUID}/messages\\?after_sequence=([0-9]+)&limit=([0-9]+)$`).exec(value);
  return !!messages && decimal(messages[1]!, 0, Number.MAX_SAFE_INTEGER) && decimal(messages[2]!, 1, 20);
}
/** System TLS native bridge only. No cookies, redirects, body, Bearer or fetch fallback. */
export function createMobileAgentFetch(module: MobileAgentHttpModule | null, origin: string): MobileAgentFetch {
  let selected: URL; try { selected = new URL(origin); } catch { fail(); }
  if (selected.protocol !== 'https:' || selected.origin !== origin || selected.username || selected.password || selected.search || selected.hash) fail();
  if (!module || typeof module.newRequestId !== 'function' || typeof module.readRequest !== 'function' || typeof module.cancelRequest !== 'function') throw new MobileAgentTransportUnavailable();
  let requests = pending.get(module); if (!requests) { requests = new Map(); pending.set(module, requests); }
  const assertAvailable = () => { if (requests.has(origin)) throw new MobileAgentTransportBusy(); };
  const nativeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    if (typeof input !== 'string' || !init || init.method !== 'GET' || init.body !== undefined
      || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') fail();
    let url: URL; try { url = new URL(input); } catch { fail(); }
    const path = `${url.pathname}${url.search}`;
    if (url.origin !== selected.origin || url.username || url.password || url.hash || `${origin}${path}` !== input || !mobileAgentReadPath(path)) fail();
    const h = init.headers as Record<string, unknown>;
    if (!h || typeof h !== 'object' || Array.isArray(h) || Object.keys(h).sort().join(',') !== 'Accept,Authorization,DPoP'
      || h.Accept !== 'application/json' || typeof h.Authorization !== 'string' || !h.Authorization.startsWith('DPoP ')
      || !jwt(h.Authorization.slice(5)) || !jwt(h.DPoP)) fail();
    assertAvailable(); let id: string; try { id = module.newRequestId(); } catch (error) { nativeFailure(error); }
    if (typeof id !== 'string' || id.length !== 36 || !new RegExp(`^${UUID}$`).test(id) || ids.has(id)) fail(); ids.add(id);
    const signal = init.signal;
    const cancel = () => { try { void Promise.resolve(module.cancelRequest(id)).catch(() => undefined); } catch { /* safe cancellation */ } };
    let rejectAbort!: (e: unknown) => void; const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { cancel(); rejectAbort(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let started = false;
    try {
      signal?.throwIfAborted();
      // Cancelling the JS wait does not acknowledge OS completion. Keep this origin busy
      // across owners until the actual native Promise settles, preventing accumulated GETs.
      requests.set(origin, id);
      const wire = Promise.resolve(module.readRequest(id, origin, path, h.Authorization.slice(5), h.DPoP)); started = true;
      const settled = () => { if (requests.get(origin) === id) requests.delete(origin); ids.delete(id); };
      void wire.then(settled, settled);
      const raw = await Promise.race([wire, aborted]);
      signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MobileAgentResponseInvalid(); const r = raw as Record<string, unknown>;
      if (Object.keys(r).some((k) => !['status', 'body'].includes(k)) || typeof r.status !== 'number' || !Number.isInteger(r.status)
        || r.status < 200 || r.status > 599 || (r.status >= 300 && r.status < 400) || typeof r.body !== 'string'
        || new TextEncoder().encode(r.body).length > (url.pathname.endsWith('/messages') ? 1048576 : 65536)) throw new MobileAgentResponseInvalid();
      return { status: r.status, ok: r.status >= 200 && r.status < 300,
        json: async () => { signal?.throwIfAborted(); try { return JSON.parse(r.body as string) as unknown; }
          catch { throw new AgentSessionProtocolError('Invalid Mobile Canonical JSON'); } } } as Response;
    } catch (e) {
      signal?.throwIfAborted();
      nativeFailure(e);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!started) { if (requests.get(origin) === id) requests.delete(origin); ids.delete(id); }
    }
  }) as MobileAgentFetch;
  nativeFetch.assertAvailable = assertAvailable; return nativeFetch;
}
