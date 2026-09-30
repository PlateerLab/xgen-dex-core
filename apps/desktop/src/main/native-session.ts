import { DexError, MemoryConfigStore, defaultConfig, nativeKeyScope } from '@dex/engine';
import { NativePlatformHttpError, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { NativeSessionRpcHost, type NativeSessionHostOptions } from '@dex/rpc/native-session-host';
import type { DesktopNativeReply, DesktopNativeNotice } from '../native-session-types';

export interface DesktopNativeContext { origin: string; userId: string | null }
export interface DesktopNativeOptions extends NativeSessionHostOptions {
  current: () => DesktopNativeContext;
  notify: (notice: DesktopNativeNotice) => void;
}
function safeError(error: unknown): Extract<DesktopNativeReply, { ok: false }> {
  if (error instanceof DexError) return { ok: false, code: error.code, message: error.message };
  if (error instanceof NativePlatformHttpError) return { ok: false, code: `http_${error.status}`, message: `서버가 기기·세션 요청을 거절했습니다 (${error.status}).` };
  if (error instanceof NativePlatformTransportError) return { ok: false, code: 'network_error', message: 'HTTPS 서버 연결을 확인하세요.' };
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'cancelled', message: '기기·세션 작업이 취소되었습니다.' };
  return { ok: false, code: 'protocol_mismatch', message: '기기·세션 작업을 완료하지 못했습니다. 상태를 다시 확인하세요.' };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DexError('usage_error', '기기·세션 요청 형식을 확인하세요.');
  return value as Record<string, unknown>;
}
/** Main-process account binding; owns no renderer credentials, config writes or legacy fallback. */
export class DesktopNativeSessions {
  private host: NativeSessionRpcHost | null = null;
  private scope: string | null = null;
  private generation = 0;
  constructor(private readonly options: DesktopNativeOptions) {}
  reset(): void {
    this.generation++; this.host?.close(); this.host = null; this.scope = null;
    this.options.notify({ type: 'cleared' });
  }
  private current() {
    const current = this.options.current();
    if (!current.userId) throw new DexError('auth_required', '앱에 먼저 로그인하세요.');
    const scope = nativeKeyScope({ origin: current.origin, userId: current.userId, platform: 'desktop' });
    return { ...scope, key: JSON.stringify([scope.origin, scope.userId]) };
  }
  async request(rawMethod: unknown, rawParams: unknown = {}): Promise<DesktopNativeReply> {
    try {
      if (typeof rawMethod !== 'string' || !['device', 'session', 'watch', 'unwatch', 'cancel'].includes(rawMethod)) throw new DexError('usage_error', '지원하지 않는 기기·세션 작업입니다.');
      const params = object(rawParams);
      // Renderer cannot select another origin/profile/account or make a host platform override.
      if (['profile', 'user_id', 'platform', 'platform_type', 'server_url', 'origin'].some((key) => key in params)) throw new DexError('usage_error', '기기·세션 계정과 서버는 앱이 지정합니다.');
      if (rawMethod === 'cancel') {
        if (Object.keys(params).length) throw new DexError('usage_error', '취소 요청에는 추가 항목을 넣을 수 없습니다.');
        this.reset(); return { ok: true, value: { watching: false } };
      }
      const scope = this.current();
      if (this.scope !== scope.key) {
        if (this.host) this.reset();
        this.scope = scope.key;
        const configs = new MemoryConfigStore({ ...defaultConfig(), currentProfile: 'desktop', profiles: { desktop: { serverUrl: scope.origin } } });
        this.host = new NativeSessionRpcHost(configs, (value) => {
          try { if (this.scope === scope.key && this.current().key === scope.key) this.options.notify({ type: 'update', value }); }
          catch { this.reset(); }
        }, { ...this.options, expectedUserId: scope.userId }, 'desktop');
      }
      const generation = this.generation;
      const scoped = rawMethod === 'unwatch' ? params : { ...params, profile: 'desktop',
        ...(rawMethod === 'device' || (rawMethod === 'session' && params.action === 'login') ? {} : { user_id: scope.userId }) };
      const value = await this.host!.request(`native/${rawMethod}`, scoped);
      if (generation !== this.generation || this.current().key !== scope.key) throw new DOMException('Cancelled', 'AbortError');
      return { ok: true, value };
    } catch (error) { return safeError(error); }
  }
}

/** Only the main renderer's top-level frame may invoke the new native credential boundary. */
export function isNativeSessionSender(sender: unknown, frame: unknown, main: { mainFrame: unknown } | null): boolean {
  return main !== null && sender === main && frame !== null && frame === main.mainFrame;
}
