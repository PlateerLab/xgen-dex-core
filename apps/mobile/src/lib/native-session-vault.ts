import { sha256 } from 'js-sha256';
import { mobileJwtPart, mobileKeyThumbprint, type MobileDeviceIdentity, type MobileNativeContext } from './native-device-key';

export type MobileSessionPhase = 'ready' | 'login_pending' | 'refreshing' | 'logout_pending' | 'pending_takeover';
export interface MobilePlatformRecord {
  version: 1; platform: 'mobile'; origin: string; userId: string;
  installId: string; keyThumbprint: string; deviceId: string; sessionId: string | null;
  generation: string; phase: MobileSessionPhase;
  refreshToken: string | null; accessToken: string | null; accessExpiresAt: string | null;
}
export interface MobileSecureStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}
export class MobileVaultError extends Error { constructor() { super('휴대폰 세션의 보안 저장을 확인할 수 없습니다. 자동 복원·재시도를 중단했습니다.'); } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BYTES32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const locks = new Map<string, Promise<void>>();
function invalid(): never { throw new MobileVaultError(); }
export function mobileVaultScope(context: Pick<MobileNativeContext, 'origin' | 'userId'>): string {
  const url = new URL(context.origin);
  if (url.protocol !== 'https:' || url.origin !== context.origin || url.username || url.password || url.search || url.hash
    || !/^[1-9][0-9]{0,18}$/.test(context.userId)) invalid();
  return `xgen-mobile-platform-v1-${sha256(JSON.stringify(['mobile', context.origin, context.userId]))}`;
}
/** Local structural/binding validation; live trust, JWT signature and sid are enforced by the server. */
export function validateMobileRecord(value: unknown, context: Pick<MobileNativeContext, 'origin' | 'userId'>, identity: MobileDeviceIdentity): MobilePlatformRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const r = value as MobilePlatformRecord;
  if (Object.keys(r).sort().join(',') !== 'accessExpiresAt,accessToken,deviceId,generation,installId,keyThumbprint,origin,phase,platform,refreshToken,sessionId,userId,version'
    || r.version !== 1 || r.platform !== 'mobile' || r.origin !== context.origin || r.userId !== context.userId
    || r.installId !== identity.installId || r.keyThumbprint !== mobileKeyThumbprint(identity.publicKey)
    || typeof r.deviceId !== 'string' || !UUID.test(r.deviceId) || typeof r.generation !== 'string' || !UUID.test(r.generation)
    || (r.sessionId !== null && (typeof r.sessionId !== 'string' || !UUID.test(r.sessionId)))
    || !['ready', 'login_pending', 'refreshing', 'logout_pending', 'pending_takeover'].includes(r.phase)) invalid();
  if (r.phase !== 'ready') {
    if (r.refreshToken !== null || r.accessToken !== null || r.accessExpiresAt !== null
      || (r.phase === 'login_pending' ? r.sessionId !== null : r.sessionId === null)) invalid();
  } else {
    if (r.sessionId === null || typeof r.refreshToken !== 'string' || !BYTES32.test(r.refreshToken)
      || (r.accessToken === null) !== (r.accessExpiresAt === null)) invalid();
    if (r.accessToken !== null) {
      if (typeof r.accessToken !== 'string' || r.accessToken.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(r.accessToken)
        || typeof r.accessExpiresAt !== 'string' || r.accessExpiresAt.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(r.accessExpiresAt) || !Number.isFinite(Date.parse(r.accessExpiresAt))) invalid();
      try {
        const c = mobileJwtPart(r.accessToken.split('.')[1]!);
        if (c.sub !== context.userId || c.sid !== r.sessionId || c.device_id !== r.deviceId || c.platform_type !== 'mobile'
          || c.token_use !== 'platform_access' || !c.cnf || typeof c.cnf !== 'object' || (c.cnf as { jkt?: unknown }).jkt !== r.keyThumbprint
          || !Number.isSafeInteger(c.exp) || c.exp !== Math.floor(Date.parse(r.accessExpiresAt) / 1000)) invalid();
      } catch { invalid(); }
    }
  }
  return { ...r };
}
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void; const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current); await previous;
  try { return await work(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

/** All owners share an account lock. A durable token-free journal gates every credential read. */
export function createMobileSessionVault(secure: MobileSecureStorage) {
  async function remove(key: string): Promise<void> { await secure.deleteItemAsync(key); if (await secure.getItemAsync(key) !== null) invalid(); }
  async function put(key: string, value: MobilePlatformRecord): Promise<void> {
    const encoded = JSON.stringify(value); await secure.setItemAsync(key, encoded);
    if (await secure.getItemAsync(key) !== encoded) invalid();
  }
  async function load(key: string, context: MobileNativeContext, identity: MobileDeviceIdentity): Promise<MobilePlatformRecord | null> {
    const raw = await secure.getItemAsync(key); if (raw === null) return null;
    if (raw.length > 16384) invalid();
    try { return validateMobileRecord(JSON.parse(raw), context, identity); } catch { invalid(); }
  }
  return {
    async withIdentity<T>(context: MobileNativeContext, identity: MobileDeviceIdentity, check: () => void,
      work: (vault: { read(): Promise<MobilePlatformRecord | null>; begin(marker: MobilePlatformRecord): Promise<void>;
        commit(record: MobilePlatformRecord): Promise<void>; clear(): Promise<void> }) => Promise<T>): Promise<T> {
      const key = mobileVaultScope(context); const journal = `${key}-journal`;
      return serial(key, async () => {
        check();
        const guard = async <R>(run: () => Promise<R>): Promise<R> => {
          try { return await run(); } catch (e) { if (e instanceof MobileVaultError) throw e; check(); throw new MobileVaultError(); }
        };
        return work({
          read: () => guard(async () => {
            check(); const marker = await load(journal, context, identity); check();
            if (marker) { if (marker.phase === 'ready') invalid(); return marker; }
            const record = await load(key, context, identity); check(); return record;
          }),
          begin: (marker) => guard(async () => {
            check(); validateMobileRecord(marker, context, identity); if (marker.phase === 'ready') invalid();
            await put(journal, marker); check(); // verify durable blocker BEFORE deleting credentials or starting the wire
            await remove(key); check();
          }),
          commit: (record) => guard(async () => {
            check(); const marker = await load(journal, context, identity); check();
            if (!marker || marker.phase === 'ready' || marker.deviceId !== record.deviceId
              || (marker.sessionId !== null && marker.sessionId !== record.sessionId)) invalid();
            validateMobileRecord(record, context, identity);
            await put(key, record); check(); // cancellation/crash here keeps the journal; no old credential fallback
            await remove(journal); check();
          }),
          clear: () => guard(async () => { check(); await remove(key); check(); await remove(journal); check(); }),
        });
      });
    },
    /** Account-scoped local erasure also works with a missing/corrupted hardware key. It never calls the server. */
    async forget(context: MobileNativeContext, check: () => void): Promise<void> {
      const key = mobileVaultScope(context);
      return serial(key, async () => {
        try { check(); await remove(key); check(); await remove(`${key}-journal`); check(); }
        catch (e) { if (e instanceof MobileVaultError) throw e; check(); throw new MobileVaultError(); }
      });
    },
  };
}
