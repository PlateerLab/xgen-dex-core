import type { NativeDeviceProofPurpose } from './native-platform-session';

const PURPOSES: NativeDeviceProofPurpose[] = ['register', 'approval_request', 'login', 'native_refresh'];
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function json(value: object): string { return base64url(new TextEncoder().encode(JSON.stringify(value))); }

/** Optional WebCrypto signer. The host creates/stores the nonextractable key; this helper never exports it. */
export function createNativeDeviceSigner(privateKey: CryptoKey, subtle: SubtleCrypto = globalThis.crypto.subtle) {
  const algorithm = privateKey.algorithm as EcKeyAlgorithm;
  if (privateKey.type !== 'private' || privateKey.extractable || algorithm.name !== 'ECDSA'
    || algorithm.namedCurve !== 'P-256' || !privateKey.usages.includes('sign')) {
    throw new TypeError('A nonextractable P-256 signing key is required');
  }
  return async (purpose: NativeDeviceProofPurpose, challenge: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    if (!PURPOSES.includes(purpose) || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(challenge)) {
      throw new TypeError('Invalid native device proof purpose or challenge');
    }
    const input = `${json({ alg: 'ES256', typ: 'platform-device-proof+jwt' })}.${json({
      challenge, purpose, iat: Math.floor(Date.now() / 1000),
    })}`;
    const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input)));
    signal?.throwIfAborted();
    if (signature.length !== 64) throw new TypeError('Expected an ES256 JOSE signature');
    return `${input}.${base64url(signature)}`;
  };
}
