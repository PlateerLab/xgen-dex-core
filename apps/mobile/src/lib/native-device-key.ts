import { sha256 } from 'js-sha256';
import type { NativeDeviceIdentity, NativeDeviceProofPurpose, NativePublicKey } from '@dex/protocol/native-platform-session';

export type MobileKeyStorage = 'secure-enclave' | 'android-tee' | 'android-strongbox';
export interface MobileNativeContext { origin: string; userId: string; authScope: string }
export interface MobileNativeKeyModule {
  prepare(origin: string, userId: string, create: boolean): Promise<unknown>;
  signChallenge(origin: string, userId: string, installId: string, thumbprint: string, purpose: string, challenge: string): Promise<unknown>;
  signDpop?(origin: string, userId: string, installId: string, thumbprint: string, method: string, htu: string, token: string): Promise<unknown>;
}
export interface MobileDeviceIdentity extends NativeDeviceIdentity {
  storage: MobileKeyStorage;
  signDpop?(method: 'GET' | 'DELETE', htu: string, token: string, signal?: AbortSignal): Promise<string>;
}
export class MobileDeviceKeyError extends Error {
  constructor(readonly code: 'unavailable' | 'missing' | 'invalid' | 'locked' | 'account_changed') {
    super({ unavailable: '이 환경에서는 안전한 기기 키를 사용할 수 없습니다. 네이티브 앱과 지원 기기를 확인하세요.',
      missing: '이 계정의 기기 키를 먼저 준비하세요.', invalid: '기존 기기 키를 복원할 수 없습니다. 관리자 복구가 필요합니다.',
      locked: '화면 잠금을 설정하고 기기를 잠금 해제한 뒤 다시 실행하세요.', account_changed: '계정 또는 서버가 변경되어 기기 작업을 중단했습니다.' }[code]);
  }
}
const BYTES32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
function scope(value: MobileNativeContext | null): MobileNativeContext {
  if (!value || !value.authScope || value.userId.trim() !== value.userId || !/^[1-9][0-9]{0,18}$/.test(value.userId)) throw new MobileDeviceKeyError('account_changed');
  try {
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error();
    return { ...value, origin: url.origin };
  } catch { throw new MobileDeviceKeyError('invalid'); }
}
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((k) => !fields.includes(k))) throw new MobileDeviceKeyError('invalid');
  return raw as Record<string, unknown>;
}
function publicIdentity(raw: unknown): { installId: string; publicKey: NativePublicKey; storage: MobileKeyStorage } {
  const value = object(raw, ['installId', 'publicKey', 'storage']); const key = object(value.publicKey, ['kty', 'crv', 'x', 'y']);
  if (typeof value.installId !== 'string' || !UUID.test(value.installId) || !['secure-enclave', 'android-tee', 'android-strongbox'].includes(String(value.storage))
    || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || !BYTES32.test(key.x) || typeof key.y !== 'string' || !BYTES32.test(key.y)) throw new MobileDeviceKeyError('invalid');
  return { installId: value.installId, storage: value.storage as MobileKeyStorage,
    publicKey: Object.freeze({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }) };
}
export function mobileBase64url(bytes: number[]): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; let output = ''; let bits = 0; let held = 0;
  for (const byte of bytes) { held = (held << 8) | byte; bits += 8; while (bits >= 6) { bits -= 6; output += alphabet[(held >>> bits) & 63]; } }
  if (bits) output += alphabet[(held << (6 - bits)) & 63]; return output;
}
export function mobileJwtPart(part: string): Record<string, unknown> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'; let text = ''; let held = 0; let bits = 0;
  for (const char of part) { const value = alphabet.indexOf(char); if (value < 0) throw new MobileDeviceKeyError('invalid');
    held = (held << 6) | value; bits += 6; if (bits >= 8) { bits -= 8; text += String.fromCharCode((held >>> bits) & 255); } }
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new MobileDeviceKeyError('invalid'); }
}
export function mobileKeyThumbprint(key: NativePublicKey): string {
  return mobileBase64url(sha256.array(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })));
}
function safeError(error: unknown): MobileDeviceKeyError {
  if (error instanceof MobileDeviceKeyError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
  return new MobileDeviceKeyError(code === 'mobile_key_missing' ? 'missing' : code === 'mobile_key_invalid' ? 'invalid' : code === 'mobile_key_locked' ? 'locked' : 'unavailable');
}
/** A native P-256 signer only: no private bytes, SecureStore software-key fallback or network calls. */
export function createMobileDeviceKeys(module: MobileNativeKeyModule | null, current: () => MobileNativeContext | null) {
  return {
    async identity(create = false, signal?: AbortSignal): Promise<MobileDeviceIdentity> {
      const selected = scope(current());
      const check = () => { signal?.throwIfAborted(); const actual = scope(current());
        if (actual.origin !== selected.origin || actual.userId !== selected.userId || actual.authScope !== selected.authScope) throw new MobileDeviceKeyError('account_changed'); };
      try {
        check(); if (!module) throw new MobileDeviceKeyError('unavailable');
        const identity = publicIdentity(await module.prepare(selected.origin, selected.userId, create)); check();
        const thumbprint = mobileKeyThumbprint(identity.publicKey);
        return Object.freeze({ ...identity,
          async signChallenge(purpose: NativeDeviceProofPurpose, challenge: string, operationSignal?: AbortSignal): Promise<string> {
            const signingCheck = () => { check(); operationSignal?.throwIfAborted(); };
            try {
              signingCheck(); if (!['register', 'approval_request', 'login', 'native_refresh'].includes(purpose) || !BYTES32.test(challenge)) throw new MobileDeviceKeyError('invalid');
              const proof = await module.signChallenge(selected.origin, selected.userId, identity.installId, thumbprint, purpose, challenge); signingCheck();
              if (typeof proof !== 'string' || proof.length > 8192) throw new MobileDeviceKeyError('invalid');
              const parts = proof.split('.'); if (parts.length !== 3 || !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(parts[2]!)) throw new MobileDeviceKeyError('invalid');
              const header = object(mobileJwtPart(parts[0]!), ['alg', 'typ']); const claims = object(mobileJwtPart(parts[1]!), ['challenge', 'purpose', 'iat']);
              if (header.alg !== 'ES256' || header.typ !== 'platform-device-proof+jwt' || claims.challenge !== challenge || claims.purpose !== purpose
                || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || Math.abs(Math.floor(Date.now() / 1000) - claims.iat) > 30) throw new MobileDeviceKeyError('invalid');
              return proof;
            } catch (error) { if (signal?.aborted || operationSignal?.aborted) { signal?.throwIfAborted(); operationSignal?.throwIfAborted(); } throw safeError(error); }
          },
          async signDpop(method: 'GET' | 'DELETE', htu: string, token: string, operationSignal?: AbortSignal): Promise<string> {
            const signingCheck = () => { check(); operationSignal?.throwIfAborted(); };
            try {
              signingCheck(); if (!module.signDpop) throw new MobileDeviceKeyError('unavailable');
              const url = new URL(htu);
              const allowed = method === 'DELETE' ? new RegExp(`^/api/me/platform-sessions/${SESSION_UUID}$`).test(url.pathname)
                : method === 'GET' && new RegExp(`^/api/agentflow/(?:me/(?:agent-state|agent-events|agent-sessions)|agent-sessions/${SESSION_UUID}/(?:snapshot|events))$`).test(url.pathname);
              if (!allowed || url.origin !== selected.origin || url.username || url.password || url.search || url.hash || url.href !== htu
                || token.trim() !== token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new MobileDeviceKeyError('invalid');
              const proof = await module.signDpop(selected.origin, selected.userId, identity.installId, thumbprint, method, htu, token); signingCheck();
              if (typeof proof !== 'string' || proof.length > 8192) throw new MobileDeviceKeyError('invalid');
              const parts = proof.split('.'); if (parts.length !== 3 || !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(parts[2]!)) throw new MobileDeviceKeyError('invalid');
              const header = object(mobileJwtPart(parts[0]!), ['alg', 'typ', 'jwk']);
              const key = object(header.jwk, ['kty', 'crv', 'x', 'y']);
              const claims = object(mobileJwtPart(parts[1]!), ['jti', 'htm', 'htu', 'iat', 'ath']);
              if (header.alg !== 'ES256' || header.typ !== 'dpop+jwt' || key.kty !== 'EC' || key.crv !== 'P-256'
                || key.x !== identity.publicKey.x || key.y !== identity.publicKey.y || claims.htm !== method || claims.htu !== htu
                || claims.ath !== mobileBase64url(sha256.array(token)) || typeof claims.jti !== 'string' || claims.jti.length !== 36 || !UUID.test(claims.jti)
                || !Number.isSafeInteger(claims.iat) || Math.abs(Math.floor(Date.now() / 1000) - (claims.iat as number)) > 30) throw new MobileDeviceKeyError('invalid');
              return proof;
            } catch (error) { if (signal?.aborted || operationSignal?.aborted) { signal?.throwIfAborted(); operationSignal?.throwIfAborted(); } throw safeError(error); }
          },
        });
      } catch (error) { signal?.throwIfAborted(); throw safeError(error); }
    },
  };
}
