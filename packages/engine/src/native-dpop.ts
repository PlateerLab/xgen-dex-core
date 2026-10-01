import { createHash, randomUUID, webcrypto } from 'node:crypto';
import type { NativePublicKey } from '@dex/protocol/native-platform-session';

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
export type NativeDpopSigner = (method: 'GET' | 'POST' | 'DELETE', htu: string, token: string, signal?: AbortSignal) => Promise<string>;
export function nativeKeyThumbprint(key: NativePublicKey): string {
  return createHash('sha256').update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })).digest('base64url');
}
/** Only the host-held nonextractable signing handle is used; no private key export. */
export function createNativeDpopSigner(key: CryptoKey, publicKey: NativePublicKey, origin: string): NativeDpopSigner {
  const algorithm = key.algorithm as EcKeyAlgorithm;
  if (key.type !== 'private' || key.extractable || algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256'
    || !key.usages.includes('sign')) throw new TypeError('A nonextractable P-256 signing key is required');
  const bound = new URL(origin);
  if (bound.protocol !== 'https:' || bound.origin !== origin) throw new TypeError('Expected a canonical HTTPS origin');
  const jwk = Object.freeze({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y });
  const json = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return async (method, htu, token, signal) => {
    signal?.throwIfAborted();
    const url = new URL(htu);
    if (!['GET', 'POST', 'DELETE'].includes(method)
      || (method === 'POST' && !/^\/api\/agentflow\/agent-sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:turns|stop)$/.test(url.pathname))
      || url.origin !== origin || url.username || url.password || url.search || url.hash
      || url.href !== htu || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 8192) {
      throw new TypeError('Invalid DPoP request binding');
    }
    const input = `${json({ typ: 'dpop+jwt', alg: 'ES256', jwk })}.${json({ jti: randomUUID(), htm: method, htu,
      iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') })}`;
    const signature = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(input)));
    signal?.throwIfAborted();
    if (signature.length !== 64) throw new TypeError('Expected an ES256 JOSE signature');
    return `${input}.${signature.toString('base64url')}`;
  };
}
