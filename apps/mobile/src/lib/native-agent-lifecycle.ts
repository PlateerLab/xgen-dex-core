import { AgentSessionLifecycleClient, AgentSessionLifecycleHttpError, validateCreateAgentSession, validateSwitchAgentFocus,
  type CreateAgentSessionInput, type SwitchAgentFocusInput, type AgentSessionLifecycleConflict } from '@dex/protocol/agent-session-lifecycle';
import type { AgentTurnScope } from '@dex/protocol/agent-turn-composer';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileDeviceIdentity } from './native-device-key';
import type { createMobileSessionVault } from './native-session-vault';
import { MobileAgentLifecycleTransportBusy, MobileAgentLifecycleTransportUnavailable, type MobileAgentLifecycleFetch } from './native-agent-lifecycle-http';
import { mobileAgentScope } from './native-agent-scope';

export type MobileAgentLifecycleRequest = { scope: AgentTurnScope } & (
  { operation: 'create'; input: CreateAgentSessionInput } | { operation: 'switch'; input: SwitchAgentFocusInput });
export class MobileAgentLifecycleFailure extends Error {
  constructor(readonly outcome: 'unavailable' | 'unknown' | 'rejected', readonly conflict?: AgentSessionLifecycleConflict) {
    super(outcome === 'unknown' ? '작업 완료 여부를 확인할 수 없습니다. 세션 목록을 직접 다시 조회하세요.'
      : outcome === 'rejected' ? '세션 변경이 거부되었습니다. 최신 목록을 확인하세요.' : '현재 연결에서는 세션을 변경할 수 없습니다.');
  }
}

/** One explicit create/focus write, using credentials only inside the account vault lock. */
export function createMobileAgentLifecycleSource(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  vault: ReturnType<typeof createMobileSessionVault>; fetch: MobileAgentLifecycleFetch; timeoutMs?: number;
}) {
  const initial = options.current(); if (!initial) throw new MobileAgentLifecycleFailure('unavailable');
  const authority = { origin: initial.origin, userId: initial.userId, authScope: initial.authScope };
  const timeout = options.timeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000) throw new TypeError('Invalid Mobile lifecycle deadline');
  let closed = false; let active: AbortController | null = null;
  return {
    async send(value: MobileAgentLifecycleRequest, signal?: AbortSignal): Promise<unknown> {
      let request: MobileAgentLifecycleRequest;
      try {
        if (value.scope.platform_type !== 'mobile' || value.scope.server_url !== authority.origin
          || value.scope.user_id !== authority.userId || typeof value.scope.profile !== 'string') throw new TypeError();
        request = value.operation === 'create' ? { operation: 'create', scope: { ...value.scope }, input: validateCreateAgentSession(value.input) }
          : value.operation === 'switch' ? { operation: 'switch', scope: { ...value.scope }, input: validateSwitchAgentFocus(value.input) }
            : (() => { throw new TypeError(); })();
      } catch { throw new MobileAgentLifecycleFailure('unavailable'); }
      if (closed || active) throw new MobileAgentLifecycleFailure('unavailable');
      const controller = new AbortController(); active = controller; let dispatched = false;
      const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const check = () => {
        controller.signal.throwIfAborted(); const current = options.current();
        if (closed || !current || current.origin !== authority.origin || current.userId !== authority.userId
          || current.authScope !== authority.authScope) throw new MobileAgentLifecycleFailure('unavailable');
      };
      const timer = setTimeout(abort, timeout);
      let rejectAbort!: (error: unknown) => void;
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new MobileAgentLifecycleFailure(dispatched ? 'unknown' : 'unavailable'));
      controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort();
      const work = (async () => {
        check(); options.fetch.assertAvailable(); const identity = await options.keys.identity(false, controller.signal); check();
        return options.vault.withIdentity(authority, identity, check, async (vault) => {
          let record = await vault.read(); check(); let live = true;
          const credential = () => {
            check(); if (!live || !record || record.phase !== 'ready' || !record.accessToken || !record.accessExpiresAt
              || Math.floor(Date.parse(record.accessExpiresAt) / 1000) * 1000 <= Date.now() + 1000
              || mobileAgentScope(authority, identity, record) !== request.scope.profile) throw new MobileAgentLifecycleFailure('unavailable');
            return record.accessToken;
          };
          try {
            credential();
            const client = new AgentSessionLifecycleClient(authority.origin, {
              accessToken: async () => credential(), signProof: async (method, htu, token) => {
                if (credential() !== token || !identity.signDpop) throw new MobileAgentLifecycleFailure('unavailable');
                const proof = await identity.signDpop(method, htu, token, controller.signal); credential(); return proof;
              },
            }, async (input, init) => {
              credential(); options.fetch.assertAvailable(); dispatched = true;
              let response: Response;
              try { response = await options.fetch(input, init); }
              catch (error) {
                if (error instanceof MobileAgentLifecycleTransportBusy || error instanceof MobileAgentLifecycleTransportUnavailable) dispatched = false;
                throw error;
              }
              credential(); return { status: response.status, ok: response.ok, json: async () => {
                credential(); const result = await response.json(); credential(); return result;
              } } as Response;
            });
            const result = request.operation === 'create'
              ? { created: await client.createSession(request.input, controller.signal) }
              : { focus: await client.switchFocus(request.input, controller.signal) };
            credential(); return { ...request.scope, ...result };
          } finally { live = false; record = null; }
        });
      })();
      // Cancellation releases the JS caller, while the underlying vault/native owner must still settle.
      void work.finally(() => { if (active === controller) active = null; }).catch(() => undefined);
      try { return await Promise.race([work, cancelled]); }
      catch (error) {
        if (error instanceof AgentSessionLifecycleHttpError && !controller.signal.aborted) {
          try { check(); } catch { throw new MobileAgentLifecycleFailure(dispatched ? 'unknown' : 'unavailable'); }
          throw new MobileAgentLifecycleFailure('rejected', error.conflict);
        }
        throw new MobileAgentLifecycleFailure(dispatched ? 'unknown' : 'unavailable');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
    },
    dispose() { closed = true; active?.abort(); },
  };
}
