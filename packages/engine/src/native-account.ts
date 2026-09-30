import { createHash, randomUUID } from 'node:crypto';
import { NativePlatformHttpError, NativePlatformProtocolError, NativePlatformTransportError,
  type NativeAccountCredential } from '@dex/protocol/native-platform-session';
import { nativeKeyScope } from './native-device-key-store';
import { DexError } from './errors';

export interface NativeAccountOptions {
  origin: string;
  email: string;
  password: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
/** Temporary password login, isolated from the legacy CLI credential file. */
export async function withNativeAccount<T>(options: NativeAccountOptions,
  work: (userId: string, current: () => NativeAccountCredential | null) => Promise<T>): Promise<T> {
  const origin = nativeKeyScope({ origin: options.origin, platform: 'cli', userId: '1' }).origin;
  if (!options.email.trim() || !options.password || new TextEncoder().encode(options.password).length > 1024) {
    throw new DexError('usage_error', '이메일과 비밀번호가 필요합니다.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let credential: NativeAccountCredential | null = null;
  const request = async (path: string, body: object, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    signal?.throwIfAborted();
    let response: Response;
    try { response = await fetchImpl(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal }); }
    catch { signal?.throwIfAborted(); throw new NativePlatformTransportError(); }
    if (!response.ok) throw new NativePlatformHttpError(response.status);
    let value: unknown;
    try { value = await response.json(); } catch { signal?.throwIfAborted(); throw new NativePlatformProtocolError('Invalid native account response'); }
    signal?.throwIfAborted();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativePlatformProtocolError('Invalid native account response');
    return value as Record<string, unknown>;
  };
  let token: string | undefined;
  let completed = false;
  try {
    const login = await request('/api/auth/login', { email: options.email.trim(),
      password: createHash('sha256').update(options.password).digest('hex'), token: null }, options.signal);
    if (typeof login.access_token === 'string' && login.access_token.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(login.access_token)) token = login.access_token;
    if (login.success !== true || !token || typeof login.user_id !== 'string') throw new NativePlatformProtocolError('Invalid native account response');
    const scope = nativeKeyScope({ origin, platform: 'cli', userId: login.user_id });
    credential = { authScope: `${scope.userId}/${randomUUID()}`, accessToken: token };
    const result = await work(scope.userId, () => credential);
    completed = true;
    return result;
  } finally {
    credential = null;
    if (token) {
      try {
        const logout = await request('/api/auth/logout', { token }, AbortSignal.timeout(5000));
        if (logout.success !== true) throw new NativePlatformProtocolError('Invalid native account logout response');
      } catch {
        if (completed) throw new DexError('network_error', '기기 작업은 완료했지만 임시 로그인 정리에 실패했습니다.');
      }
    }
  }
}
