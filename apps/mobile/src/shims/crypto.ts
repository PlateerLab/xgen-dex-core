/**
 * WebCrypto shim — RN 에는 crypto.subtle 이 없다. @dex/protocol 의
 * sha256Hex(로그인 비밀번호 해시)가 쓰는 digest('SHA-256')만 순수 JS
 * (js-sha256)로 제공한다. 앱 진입점(index.js)에서 가장 먼저 로드된다.
 */
import { sha256 } from 'js-sha256';

const g = globalThis as { crypto?: { subtle?: unknown } };
const holder: { subtle?: unknown } = g.crypto ?? {};
if (!g.crypto) g.crypto = holder;
if (!holder.subtle) {
  holder.subtle = {
    async digest(algo: string, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
      if (String(algo).toUpperCase() !== 'SHA-256') {
        throw new Error(`지원하지 않는 digest: ${algo}`);
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return new Uint8Array(sha256.arrayBuffer(bytes)).buffer;
    },
  };
}
