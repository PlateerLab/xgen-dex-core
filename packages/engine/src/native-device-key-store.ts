import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { NativeDeviceIdentity, NativePublicKey } from '@dex/protocol/native-platform-session';
import { createNativeDeviceSigner } from '@dex/protocol/native-device-proof';
import { DexError } from './errors';
import { createNativeDpopSigner, type NativeDpopSigner } from './native-dpop';
import { validateNativeSession, type NativeSessionRecord } from './native-session-record';

const SERVICE = 'xgen-dex-native-device';
const SESSION_SERVICE = 'xgen-dex-native-session';
const subtle = webcrypto.subtle as unknown as SubtleCrypto;
export interface NativeKeyScope { origin: string; userId: string; platform: 'cli' | 'desktop' | 'vscode' }
export interface NativeKeychain {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}
export interface NativeDeviceKeyStoreOptions {
  /** Only process metadata is written here. Keys never go to a file. */
  lockDirectory?: string;
  keychain?: () => Promise<NativeKeychain>;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
interface RecordV1 {
  version: 1;
  origin: string;
  userId: string;
  platform: NativeKeyScope['platform'];
  installId: string;
  publicKey: NativePublicKey;
  privateKeyPkcs8: string;
}
export interface NativeSessionVault {
  read(): Promise<NativeSessionRecord | null>;
  write(value: NativeSessionRecord): Promise<void>;
  clear(): Promise<void>;
}
interface RestoredIdentity { identity: NativeDeviceIdentity; signProof: NativeDpopSigner }
function unavailable(): DexError {
  return new DexError('credential_store_unavailable', '네이티브 기기 키에는 사용 가능한 OS 키체인이 필요합니다. 파일 저장으로 전환하지 않습니다.');
}
export function nativeKeyScope(value: NativeKeyScope): NativeKeyScope {
  const url = new URL(value.origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || !['cli', 'desktop', 'vscode'].includes(value.platform)
    || !/^[1-9][0-9]{0,9}$/.test(value.userId) || Number(value.userId) > 2147483647) {
    throw new DexError('config_invalid', 'HTTPS origin과 검증된 네이티브 계정 ID가 필요합니다.');
  }
  return { origin: url.origin, userId: value.userId, platform: value.platform };
}
function account(scope: NativeKeyScope): string {
  return createHash('sha256').update(JSON.stringify([1, scope.origin, scope.platform, scope.userId])).digest('hex');
}
async function loadKeychain(): Promise<NativeKeychain> {
  try {
    const module = await import('keytar');
    const keychain = (module.default ?? module) as NativeKeychain;
    if (!keychain.getPassword || !keychain.setPassword || !keychain.deletePassword) throw unavailable();
    return keychain;
  } catch { throw unavailable(); }
}
async function restore(raw: string, scope: NativeKeyScope): Promise<RestoredIdentity> {
  try {
    if (raw.length > 8192) throw unavailable();
    const value = JSON.parse(raw) as RecordV1;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'installId,origin,platform,privateKeyPkcs8,publicKey,userId,version'
      || value.version !== 1 || value.origin !== scope.origin || value.userId !== scope.userId || value.platform !== scope.platform
      || typeof value.installId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.installId)
      || typeof value.privateKeyPkcs8 !== 'string') throw unavailable();
    const key = value.publicKey;
    const bytes32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
    if (!key || Object.keys(key).sort().join(',') !== 'crv,kty,x,y' || key.kty !== 'EC' || key.crv !== 'P-256'
      || typeof key.x !== 'string' || typeof key.y !== 'string' || !bytes32.test(key.x) || !bytes32.test(key.y)) throw unavailable();
    const der = Uint8Array.from(Buffer.from(value.privateKeyPkcs8, 'base64'));
    if (der.length < 64 || der.length > 512 || Buffer.from(der).toString('base64') !== value.privateKeyPkcs8) throw unavailable();
    let privateKey: CryptoKey;
    try { privateKey = await subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
    finally { der.fill(0); }
    const publicKey = await subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const probe = randomBytes(32);
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
    if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, probe)) throw unavailable();
    return { identity: { installId: value.installId, publicKey: Object.freeze({ ...key }), signChallenge: createNativeDeviceSigner(privateKey, subtle) },
      signProof: createNativeDpopSigner(privateKey, key, scope.origin) };
  } catch { throw unavailable(); }
}
async function create(scope: NativeKeyScope): Promise<string> {
  // Software key: exported once into OS keychain storage, then imported as a nonextractable signing handle.
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);
  const der = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  try {
    const value: RecordV1 = { version: 1, ...scope, installId: randomUUID(),
      publicKey: { kty: 'EC', crv: 'P-256', x: publicKey.x!, y: publicKey.y! }, privateKeyPkcs8: Buffer.from(der).toString('base64') };
    return JSON.stringify(value);
  } finally { der.fill(0); }
}

/** Contention is distinct from an unavailable vault; readers may wait without bypassing this lock. */
export class NativeDeviceOperationBusy extends DexError {
  constructor() { super('credential_store_unavailable', '이 계정·플랫폼의 기기 작업이 이미 진행 중이거나 중단된 작업의 잠금이 남아 있습니다.'); }
}

/** Keychain-only software keys, isolated by origin/account/platform. No silent regeneration or file fallback. */
export class NativeDeviceKeyStore {
  private readonly options: NativeDeviceKeyStoreOptions;
  private readonly pending = new Set<Promise<unknown>>();
  private quarantined = false;
  constructor(options: NativeDeviceKeyStoreOptions = {}) { this.options = options; }
  private async call<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const tracked = work.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    try {
      return await Promise.race([tracked, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.quarantined = true; reject(unavailable()); }, this.options.timeoutMs ?? 2000);
      })]);
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); }
  }
  private async locked<T>(input: NativeKeyScope, run: (scope: NativeKeyScope, vault: NativeKeychain, account: string) => Promise<T>): Promise<T> {
    const scope = nativeKeyScope(input);
    if (this.quarantined || (this.options.env ?? process.env).DEX_NO_KEYCHAIN === '1') throw unavailable();
    // OS keychain scope does not depend on a CLI config folder; neither may its process lock.
    const directory = this.options.lockDirectory ?? join(homedir(), '.xgen-dex-native-device-locks');
    try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
    catch { throw unavailable(); }
    const name = account(scope);
    const path = join(directory, `${name}.lock`);
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new NativeDeviceOperationBusy();
      }
      throw unavailable();
    }
    const release = async () => { await handle.close(); await unlink(path); };
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const vault = await this.call((this.options.keychain ?? loadKeychain)());
      return await run(scope, vault, name);
    } finally {
      if (this.quarantined && this.pending.size) {
        // Timeout does not cancel native keychain work. Hold the cross-process lock until it really settles.
        void Promise.allSettled([...this.pending]).then(release).catch(() => {});
      } else await release();
    }
  }
  async withIdentity<T>(scope: NativeKeyScope, createIfMissing: boolean, work: (identity: NativeDeviceIdentity) => Promise<T>): Promise<T> {
    return this.locked(scope, async (normalized, vault, name) => {
      let raw = await this.call(vault.getPassword(SERVICE, name));
      if (raw === null) {
        if (!createIfMissing) throw new DexError('not_found', '해당 플랫폼의 기기 키가 없습니다. 먼저 기기를 등록하세요.');
        raw = await create(normalized);
        await this.call(vault.setPassword(SERVICE, name, raw));
        const persisted = await this.call(vault.getPassword(SERVICE, name));
        if (persisted !== raw) throw unavailable();
      }
      return work((await restore(raw, normalized)).identity);
    });
  }
  /** Same account/install lock as enrollment. Session credentials never use the legacy file store. */
  async withSession<T>(scope: NativeKeyScope,
    work: (identity: NativeDeviceIdentity, signProof: NativeDpopSigner, session: NativeSessionVault) => Promise<T>): Promise<T> {
    return this.locked(scope, async (normalized, vault, name) => {
      const raw = await this.call(vault.getPassword(SERVICE, name));
      if (raw === null) throw new DexError('not_found', '해당 플랫폼의 기기 키가 없습니다. 먼저 기기 등록과 승인을 완료하세요.');
      const { identity, signProof } = await restore(raw, normalized);
      let open = true;
      const check = () => { if (!open || this.quarantined) throw unavailable(); };
      const session: NativeSessionVault = {
        read: async () => {
          check();
          const value = await this.call(vault.getPassword(SESSION_SERVICE, name));
          if (value === null) return null;
          try {
            if (value.length > 12000) throw unavailable();
            return validateNativeSession(JSON.parse(value), normalized, identity);
          } catch { throw unavailable(); }
        },
        write: async (value) => {
          check();
          const encoded = JSON.stringify(validateNativeSession(value, normalized, identity));
          await this.call(vault.setPassword(SESSION_SERVICE, name, encoded));
          if (await this.call(vault.getPassword(SESSION_SERVICE, name)) !== encoded) throw unavailable();
        },
        clear: async () => {
          check();
          await this.call(vault.deletePassword(SESSION_SERVICE, name));
          if (await this.call(vault.getPassword(SESSION_SERVICE, name)) !== null) throw unavailable();
        },
      };
      try {
        return await work(identity, async (...args) => { check(); return signProof(...args); }, session);
      } finally { open = false; }
    });
  }
  /** Local key deletion only. Call after server-side device revocation; it does not revoke a server device. */
  async remove(scope: NativeKeyScope): Promise<void> {
    return this.locked(scope, async (_normalized, vault, name) => { await this.call(vault.deletePassword(SERVICE, name)); });
  }
}
