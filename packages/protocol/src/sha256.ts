/**
 * SHA-256 of bytes — for upload chunk integrity (`X-Chunk-Sha256`).
 *
 * Web Crypto's `subtle` only exists in secure contexts (HTTPS / localhost). XGEN is
 * also deployed over plain HTTP inside closed networks, where `crypto.subtle` is
 * undefined and every chunk hash would fail. So: use `subtle` when present, else a
 * pure TypeScript FIPS 180-4 implementation (bit-identical; verified by the NIST
 * vectors in `test/sha256.test.ts`). No dependency, no Node built-ins — safe for web,
 * Electron, Node and React Native bundles.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function toHex(words: Uint32Array): string {
  let out = '';
  for (const w of words) out += w.toString(16).padStart(8, '0');
  return out;
}

/** Pure implementation. Processes the input in place (no padded copy of the whole buffer). */
export function sha256HexSync(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const block = (src: Uint8Array, off: number) => {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((src[j] << 24) | (src[j + 1] << 16) | (src[j + 2] << 8) | src[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
  };

  const full = bytes.length - (bytes.length % 64);
  for (let off = 0; off < full; off += 64) block(bytes, off);
  // Tail: remaining bytes + 0x80 + zero padding + 64-bit big-endian bit length.
  const rest = bytes.length - full;
  const tail = new Uint8Array(rest + 9 > 64 ? 128 : 64);
  tail.set(bytes.subarray(full));
  tail[rest] = 0x80;
  const bitLen = bytes.length * 8;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(tail.length - 4, bitLen >>> 0);
  for (let off = 0; off < tail.length; off += 64) block(tail, off);
  return toHex(h);
}

/** SHA-256 hex of bytes — Web Crypto when available (fast), otherwise the pure implementation. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Some embedded runtimes expose a stub `subtle` that rejects — fall through.
    }
  }
  return sha256HexSync(bytes);
}
