import { sha256 } from 'js-sha256';
import { AgentSessionReadClient, PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import { reconcileAgentFocus, type ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { reconcileAgentConversation, type ScopedAgentConversation } from '@dex/protocol/agent-session-conversation-recovery';
import { NativeAccountChanged, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileDeviceIdentity } from './native-device-key';
import type { createMobileSessionVault } from './native-session-vault';
import type { MobileAgentFetch } from './native-agent-http';
import type { MobileAgentSocket } from './native-agent-socket';
import { MobileSocketInvalid, type createMobileAgentSocketTransport } from './native-agent-socket';

export class MobileFocusBusy extends Error { constructor() { super('Mobile Canonical read is still settling'); } }
/** A source owns one login lifetime. Its callback-scoped credentials cannot escape the vault lock. */
export function createMobileAgentFocusSource(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  vault: ReturnType<typeof createMobileSessionVault>; fetch: typeof fetch & Partial<Pick<MobileAgentFetch, 'assertAvailable'>>;
  socket?: ReturnType<typeof createMobileAgentSocketTransport>;
}) {
  const initial = options.current(); if (!initial) throw new NativeAccountChanged();
  const authority = { origin: initial.origin, userId: initial.userId, authScope: initial.authScope };
  let closed = false; let active: AbortController | null = null;
  const sockets = new Map<MobileAgentSocket, { scope: string; generation: string }>();
  const closeSockets = () => { for (const socket of sockets.keys()) void socket.close().catch(() => undefined); sockets.clear(); };
  async function read<T>(work: (reader: AgentSessionReadClient, scope: string, signal: AbortSignal,
    open: (sessionId: string, after: number) => Promise<MobileAgentSocket>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (active) throw new MobileFocusBusy();
    const controller = new AbortController(); active = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const check = () => {
      controller.signal.throwIfAborted(); const actual = options.current();
      if (closed || !actual || actual.origin !== authority.origin || actual.userId !== authority.userId || actual.authScope !== authority.authScope) throw new NativeAccountChanged();
    };
    try {
      check(); options.fetch.assertAvailable?.();
      const identity = await options.keys.identity(false, controller.signal); check();
      return await options.vault.withIdentity(authority, identity, check, async (vault) => {
        let record = await vault.read(); check(); let live = true;
        const credential = () => {
          check(); if (!live || !record || record.phase !== 'ready' || !record.accessToken || !record.accessExpiresAt
            || Math.floor(Date.parse(record.accessExpiresAt) / 1000) * 1000 <= Date.now() + 1000) {
            throw new PlatformCredentialUnavailable('Active Mobile Platform Session required');
          }
          return record.accessToken;
        };
        try {
          credential();
          // Refresh generation/token is intentionally absent; a rotated token on the same sid retains the cursor.
          const scope = sha256(JSON.stringify(['mobile-focus-v1', authority.origin, authority.userId, authority.authScope,
            identity.installId, record!.deviceId, record!.sessionId, record!.keyThumbprint]));
          for (const [socket, binding] of sockets) {
            if (socket.closed || binding.scope !== scope || binding.generation !== record!.generation) {
              void socket.close().catch(() => undefined); sockets.delete(socket);
            }
          }
          const reader = new AgentSessionReadClient(authority.origin, {
            accessToken: async () => credential(),
            signProof: async (method, htu, token) => {
              if (credential() !== token || !identity.signDpop) throw new NativePlatformTransportError();
              const proof = await identity.signDpop(method, htu, token, controller.signal); credential(); return proof;
            },
          }, async (input, init) => {
            credential(); const response = await options.fetch(input, init); credential();
            return { status: response.status, ok: response.ok, json: async () => { credential(); const result = await response.json(); credential(); return result; } } as Response;
          });
          const open = async (sessionId: string, after: number) => {
            if (!options.socket || !identity.signDpop) throw new MobileSocketInvalid();
            const token = credential(); const proof = await identity.signDpop('GET', `${authority.origin}/api/agentflow/agent-sessions/${sessionId}/events`, token, controller.signal);
            credential(); const connection = new AbortController(); const stop = () => connection.abort();
            controller.signal.addEventListener('abort', stop, { once: true }); signal?.addEventListener('abort', stop, { once: true });
            const cleanup = () => { controller.signal.removeEventListener('abort', stop); signal?.removeEventListener('abort', stop); };
            if (controller.signal.aborted || signal?.aborted) stop();
            let socket: MobileAgentSocket;
            try { socket = await options.socket.open(sessionId, after, token, proof, connection.signal); }
            catch (e) { cleanup(); throw e; }
            const wrapped: MobileAgentSocket = { get closed() { return socket.closed; }, close: () => socket.close().finally(cleanup),
              next: async () => {
                const accountCheck = () => { const actual = options.current();
                  if (closed || !actual || actual.origin !== authority.origin || actual.userId !== authority.userId || actual.authScope !== authority.authScope) throw new NativeAccountChanged(); };
                accountCheck(); const frame = await socket.next(); accountCheck(); return frame;
              } };
            try { credential(); } catch (e) { void wrapped.close().catch(() => undefined); throw e; }
            sockets.set(wrapped, { scope, generation: record!.generation }); return wrapped;
          };
          const result = await work(reader, scope, controller.signal, open); credential(); return result;
        } finally { live = false; record = null; }
      });
    } catch (e) { closeSockets(); throw e; }
    finally { signal?.removeEventListener('abort', abort); if (active === controller) active = null; }
  }
  return {
    reconcileFocus: (previous: ScopedAgentFocus | null, signal?: AbortSignal) => read((reader, scope, abort) => reconcileAgentFocus(reader, scope, previous, abort), signal),
    reconcileConversation: (previous: ScopedAgentConversation | null, signal?: AbortSignal) => read((reader, scope, abort) => reconcileAgentConversation(reader, scope, previous, abort), signal),
    openConversationSocket: async (state: ScopedAgentConversation, signal: AbortSignal) => {
      if (!options.socket) throw new MobileSocketInvalid(); options.socket.assertAvailable();
      return read(async (_reader, scope, _abort, open) => {
        if (scope !== state.authScope || !state.snapshot || !state.eventCursor || state.focus.active_agent_session_id !== state.snapshot.id) throw new NativeAccountChanged();
        return open(state.snapshot.id, state.eventCursor.sequence);
      }, signal);
    },
    dispose() { closed = true; active?.abort(); closeSockets(); },
  };
}
