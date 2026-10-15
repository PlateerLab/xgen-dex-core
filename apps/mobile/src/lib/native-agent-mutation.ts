import { AgentTurnComposeFailure, type AgentTurnComposeRequest } from '@dex/protocol/agent-turn-composer';
import { AgentSessionMutationClient, AgentSessionMutationHttpError, validateStopAgentTurn, validateSubmitAgentTurn } from '@dex/protocol/agent-session-mutation';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileDeviceIdentity } from './native-device-key';
import type { createMobileSessionVault } from './native-session-vault';
import { MobileAgentMutationTransportBusy, MobileAgentMutationTransportUnavailable, type MobileAgentMutationFetch } from './native-agent-mutation-http';
import { mobileAgentScope } from './native-agent-scope';

/** Fixed login owner. Credentials/signers stay inside the account vault lock for one explicit write. */
export function createMobileAgentMutationSource(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  vault: ReturnType<typeof createMobileSessionVault>;
  fetch: MobileAgentMutationFetch;
  timeoutMs?: number;
}) {
  const initial = options.current(); if (!initial) throw new AgentTurnComposeFailure('unavailable');
  const authority = { origin: initial.origin, userId: initial.userId, authScope: initial.authScope };
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000) throw new TypeError('Invalid Mobile write deadline');
  let closed = false; let active: AbortController | null = null;
  return {
    async send(value: AgentTurnComposeRequest, signal?: AbortSignal): Promise<unknown> {
      // Copy primitive input synchronously, before any key/vault await can yield.
      let request: AgentTurnComposeRequest;
      try {
        if (value.scope.platform_type !== 'mobile' || value.scope.server_url !== authority.origin
          || value.scope.user_id !== authority.userId || typeof value.scope.profile !== 'string') throw new TypeError();
        request = value.operation === 'submit'
          ? { operation: 'submit', scope: { ...value.scope }, agent_session_id: value.agent_session_id,
            input: validateSubmitAgentTurn(value.agent_session_id, value.input) }
          : value.operation === 'stop'
            ? { operation: 'stop', scope: { ...value.scope }, agent_session_id: value.agent_session_id,
              input: validateStopAgentTurn(value.agent_session_id, value.input) }
            : (() => { throw new TypeError(); })();
      } catch { throw new AgentTurnComposeFailure('unavailable'); }
      if (closed || active) throw new AgentTurnComposeFailure('unavailable');
      const controller = new AbortController(); active = controller; let dispatched = false;
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const check = () => {
        controller.signal.throwIfAborted(); const current = options.current();
        if (closed || !current || current.origin !== authority.origin || current.userId !== authority.userId
          || current.authScope !== authority.authScope) throw new AgentTurnComposeFailure('unavailable');
      };
      const timer = setTimeout(abort, timeout);
      let rejectAbort!: (error: unknown) => void;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new AgentTurnComposeFailure(dispatched ? 'unknown' : 'unavailable'));
      controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort();
      const work = (async () => {
        check(); options.fetch.assertAvailable();
        const identity = await options.keys.identity(false, controller.signal); check();
        return options.vault.withIdentity(authority, identity, check, async (vault) => {
          let record = await vault.read(); check(); let live = true;
          const credential = () => {
            check(); if (!live || !record || record.phase !== 'ready' || !record.accessToken || !record.accessExpiresAt
              || Math.floor(Date.parse(record.accessExpiresAt) / 1000) * 1000 <= Date.now() + 1000
              || mobileAgentScope(authority, identity, record) !== request.scope.profile) throw new AgentTurnComposeFailure('unavailable');
            return record.accessToken;
          };
          try {
            credential();
            const client = new AgentSessionMutationClient(authority.origin, {
              accessToken: async () => credential(),
              signProof: async (method, htu, token) => {
                if (credential() !== token || !identity.signDpop) throw new AgentTurnComposeFailure('unavailable');
                const proof = await identity.signDpop(method, htu, token, controller.signal); credential(); return proof;
              },
            }, async (input, init) => {
              credential(); options.fetch.assertAvailable(); dispatched = true;
              let response: Response;
              try { response = await options.fetch(input, init); }
              catch (error) {
                // These codes are emitted before native enqueue. All other errors may
                // follow a committed write and retain the unknown outcome.
                if (error instanceof MobileAgentMutationTransportBusy || error instanceof MobileAgentMutationTransportUnavailable) dispatched = false;
                throw error;
              }
              credential();
              return { status: response.status, ok: response.ok, json: async () => {
                credential(); const result = await response.json(); credential(); return result;
              } } as Response;
            });
            const mutation = request.operation === 'submit'
              ? await client.submitTurn(request.agent_session_id, request.input, controller.signal)
              : await client.stopTurn(request.agent_session_id, request.input, controller.signal);
            credential(); return { ...request.scope, agent_session_id: request.agent_session_id, mutation };
          } finally { live = false; record = null; }
        });
      })();
      // Abort may end the JS wait before a key/storage call settles. Keep this owner busy
      // until that actual operation releases the vault; the native adapter owns its OS latch.
      void work.finally(() => { if (active === controller) active = null; }).catch(() => undefined);
      try { return await Promise.race([work, cancelled]); }
      catch (error) {
        if (error instanceof AgentSessionMutationHttpError && !controller.signal.aborted) {
          // Safe metadata only; never propagate a raw native/server exception.
          try { check(); } catch { throw new AgentTurnComposeFailure(dispatched ? 'unknown' : 'unavailable'); }
          throw new AgentTurnComposeFailure('rejected', error.conflict);
        }
        throw new AgentTurnComposeFailure(dispatched ? 'unknown' : 'unavailable');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
    },
    dispose() { closed = true; active?.abort(); },
  };
}
