import { Agent, request } from 'node:https';
import * as tls from 'node:tls';
import { createNativeAgentSocketTransport, DexError, type NativeAgentSocketTransport } from '@dex/engine';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';

/** Native proofs/rotation must never be transparently replayed by Chromium's connection retry. */
function systemCertificates(): string[] {
  // Electron 43's Node runtime supports this API; older runtimes fail closed.
  const caRuntime = tls as unknown as { getCACertificates?: (type: 'default' | 'system') => string[] };
  if (!caRuntime.getCACertificates) throw new DexError('config_invalid', 'OS 인증서 검증을 지원하는 Desktop 런타임이 필요합니다.');
  return [...caRuntime.getCACertificates('default'), ...caRuntime.getCACertificates('system')];
}

/** The certificate provider is main-process code, never an IPC/renderer option. */
export function createDesktopNativeFetch(certificates: () => readonly string[]): typeof fetch {
  return async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new DexError('usage_error', '네이티브 요청 URL을 확인하세요.');
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || init.credentials !== 'omit' || init.redirect !== 'error'
      || (init.body !== undefined && typeof init.body !== 'string')) throw new DexError('usage_error', '네이티브 HTTPS 전송 설정을 확인하세요.');
    const headers = new Headers(init.headers);
    if (headers.has('Cookie') || headers.has('Origin')) throw new DexError('usage_error', '네이티브 인증에는 브라우저 쿠키와 Origin을 보낼 수 없습니다.');
    // Node does not frame DELETE bodies automatically. Explicit framing also prevents
    // a caller-supplied length or transfer encoding from changing the signed request.
    headers.delete('Transfer-Encoding');
    headers.delete('Content-Length');
    if (typeof init.body === 'string') headers.set('Content-Length', String(Buffer.byteLength(init.body)));
    init.signal?.throwIfAborted();
    const agent = new Agent({ keepAlive: false, rejectUnauthorized: true,
      ca: [...certificates()] });
    try {
      return await new Promise<Response>((resolve, reject) => {
        const fail = () => reject(init.signal?.aborted ? init.signal.reason : new NativePlatformTransportError());
        const req = request(url, { agent, method: init.method ?? 'GET', headers: Object.fromEntries(headers), signal: init.signal ?? undefined }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); fail(); return; }
          const chunks: Buffer[] = []; let length = 0;
          res.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) { res.destroy(); fail(); } else chunks.push(chunk);
          });
          res.on('error', fail); res.on('aborted', fail);
          res.on('end', () => {
            const status = res.statusCode ?? 500;
            try { resolve(new Response([204, 205].includes(status) ? null : Buffer.concat(chunks), { status })); }
            catch { fail(); }
          });
        });
        req.on('error', fail);
        req.end(init.body);
      });
    } finally { agent.destroy(); }
  };
}

export const desktopNativeFetch = createDesktopNativeFetch(systemCertificates);

/** The renderer can select only the operation; main owns the OS trust roots and WSS transport. */
export function createDesktopNativeSocket(origin: string): NativeAgentSocketTransport {
  return createNativeAgentSocketTransport(origin, { certificates: systemCertificates });
}
