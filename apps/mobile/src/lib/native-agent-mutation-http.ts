import { validateStopAgentTurn, validateSubmitAgentTurn } from '@dex/protocol/agent-session-mutation';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { mobileAgentHttpPending } from './native-agent-http-latch';

export interface MobileAgentMutationHttpModule {
  newRequestId(): string;
  newTurnKey(): string;
  turnRequest(
    id: string,
    origin: string,
    path: string,
    accessToken: string,
    dpop: string,
    body: string,
  ): Promise<unknown>;
  cancelRequest(id: string): unknown;
}

export class MobileAgentMutationTransportBusy extends Error {
  constructor() { super('Mobile native mutation is still settling'); }
}

export class MobileAgentMutationTransportUnavailable extends Error {
  constructor() { super('Mobile Canonical mutation bridge is unavailable'); }
}

export class MobileAgentMutationResponseInvalid extends Error {
  constructor() { super('Invalid Mobile Canonical mutation response'); }
}

export type MobileAgentMutationFetch = typeof fetch & { assertAvailable(): void };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_EXACT = new RegExp(`^${UUID}$`);
const TURN_PATH = new RegExp(`^/api/agentflow/agent-sessions/(${UUID})/(turns|stop)$`);
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const requestIds = new Set<string>();
// Screens and account owners share one native module. Keep only request IDs here, never credentials or bodies.

function fail(): never { throw new NativePlatformTransportError(); }

function nativeFailure(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'mobile_transport_invalid') throw new MobileAgentMutationTransportUnavailable();
  if (code === 'mobile_transport_busy') throw new MobileAgentMutationTransportBusy();
  if (code === 'mobile_transport_response_invalid') throw new MobileAgentMutationResponseInvalid();
  if (error instanceof MobileAgentMutationTransportBusy
    || error instanceof MobileAgentMutationTransportUnavailable
    || error instanceof MobileAgentMutationResponseInvalid) throw error;
  fail();
}

function jwt(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length <= 8192 && JWT.test(value);
}

function exactOrigin(origin: string): URL {
  let selected: URL;
  try { selected = new URL(origin); } catch { fail(); }
  if (selected.protocol !== 'https:' || selected.origin !== origin || selected.username || selected.password
    || selected.pathname !== '/' || selected.search || selected.hash) fail();
  return selected;
}

function completeModule(module: MobileAgentMutationHttpModule | null): asserts module is MobileAgentMutationHttpModule {
  if (!module || typeof module.newRequestId !== 'function' || typeof module.newTurnKey !== 'function'
    || typeof module.turnRequest !== 'function' || typeof module.cancelRequest !== 'function') {
    throw new MobileAgentMutationTransportUnavailable();
  }
}

/** Generate a native UUID for one new logical turn. A retry keeps the key already stored by its composer. */
export function createMobileTurnKey(module: MobileAgentMutationHttpModule | null): string {
  completeModule(module);
  let key: unknown;
  try { key = module.newTurnKey(); } catch (error) { nativeFailure(error); }
  if (typeof key !== 'string' || key.length !== 36 || !UUID_EXACT.test(key)) fail();
  return key;
}

/** System TLS bridge for exact turn submit/stop POSTs. It never falls back to React Native fetch. */
export function createMobileAgentMutationFetch(
  module: MobileAgentMutationHttpModule | null,
  origin: string,
): MobileAgentMutationFetch {
  exactOrigin(origin);
  completeModule(module);
  const requests = mobileAgentHttpPending(module);
  const assertAvailable = () => { if (requests.has(origin)) throw new MobileAgentMutationTransportBusy(); };

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
    if (typeof input !== 'string' || !init || init.method !== 'POST' || typeof init.body !== 'string'
      || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') fail();

    let url: URL;
    try { url = new URL(input); } catch { fail(); }
    const path = url.pathname;
    const route = TURN_PATH.exec(path);
    if (!route || url.origin !== origin || url.username || url.password || url.search || url.hash
      || input !== `${origin}${path}` || new TextEncoder().encode(init.body).length > 2 * 1024 * 1024) fail();

    let parsed: unknown;
    try { parsed = JSON.parse(init.body) as unknown; } catch { fail(); }
    try {
      const normalized = route[2] === 'turns'
        ? validateSubmitAgentTurn(route[1]!, parsed)
        : validateStopAgentTurn(route[1]!, parsed);
      // The protocol client emits this stable form. Equality also prevents duplicate object keys
      // from being hidden by JSON.parse while the exact original body is retained for retries.
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
      // across all owners until its actual native Promise settles.
      requests.set(origin, id);
      let nativePromise: Promise<unknown>;
      try { nativePromise = Promise.resolve(module.turnRequest(id, origin, path, authorization.slice(5), dpop, init.body)); }
      catch (error) { throw error; }
      started = true;
      const settled = () => {
        if (requests.get(origin) === id) requests.delete(origin);
        requestIds.delete(id);
      };
      void nativePromise.then(settled, settled);
      const raw = await Promise.race([nativePromise, aborted]);
      signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MobileAgentMutationResponseInvalid();
      const response = raw as Record<string, unknown>;
      if (Object.keys(response).some((key) => !['status', 'body'].includes(key))
        || typeof response.status !== 'number' || !Number.isInteger(response.status)
        || response.status < 200 || response.status > 599 || (response.status >= 300 && response.status < 400)
        || typeof response.body !== 'string' || new TextEncoder().encode(response.body).length > 65536) {
        throw new MobileAgentMutationResponseInvalid();
      }
      let used = false;
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        json: async () => {
          signal?.throwIfAborted();
          if (used) throw new MobileAgentMutationResponseInvalid();
          used = true;
          try { return JSON.parse(response.body as string) as unknown; }
          catch { throw new MobileAgentMutationResponseInvalid(); }
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
  }) as MobileAgentMutationFetch;
  nativeFetch.assertAvailable = assertAvailable;
  return nativeFetch;
}
