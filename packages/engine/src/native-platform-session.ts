import { createHash, randomUUID } from 'node:crypto';
import { NativePlatformSessionClient, NativePlatformHttpError, NativePlatformProtocolError, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { AgentSessionReadClient, AgentSessionHttpError, AgentSessionProtocolError, type AgentSessionProofSource, type AgentFocus } from '@dex/protocol/agent-session';
import { reconcileAgentFocus, type ScopedAgentFocus, type AgentFocusRecoveryResult } from '@dex/protocol/agent-session-focus-recovery';
import { withNativeAccount } from './native-account';
import { NativeDeviceKeyStore, nativeKeyScope, type NativeKeyScope } from './native-device-key-store';
import type { NativeSessionRecord, NativeSessionPhase } from './native-session-record';
import { DexError } from './errors';

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
  if (!record || record.phase !== 'ready') throw new DexError('auth_required', '사용 가능한 CLI 세션이 없습니다. 중단된 세션은 내 페이지에서 폐기한 뒤 로컬 기록을 지우고 다시 로그인하세요.');
  return record;
}
function requireAccess(record: NativeSessionRecord): string {
  if (!accessReady(record)) throw new DexError('auth_required', 'CLI access 자격증명이 없습니다. 먼저 dex session refresh를 실행하세요.');
  return record.accessToken!;
}

/** Native CLI sessions only. No automatic refresh/retry, legacy credential fallback or account cache. */
export class NativeCliSession {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  constructor(origin: string, private readonly keys = new NativeDeviceKeyStore(), fetchImpl?: typeof fetch) {
    this.origin = nativeKeyScope({ origin, platform: 'cli', userId: '1' }).origin;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }
  private scope(userId: string): NativeKeyScope { return nativeKeyScope({ origin: this.origin, platform: 'cli', userId }); }
  async login(email: string, password: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    return withNativeAccount({ origin: this.origin, email, password, fetch: this.fetchImpl, signal }, async (userId, current) => {
      const scope = this.scope(userId);
      return this.keys.withSession(scope, async (identity, _sign, vault) => {
        signal?.throwIfAborted();
        if (await vault.read()) throw new DexError('usage_error', '기존 CLI 세션 기록이 있습니다. 상태 확인·갱신 또는 서버 세션 폐기를 먼저 진행하세요.');
        const client = new NativePlatformSessionClient({ origin: this.origin, platform: 'cli', identity, fetch: this.fetchImpl, account: { current } });
        const device = await client.registrationStatus(signal);
        if (!device || device.state !== 'trusted') throw new DexError('auth_required', 'CLI 기기 등록과 브라우저 승인을 먼저 완료하세요.');
        const pending: NativeSessionRecord = { version: 1, ...scope, installId: identity.installId, deviceId: device.device_id,
          sessionId: null, generation: randomUUID(), phase: 'login_pending', refreshToken: null, accessToken: null, accessExpiresAt: null };
        signal?.throwIfAborted();
        await vault.write(pending);
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
      await vault.write(marker);
      const client = new NativePlatformSessionClient({ origin: this.origin, platform: 'cli', identity, fetch: this.fetchImpl,
        account: { current: () => ({ authScope: `${userId}/${marker.generation}`, accessToken: null }) } });
      const result = await client.refresh(old.deviceId, old.sessionId!, old.refreshToken!, signal);
      const record: NativeSessionRecord = { ...old, generation: randomUUID(), refreshToken: result.refresh_token,
        accessToken: result.access_token, accessExpiresAt: result.access_expires_at };
      await vault.write(record); signal?.throwIfAborted(); return summary(userId, record);
    });
  }
  /** The provider is usable only inside the account/install lock and cannot sign for another origin or token. */
  async withProofSource<T>(userId: string, work: (proof: AgentSessionProofSource, authScope: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.keys.withSession(this.scope(userId), async (_identity, sign, vault) => {
      const record = requireReady(await vault.read()); const token = requireAccess(record); let live = true;
      const check = () => { signal?.throwIfAborted(); if (!live || !accessReady(record)) throw new DexError('auth_required', 'CLI 세션 사용 범위가 종료되었습니다.'); };
      const proof: AgentSessionProofSource = {
        accessToken: async () => { check(); return token; },
        signProof: async (method, htu, expected) => {
          check();
          const url = new URL(htu);
          if (method !== 'GET' || url.origin !== this.origin || url.search || url.hash || expected !== token
            || !/^\/api\/agentflow\/(?:me\/(?:agent-state|agent-events|agent-sessions)|agent-sessions\/[0-9a-f-]{36}\/(?:snapshot|events))$/.test(url.pathname)) {
            throw new DexError('usage_error', 'Canonical 읽기 경로와 현재 CLI 토큰에만 서명할 수 있습니다.');
          }
          const result = await sign('GET', htu, token, signal); check(); return result;
        },
      };
      // Rotation keeps the sid, so its token/write generation must not reset an account cursor.
      const authScope = createHash('sha256').update(JSON.stringify([record.origin, record.platform, record.userId,
        record.installId, record.deviceId, record.sessionId])).digest('hex');
      try { const result = await work(proof, authScope); check(); return result; }
      finally { live = false; }
    });
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
  /** Password step-up and device DPoP revoke the current server sid before local credential deletion. */
  async logout(userId: string, password: string, signal?: AbortSignal): Promise<NativeSessionSummary> {
    if (!password || new TextEncoder().encode(password).length > 1024) throw new DexError('usage_error', '현재 계정 비밀번호가 필요합니다.');
    return this.keys.withSession(this.scope(userId), async (_identity, sign, vault) => {
      const record = requireReady(await vault.read()); const token = requireAccess(record); signal?.throwIfAborted();
      const htu = `${this.origin}/api/me/platform-sessions/${record.sessionId}`;
      await vault.write(blocked(record, 'logout_pending'));
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
      signal?.throwIfAborted(); await vault.clear(); return summary(userId, null);
    });
  }
}
