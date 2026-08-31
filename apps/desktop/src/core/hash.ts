/**
 * Password hashing for XGEN login.
 *
 * The XGEN gateway compares the submitted password VERBATIM against the stored
 * `users.password_hash`, and the official frontend sends the SHA-256 hex digest
 * of the plaintext (never the plaintext itself). We must do the same, or login
 * always fails. Uses Web Crypto (available in Electron renderer, modern Node,
 * and browsers); no native dependency.
 */
async function subtle(): Promise<SubtleCrypto> {
  // Browser / Electron renderer: globalThis.crypto. Node (<20 has no global
  // crypto): fall back to the built-in webcrypto.
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g?.subtle) return g.subtle;
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle as unknown as SubtleCrypto;
}

export async function sha256Hex(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await (await subtle()).digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
