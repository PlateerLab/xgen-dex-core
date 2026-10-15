import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { PlatformCredentialUnavailable } from '@dex/protocol/agent-session';

export interface MobileAgentSocketModule {
  newSocketId(): string;
  openAgentSocket(id: string, origin: string, sessionId: string, afterSequence: string, accessToken: string, dpop: string): Promise<void>;
  nextAgentSocket(id: string): Promise<unknown>;
  closeAgentSocket(id: string): Promise<void>;
}
export interface MobileAgentSocket { readonly closed: boolean; next(): Promise<unknown>; close(): Promise<void> }
export class MobileSocketInvalid extends Error { constructor() { super('Invalid Mobile event socket'); } }
export class MobileSocketBusy extends Error { constructor() { super('Mobile event socket is still settling'); } }
export class MobileSocketUnavailable extends NativePlatformTransportError {}
export class MobileSocketCursorConflict extends Error { constructor() { super('Mobile event cursor requires recovery'); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const pending = new WeakMap<MobileAgentSocketModule, Map<string, string>>();
function uuid(value: unknown): value is string { return typeof value === 'string' && value.length === 36 && UUID.test(value); }
function jwt(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length <= 8192 && JWT.test(value); }
function failure(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'mobile_socket_authentication' || error instanceof PlatformCredentialUnavailable) throw new PlatformCredentialUnavailable('Mobile event socket authentication failed');
  if (code === 'mobile_socket_cursor_conflict' || error instanceof MobileSocketCursorConflict) throw new MobileSocketCursorConflict();
  if (code === 'mobile_socket_busy' || error instanceof MobileSocketBusy) throw new MobileSocketBusy();
  if (code === 'mobile_socket_invalid' || error instanceof MobileSocketInvalid) throw new MobileSocketInvalid();
  throw new MobileSocketUnavailable();
}
/** Native receive-only WSS. Browser cookies/tickets and the RN WebSocket fallback are unavailable. */
export function createMobileAgentSocketTransport(module: MobileAgentSocketModule | null, origin: string) {
  let url: URL; try { url = new URL(origin); } catch { throw new MobileSocketInvalid(); }
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash) throw new MobileSocketInvalid();
  if (!module || ['newSocketId', 'openAgentSocket', 'nextAgentSocket', 'closeAgentSocket'].some((k) => typeof module[k as keyof MobileAgentSocketModule] !== 'function')) throw new MobileSocketInvalid();
  let active = pending.get(module); if (!active) { active = new Map(); pending.set(module, active); }
  const assertAvailable = () => { if (active.has(origin)) throw new MobileSocketBusy(); };
  return {
    assertAvailable,
    async open(sessionId: string, afterSequence: number, token: string, proof: string, signal: AbortSignal): Promise<MobileAgentSocket> {
      signal.throwIfAborted(); assertAvailable();
      if (!uuid(sessionId) || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !jwt(token) || !jwt(proof)) throw new MobileSocketInvalid();
      let id: string; try { id = module.newSocketId(); } catch (e) { failure(e); }
      if (typeof id !== 'string' || !uuid(id)) throw new MobileSocketInvalid();
      active.set(origin, id); let closed = false; let reading = false; let closing: Promise<void> | null = null;
      let rejectAbort!: (e: unknown) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      // This lifetime cancellation promise may outlive the open wait without an active next call.
      void aborted.catch(() => undefined);
      const close = (): Promise<void> => {
        if (closing) return closing; closed = true;
        closing = Promise.resolve().then(() => module.closeAgentSocket(id)).then(() => {
          if (active.get(origin) === id) active.delete(origin); signal.removeEventListener('abort', onAbort);
        });
        void closing.catch(() => undefined); return closing;
      };
      const onAbort = () => { void close(); rejectAbort(signal.reason ?? new Error('Aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        signal.throwIfAborted();
        await Promise.race([module.openAgentSocket(id, origin, sessionId, String(afterSequence), token, proof), aborted]);
        signal.throwIfAborted(); if (closed) throw new MobileSocketUnavailable();
      } catch (e) { void close(); signal.throwIfAborted(); failure(e); }
      return { get closed() { return closed; }, close,
        async next() {
          signal.throwIfAborted(); if (closed) throw new MobileSocketUnavailable(); if (reading) throw new MobileSocketBusy(); reading = true;
          try {
            const raw = await Promise.race([module.nextAgentSocket(id), aborted]); signal.throwIfAborted();
            if (closed || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MobileSocketInvalid();
            const frame = raw as Record<string, unknown>;
            if (Object.keys(frame).sort().join(',') !== 'text,type' || frame.type !== 'events' || typeof frame.text !== 'string'
              || new TextEncoder().encode(frame.text).length > 1048576) throw new MobileSocketInvalid();
            try { return JSON.parse(frame.text) as unknown; } catch { throw new MobileSocketInvalid(); }
          } catch (e) { void close(); signal.throwIfAborted(); failure(e); }
          finally { reading = false; }
        },
      };
    },
  };
}
