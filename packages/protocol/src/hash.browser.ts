/** Browser entry: never import Node built-ins into web or mobile bundles. */
export async function sha256Hex(plaintext: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error('Secure Web Crypto is unavailable. Use HTTPS or localhost.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
