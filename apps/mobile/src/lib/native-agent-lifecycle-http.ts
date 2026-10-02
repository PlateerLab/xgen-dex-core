import {
  validateCreateAgentSession,
  validateSwitchAgentFocus,
} from '@dex/protocol/agent-session-lifecycle';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { mobileAgentHttpPending } from './native-agent-http-latch';

export interface MobileAgentLifecycleHttpModule {
  newRequestId(): string;
  lifecycleRequest(
    id: string,
    origin: string,
    path: string,
    method: 'POST' | 'PUT',
    accessToken: string,
    dpop: string,
    body: string,
  ): Promise<unknown>;
  cancelRequest(id: string): unknown;
}

export class MobileAgentLifecycleTransportBusy extends Error {
  constructor() { super('Mobile native lifecycle write is still settling'); }
}

export class MobileAgentLifecycleTransportUnavailable extends Error {
  constructor() { super('Mobile Canonical lifecycle bridge is unavailable'); }
}

export class MobileAgentLifecycleResponseInvalid extends Error {
  constructor() { super('Invalid Mobile Canonical lifecycle response'); }
}

export type MobileAgentLifecycleFetch = typeof fetch & { assertAvailable(): void };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_EXACT = new RegExp(`^${UUID}$`);
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const requestIds = new Set<string>();
// Screens and account owners share one native module. Keep only request IDs here, never credentials or bodies.

function fail(): never { throw new NativePlatformTransportError(); }

function nativeFailure(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'mobile_transport_invalid') throw new MobileAgentLifecycleTransportUnavailable();
  if (code === 'mobile_transport_busy') throw new MobileAgentLifecycleTransportBusy();
  if (code === 'mobile_transport_response_invalid') throw new MobileAgentLifecycleResponseInvalid();
  if (error instanceof MobileAgentLifecycleTransportBusy
    || error instanceof MobileAgentLifecycleTransportUnavailable
    || error instanceof MobileAgentLifecycleResponseInvalid) throw error;
  fail();
}

function jwt(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length <= 8192 && JWT.test(value);
}

function exactOrigin(origin: string): void {
  let selected: URL;
  try { selected = new URL(origin); } catch { fail(); }
  if (selected.protocol !== 'https:' || selected.origin !== origin || selected.username || selected.password
    || selected.pathname !== '/' || selected.search || selected.hash) fail();
}

function completeModule(module: MobileAgentLifecycleHttpModule | null): asserts module is MobileAgentLifecycleHttpModule {
  if (!module || typeof module.newRequestId !== 'function' || typeof module.lifecycleRequest !== 'function'
    || typeof module.cancelRequest !== 'function') throw new MobileAgentLifecycleTransportUnavailable();
}

function route(method: string, path: string): 'create' | 'focus' | null {
  if (method === 'POST' && path === '/api/agentflow/agent-sessions') return 'create';
  if (method === 'PUT' && path === '/api/agentflow/me/agent-state') return 'focus';
  return null;
}

function fatalUtf8(value: string): boolean {
  try {
    const bytes = new TextEncoder().encode(value);
    return bytes.byteLength <= MAX_RESPONSE_BYTES
      && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value;
  } catch { return false; }
}

/** System TLS bridge for exact create/focus writes. It never retries or falls back to React Native fetch. */
export function createMobileAgentLifecycleFetch(
  module: MobileAgentLifecycleHttpModule | null,
  origin: string,
): MobileAgentLifecycleFetch {
  exactOrigin(origin);
  completeModule(module);
  const requests = mobileAgentHttpPending(module);
  const assertAvailable = () => {
    if (requests.has(origin)) throw new MobileAgentLifecycleTransportBusy();
  };

  const nativeFetch = (async (input: RequestInfo | URL, supplied?: RequestInit): Promise<Response> => {
    // Capture all mutable caller-owned values before any native or asynchronous boundary.
    let init: RequestInit | undefined;
    try {
      if (supplied) init = {
        method: supplied.method,
        headers: new Headers(supplied.headers),
        body: supplied.body,
        credentials: supplied.credentials,
        redirect: supplied.redirect,
        cache: supplied.cache,
        signal: supplied.signal,
      };
    } catch { fail(); }
    init?.signal?.throwIfAborted();
    if (typeof input !== 'string' || !init || typeof init.method !== 'string' || typeof init.body !== 'string'
      || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') fail();

    let url: URL;
    try { url = new URL(input); } catch { fail(); }
    const path = url.pathname;
    const selectedRoute = route(init.method, path);
    const bodyBytes = new TextEncoder().encode(init.body);
    if (!selectedRoute || url.origin !== origin || url.username || url.password || url.search || url.hash
      || input !== `${origin}${path}` || bodyBytes.byteLength > MAX_REQUEST_BYTES) fail();

    let parsed: unknown;
    try { parsed = JSON.parse(init.body) as unknown; } catch { fail(); }
    try {
      const normalized = selectedRoute === 'create'
        ? validateCreateAgentSession(parsed)
        : validateSwitchAgentFocus(parsed);
      // Equality keeps the protocol client's canonical form and rejects hidden duplicate JSON keys.
      if (JSON.stringify(normalized) !== init.body) fail();
    } catch { fail(); }

    const headers = init.headers as Headers;
    const names: string[] = [];
    headers.forEach((_value, name) => names.push(name));
    const authorization = headers.get('authorization');
    const dpop = headers.get('dpop');
    if (names.sort().join(',') !== 'accept,authorization,content-type,dpop'
      || headers.get('accept') !== 'application/json' || headers.get('content-type') !== 'application/json'
      || !authorization?.startsWith('DPoP ') || !jwt(authorization.slice(5)) || authorization.length > 8197
      || !jwt(dpop)) fail();

    assertAvailable();
    let id: string;
    try { id = module.newRequestId(); } catch (error) { nativeFailure(error); }
    if (typeof id !== 'string' || id.length !== 36 || !UUID_EXACT.test(id) || requestIds.has(id)) fail();
    requestIds.add(id);
    const signal = init.signal;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      try { void Promise.resolve(module.cancelRequest(id)).catch(() => undefined); } catch { /* safe cancellation */ }
    };
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => { cancel(); rejectAbort(signal?.reason ?? new Error('Aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let started = false;
    try {
      signal?.throwIfAborted();
      // A cancelled JS wait does not prove that the OS request stopped. Keep the origin reserved
      // across all read/turn/lifecycle owners until its actual native Promise settles.
      requests.set(origin, id);
      let nativePromise: Promise<unknown>;
      try {
        nativePromise = Promise.resolve(module.lifecycleRequest(
          id, origin, path, init.method as 'POST' | 'PUT', authorization.slice(5), dpop, init.body,
        ));
      } catch (error) { throw error; }
      started = true;
      const settled = () => {
        if (requests.get(origin) === id) requests.delete(origin);
        requestIds.delete(id);
      };
      void nativePromise.then(settled, settled);
      const raw = await Promise.race([nativePromise, aborted]);
      signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MobileAgentLifecycleResponseInvalid();
      const response = raw as Record<string, unknown>;
      if (Object.keys(response).some((key) => !['status', 'body'].includes(key))
        || typeof response.status !== 'number' || !Number.isInteger(response.status)
        || response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400)
        || typeof response.body !== 'string' || !fatalUtf8(response.body)) {
        throw new MobileAgentLifecycleResponseInvalid();
      }
      let used = false;
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        json: async () => {
          signal?.throwIfAborted();
          if (used) throw new MobileAgentLifecycleResponseInvalid();
          used = true;
          try { return JSON.parse(response.body as string) as unknown; }
          catch { throw new MobileAgentLifecycleResponseInvalid(); }
        },
      } as Response;
    } catch (error) {
      signal?.throwIfAborted();
      nativeFailure(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!started) {
        if (requests.get(origin) === id) requests.delete(origin);
        requestIds.delete(id);
      }
    }
  }) as MobileAgentLifecycleFetch;
  nativeFetch.assertAvailable = assertAvailable;
  return nativeFetch;
}
