import { createHash, randomUUID } from 'node:crypto';
import { NativePlatformSessionClient, NativePlatformHttpError, NativePlatformProtocolError, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { AgentSessionReadClient, AgentSessionHttpError, AgentSessionProtocolError, type AgentSessionProofSource, type AgentFocus } from '@dex/protocol/agent-session';
import { reconcileAgentFocus, type ScopedAgentFocus, type AgentFocusRecoveryResult } from '@dex/protocol/agent-session-focus-recovery';
import { reconcileAgentConversation, type ScopedAgentConversation, type AgentConversationRecoveryResult } from '@dex/protocol/agent-session-conversation-recovery';
import { readNativeAgentConversation } from './native-agent-conversation-watch';
import { nativeConversationFetch } from './native-agent-conversation-http';
import { withNativeAccount } from './native-account';
import { NativeDeviceKeyStore, nativeKeyScope, type NativeKeyScope } from './native-device-key-store';
import type { NativeSessionRecord, NativeSessionPhase } from './native-session-record';
import { DexError } from './errors';
import { createNativeAgentSocketTransport, type NativeAgentSocket, type NativeAgentSocketTransport } from './native-agent-socket';
import { AgentSessionMutationClient, AgentSessionMutationHttpError, AgentSessionMutationOutcomeUnknown,
  validateSubmitAgentTurn, validateStopAgentTurn, type AgentSessionMutationProofSource,
  type SubmitAgentTurnInput, type StopAgentTurnInput, type SubmittedAgentTurn, type StoppedAgentTurn } from '@dex/protocol/agent-session-mutation';
import { nativeAgentMutationFetch } from './native-agent-mutation-http';

export interface NativeSessionSummary {
  user_id: string;
  device_id: string | null;
  session_id: string | null;
  state: 'signed_out' | 'active' | 'access_expired' | 'access_unavailable' | Exclude<NativeSessionPhase, 'ready'>;
  access_expires_at: string | null;
}
function accessReady(record: NativeSessionRecord): boolean {
  return record.phase === 'ready' && record.accessToken !== null && record.accessExpiresAt !== null
    && Math.floor(Date.parse(record.accessExpiresAt) / 1000) * 1000 > Date.now() + 1000;
}
function summary(userId: string, record: NativeSessionRecord | null): NativeSessionSummary {
  return { user_id: userId, device_id: record?.deviceId ?? null, session_id: record?.sessionId ?? null,
    state: !record ? 'signed_out' : record.phase !== 'ready' ? record.phase : record.accessToken === null
      ? 'access_unavailable' : accessReady(record) ? 'active' : 'access_expired', access_expires_at: record?.accessExpiresAt ?? null };
}
function blocked(record: NativeSessionRecord, phase: Exclude<NativeSessionPhase, 'ready'>): NativeSessionRecord {
  return { ...record, phase, generation: randomUUID(), refreshToken: null, accessToken: null, accessExpiresAt: null };
}
function requireReady(record: NativeSessionRecord | null): NativeSessionRecord {
  if (!record || record.phase !== 'ready') throw new DexError('auth_required', '사용 가능한 네이티브 세션이 없습니다. 중단된 세션은 내 페이지에서 폐기한 뒤 로컬 기록을 지우고 다시 로그인하세요.');
  return record;
}
function requireAccess(record: NativeSessionRecord): string {
  if (!accessReady(record)) throw new DexError('auth_required', '네이티브 access 자격증명이 없습니다. 먼저 세션 갱신을 실행하세요.');
  return record.accessToken!;
}

/** Host fixes the platform at construction. No automatic refresh/retry or legacy credential fallback. */
export class NativeHostSession {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private socketTransport: NativeAgentSocketTransport | undefined;
  private readonly sockets = new Map<NativeAgentSocket, { scope: string; generation: string }>();
  constructor(origin: string, readonly platform: NativeKeyScope['platform'], private readonly keys = new NativeDeviceKeyStore(), fetchImpl?: typeof fetch,
    private readonly expectedUserId?: string, socketTransport?: NativeAgentSocketTransport) {
    this.origin = nativeKeyScope({ origin, platform, userId: '1' }).origin;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.socketTransport = socketTransport;
  }
  private scope(userId: string): NativeKeyScope {
    if (this.expectedUserId !== undefined && userId !== this.expectedUserId) throw new DexError('auth_required', '현재 앱에 로그인한 계정만 사용할 수 있습니다.');
    return nativeKeyScope({ origin: this.origin, platform: this.platform, userId });
  }
  private closeSockets(): void {
    const sockets = [...this.sockets.keys()]; this.sockets.clear();
    for (const socket of sockets) void socket.close().catch(() => undefined);
  }
  async login(email: string, password: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    return withNativeAccount({ origin: this.origin, email, password, fetch: this.fetchImpl, signal, expectedUserId: this.expectedUserId }, async (userId, current) => {
      const scope = this.scope(userId);
      return this.keys.withSession(scope, async (identity, _sign, vault) => {
        signal?.throwIfAborted();
        if (await vault.read()) throw new DexError('usage_error', '기존 네이티브 세션 기록이 있습니다. 상태 확인·갱신 또는 서버 세션 폐기를 먼저 진행하세요.');
        const client = new NativePlatformSessionClient({ origin: this.origin, platform: this.platform, identity, fetch: this.fetchImpl, account: { current } });
        const device = await client.registrationStatus(signal);
        if (!device || device.state !== 'trusted') throw new DexError('auth_required', '해당 플랫폼의 기기 등록과 브라우저 승인을 먼저 완료하세요.');
        const pending: NativeSessionRecord = { version: 1, ...scope, installId: identity.installId, deviceId: device.device_id,
          sessionId: null, generation: randomUUID(), phase: 'login_pending', refreshToken: null, accessToken: null, accessExpiresAt: null };
        signal?.throwIfAborted();
        this.closeSockets(); await vault.write(pending);
        const result = await client.login(device.device_id, password, signal);
        const record: NativeSessionRecord = { ...pending, sessionId: result.session_id, generation: randomUUID(),
          phase: result.state === 'active' ? 'ready' : 'pending_takeover', refreshToken: result.refresh_token,
          accessToken: result.access_token, accessExpiresAt: result.access_expires_at };
        // Persist and read back before credentials can be used. Even cancellation after a response cannot restore old tokens.
        await vault.write(record);
        signal?.throwIfAborted();
        return summary(userId, record);
      });
    });
  }
  async status(userId: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    return this.keys.withSession(this.scope(userId), async (_identity, _sign, vault) => {
      signal?.throwIfAborted(); const record = await vault.read(); signal?.throwIfAborted(); return summary(userId, record);
    });
  }
  async refresh(userId: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    const scope = this.scope(userId);
    return this.keys.withSession(scope, async (identity, _sign, vault) => {
      const old = requireReady(await vault.read()); signal?.throwIfAborted();
      const marker = blocked(old, 'refreshing');
      this.closeSockets(); await vault.write(marker);
      const client = new NativePlatformSessionClient({ origin: this.origin, platform: this.platform, identity, fetch: this.fetchImpl,
        account: { current: () => ({ authScope: `${userId}/${marker.generation}`, accessToken: null }) } });
      const result = await client.refresh(old.deviceId, old.sessionId!, old.refreshToken!, signal);
      const record: NativeSessionRecord = { ...old, generation: randomUUID(), refreshToken: result.refresh_token,
        accessToken: result.access_token, accessExpiresAt: result.access_expires_at };
      await vault.write(record); signal?.throwIfAborted(); return summary(userId, record);
    });
  }
  /** The provider is usable only inside the account/install lock and cannot sign for another origin or token. */
  async withProofSource<T>(userId: string, work: (proof: AgentSessionProofSource, authScope: string, generation: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withScopedProofSource(userId, work, signal);
  }
  private async withScopedProofSource<T>(userId: string,
    work: (proof: AgentSessionProofSource & AgentSessionMutationProofSource, authScope: string, generation: string) => Promise<T>,
    signal?: AbortSignal, writePath?: string): Promise<T> {
    try { return await this.keys.withSession(this.scope(userId), async (_identity, sign, vault) => {
      const record = requireReady(await vault.read()); const token = requireAccess(record); let live = true;
      const check = () => { signal?.throwIfAborted(); if (!live || !accessReady(record)) throw new DexError('auth_required', '네이티브 세션 사용 범위가 종료되었습니다.'); };
      const proof: AgentSessionProofSource & AgentSessionMutationProofSource = {
        accessToken: async () => { check(); return token; },
        signProof: async (method, htu, expected) => {
          check();
          const url = new URL(htu);
          const read = method === 'GET' && /^\/api\/agentflow\/(?:me\/(?:agent-state|agent-events|agent-sessions)|agent-sessions\/[0-9a-f-]{36}\/(?:snapshot|events|messages))$/.test(url.pathname);
          const write = method === 'POST' && writePath !== undefined && url.pathname === writePath;
          if ((!read && !write) || url.origin !== this.origin || url.username || url.password || url.search || url.hash
            || htu !== `${this.origin}${url.pathname}` || expected !== token) {
            throw new DexError('usage_error', '허용된 Canonical 경로와 현재 플랫폼 토큰에만 서명할 수 있습니다.');
          }
          const result = await sign(method, htu, token, signal); check(); return result;
        },
      };
      // Rotation keeps the sid, so its token/write generation must not reset an account cursor.
      const authScope = createHash('sha256').update(JSON.stringify([record.origin, record.platform, record.userId,
        record.installId, record.deviceId, record.sessionId])).digest('hex');
      for (const [socket, binding] of this.sockets) {
        if (socket.closed || binding.scope !== authScope || binding.generation !== record.generation) {
          void socket.close().catch(() => undefined); this.sockets.delete(socket);
        }
      }
      try { const result = await work(proof, authScope, record.generation); check(); return result; }
      finally { live = false; }
    }); } catch (error) {
      this.closeSockets(); throw error;
    }
  }
  /** Fresh vault read for each bounded step. The caller waits only after this lock is released. */
  async reconcileFocus(userId: string, previous: ScopedAgentFocus | null, signal?: AbortSignal): Promise<AgentFocusRecoveryResult> {
    try {
      return await this.withProofSource(userId, async (proof, authScope) => {
        const transport = (async (input, init) => {
          try { return await this.fetchImpl(input, init); }
          catch { signal?.throwIfAborted(); throw new NativePlatformTransportError(); }
        }) as typeof fetch;
        const client = new AgentSessionReadClient(this.origin, proof, transport);
        const read = async <T>(work: () => Promise<T>): Promise<T> => {
          try { return await work(); }
          catch (error) {
            signal?.throwIfAborted();
            if (error instanceof SyntaxError) throw new AgentSessionProtocolError('Invalid Canonical JSON response');
            throw error;
          }
        };
        return reconcileAgentFocus({ focus: (s) => read(() => client.focus(s)),
          accountEvents: (after, limit, s) => read(() => client.accountEvents(after, limit, s)) }, authScope, previous, signal);
      }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DexError || error instanceof AgentSessionHttpError || error instanceof NativePlatformTransportError) throw error;
      if (error instanceof AgentSessionProtocolError) throw new DexError('protocol_mismatch', 'Canonical 포커스 응답을 확인할 수 없습니다.');
      throw new NativePlatformTransportError();
    }
  }
  async focus(userId: string, signal?: AbortSignal): Promise<AgentFocus> {
    try {
      return await this.withProofSource(userId, (proof) => new AgentSessionReadClient(this.origin, proof, this.fetchImpl).focus(signal), signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DexError || error instanceof AgentSessionHttpError) throw error;
      throw new NativePlatformTransportError();
    }
  }
  async reconcileConversation(userId: string, previous: ScopedAgentConversation | null, signal?: AbortSignal): Promise<AgentConversationRecoveryResult> {
    try {
      return await this.withProofSource(userId, async (proof, authScope) => {
        const check = async () => { signal?.throwIfAborted(); await proof.accessToken(); };
        const client = new AgentSessionReadClient(this.origin, proof, nativeConversationFetch(this.origin, this.fetchImpl, check));
        return reconcileAgentConversation(client, authScope, previous, signal);
      }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DexError || error instanceof AgentSessionHttpError || error instanceof NativePlatformTransportError) throw error;
      if (error instanceof AgentSessionProtocolError) throw new DexError('protocol_mismatch', '공유 대화의 실행·메시지 기록을 확인할 수 없습니다.');
      throw new NativePlatformTransportError();
    }
  }
  async conversation(userId: string, signal?: AbortSignal) {
    return readNativeAgentConversation(this, userId, signal);
  }
  async submitTurn(userId: string, sessionId: string, input: SubmitAgentTurnInput, signal?: AbortSignal): Promise<SubmittedAgentTurn> {
    let body: SubmitAgentTurnInput;
    try { body = validateSubmitAgentTurn(sessionId, input); }
    catch { throw new DexError('usage_error', '대화 ID·상태 버전·중복 방지 키와 입력을 확인하세요.'); }
    return this.mutateTurn(userId, sessionId, 'turns', body, signal);
  }
  async stopTurn(userId: string, sessionId: string, input: StopAgentTurnInput, signal?: AbortSignal): Promise<StoppedAgentTurn> {
    let body: StopAgentTurnInput;
    try { body = validateStopAgentTurn(sessionId, input); }
    catch { throw new DexError('usage_error', '중단할 대화 ID·실행 턴과 상태 버전을 확인하세요.'); }
    return this.mutateTurn(userId, sessionId, 'stop', body, signal);
  }
  private async mutateTurn<A extends 'turns' | 'stop'>(userId: string, sessionId: string, action: A,
    body: A extends 'turns' ? SubmitAgentTurnInput : StopAgentTurnInput, signal?: AbortSignal): Promise<A extends 'turns' ? SubmittedAgentTurn : StoppedAgentTurn> {
    signal?.throwIfAborted(); const control = new AbortController(); const cancel = () => control.abort(signal?.reason);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const timer = setTimeout(() => control.abort(), 10000); let dispatched = false;
    const metadata = { agent_session_id: sessionId, expected_state_version: body.expected_state_version,
      ...(action === 'turns' ? { idempotency_key: (body as SubmitAgentTurnInput).idempotency_key } : { turn_id: (body as StopAgentTurnInput).turn_id }) };
    try {
      const result = await this.withScopedProofSource(userId, async (proof) => {
        const check = async () => { control.signal.throwIfAborted(); await proof.accessToken(); };
        const fetch = nativeAgentMutationFetch(this.origin, (async (input, init) => {
          control.signal.throwIfAborted(); dispatched = true; return this.fetchImpl(input, init);
        }) as typeof globalThis.fetch, check);
        const client = new AgentSessionMutationClient(this.origin, proof, fetch);
        return action === 'turns' ? client.submitTurn(sessionId, body as SubmitAgentTurnInput, control.signal)
          : client.stopTurn(sessionId, body as StopAgentTurnInput, control.signal);
      }, control.signal, `/api/agentflow/agent-sessions/${sessionId}/${action}`);
      return result as A extends 'turns' ? SubmittedAgentTurn : StoppedAgentTurn;
    } catch (error) {
      if (error instanceof AgentSessionMutationHttpError) {
        if ([401, 403].includes(error.status)) throw new DexError('auth_required', '플랫폼 인증을 확인한 뒤 다시 실행하세요.', { outcome: 'rejected', status: error.status, ...metadata });
        throw new DexError('usage_error', '요청이 거절되었습니다. 현재 대화 상태와 입력을 확인하세요.', {
          outcome: 'rejected', status: error.status, ...metadata, ...(error.conflict ? { conflict: error.conflict } : {}) });
      }
      if (dispatched || error instanceof AgentSessionMutationOutcomeUnknown) {
        throw new DexError('network_error', '송신 완료 여부를 확인할 수 없습니다. 대화 상태를 확인하고 같은 입력·버전·중복 방지 키로 재확인하세요.', { outcome: 'unknown', ...metadata });
      }
      control.signal.throwIfAborted();
      if (error instanceof DexError) throw error;
      throw new DexError('network_error', '대화 송신 준비를 완료할 수 없습니다.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  /** Only an internal, verified conversation may select the scoped native event socket. */
  async openConversationSocket(userId: string, state: ScopedAgentConversation, signal: AbortSignal): Promise<NativeAgentSocket> {
    this.socketTransport ??= createNativeAgentSocketTransport(this.origin);
    // Recheck the vault first so journal/rotation/account errors also close old sockets.
    return this.withProofSource(userId, async (proof, scope, generation) => {
      if (scope !== state.authScope || !state.snapshot || !state.eventCursor || state.focus.active_agent_session_id !== state.snapshot.id
        || state.eventCursor.sequence > state.snapshot.current_sequence) throw new DexError('auth_required', '현재 계정의 공유 대화만 구독할 수 있습니다.');
      this.socketTransport!.assertAvailable();
      const token = await proof.accessToken();
      if (!token) throw new DexError('auth_required', '네이티브 세션 인증이 필요합니다.');
      const dpop = await proof.signProof('GET', `${this.origin}/api/agentflow/agent-sessions/${state.snapshot.id}/events`, token);
      const socket = await this.socketTransport!.open(state.snapshot.id, state.eventCursor.sequence, token, dpop, signal);
      try { signal.throwIfAborted(); await proof.accessToken(); }
      catch (error) { void socket.close().catch(() => undefined); throw error; }
      const wrapped: NativeAgentSocket = { get closed() { return socket.closed; }, next: () => socket.next(),
        close: () => socket.close().finally(() => this.sockets.delete(wrapped)) };
      this.sockets.set(wrapped, { scope, generation }); return wrapped;
    }, signal);
  }
  /** Password step-up and device DPoP revoke the current server sid before local credential deletion. */
  async logout(userId: string, password: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    if (!password || new TextEncoder().encode(password).length > 1024) throw new DexError('usage_error', '현재 계정 비밀번호가 필요합니다.');
    return this.keys.withSession(this.scope(userId), async (_identity, sign, vault) => {
      const record = requireReady(await vault.read()); const token = requireAccess(record); signal?.throwIfAborted();
      const htu = `${this.origin}/api/me/platform-sessions/${record.sessionId}`;
      this.closeSockets(); await vault.write(blocked(record, 'logout_pending'));
      const dpop = await sign('DELETE', htu, token, signal);
      let response: Response;
      try { response = await this.fetchImpl(htu, { method: 'DELETE', headers: { Authorization: `DPoP ${token}`, DPoP: dpop,
        'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ password }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal }); }
      catch { signal?.throwIfAborted(); throw new NativePlatformTransportError(); }
      if (response.status !== 204) {
        if (!response.ok) throw new NativePlatformHttpError(response.status);
        throw new NativePlatformProtocolError('Invalid native logout response');
      }
      await vault.clear(); signal?.throwIfAborted(); return summary(userId, null);
    });
  }
  /** Explicit local-only recovery. Does not revoke a server session and preserves the enrollment key. */
  async forgetLocal(userId: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    return this.keys.withSession(this.scope(userId), async (_identity, _sign, vault) => {
      signal?.throwIfAborted(); this.closeSockets(); await vault.clear(); return summary(userId, null);
    });
  }
}

/** Existing CLI commands always use their own platform slot. */
export class NativeCliSession extends NativeHostSession {
  constructor(origin: string, keys?: NativeDeviceKeyStore, fetchImpl?: typeof fetch, socketTransport?: NativeAgentSocketTransport) {
    super(origin, 'cli', keys, fetchImpl, undefined, socketTransport);
  }
}
