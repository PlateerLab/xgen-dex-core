import type { NativeDeviceIdentity } from '@dex/protocol/native-platform-session';
import type { NativeKeyScope } from './native-device-key-store';
import { nativeKeyThumbprint } from './native-dpop';
import { DexError } from './errors';

export type NativeSessionPhase = 'ready' | 'login_pending' | 'refreshing' | 'logout_pending' | 'pending_takeover';
export interface NativeSessionRecord extends NativeKeyScope {
  version: 1;
  installId: string;
  deviceId: string;
  sessionId: string | null;
  generation: string;
  phase: NativeSessionPhase;
  refreshToken: string | null;
  accessToken: string | null;
  accessExpiresAt: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BYTES32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
function invalid(): never { throw new DexError('credential_store_unavailable', '저장된 CLI 세션 범위 또는 자격증명을 확인할 수 없습니다.'); }
/** Structural/binding checks only. The server still verifies signature, trust, scopes and live sid state. */
export function validateNativeSession(value: unknown, scope: NativeKeyScope, identity: NativeDeviceIdentity): NativeSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const r = value as NativeSessionRecord;
  if (Object.keys(r).sort().join(',') !== 'accessExpiresAt,accessToken,deviceId,generation,installId,origin,phase,platform,refreshToken,sessionId,userId,version'
    || r.version !== 1 || r.origin !== scope.origin || r.platform !== scope.platform || r.userId !== scope.userId
    || r.installId !== identity.installId || !UUID.test(r.deviceId) || !UUID.test(r.generation)
    || (r.sessionId !== null && (typeof r.sessionId !== 'string' || !UUID.test(r.sessionId)))
    || !['ready', 'login_pending', 'refreshing', 'logout_pending', 'pending_takeover'].includes(r.phase)) invalid();
  if (r.phase !== 'ready') {
    if (r.refreshToken !== null || r.accessToken !== null || r.accessExpiresAt !== null
      || (r.phase !== 'login_pending' && r.sessionId === null)) invalid();
  } else {
    if (r.sessionId === null || typeof r.refreshToken !== 'string' || !BYTES32.test(r.refreshToken)
      || (r.accessToken === null) !== (r.accessExpiresAt === null)) invalid();
    if (r.accessToken !== null) {
      if (typeof r.accessToken !== 'string' || r.accessToken.length > 8192
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r.accessToken)
        || typeof r.accessExpiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(r.accessExpiresAt)) invalid();
      try {
        const claims = JSON.parse(Buffer.from(r.accessToken.split('.')[1], 'base64url').toString());
        if (claims.sub !== scope.userId || claims.sid !== r.sessionId || claims.device_id !== r.deviceId
          || claims.platform_type !== scope.platform || claims.cnf?.jkt !== nativeKeyThumbprint(identity.publicKey)
          || claims.token_use !== 'platform_access' || !Number.isSafeInteger(claims.exp)
          || claims.exp !== Math.floor(Date.parse(r.accessExpiresAt) / 1000)) invalid();
      } catch { invalid(); }
    }
  }
  return { ...r };
}
