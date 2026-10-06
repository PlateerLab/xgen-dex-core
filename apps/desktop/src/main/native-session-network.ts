import { Agent, request } from 'node:https';
import * as tls from 'node:tls';
import { createNativeAgentSocketTransport, DexError, type NativeAgentSocketTransport } from '@dex/engine';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
const ATTACHMENT_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ATTACHMENT_CONTENT_PATH = new RegExp(`^/api/agentflow/agent-sessions/${ATTACHMENT_UUID}/attachments/${ATTACHMENT_UUID}/content$`);

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
    // Capture binary content before invoking any caller-supplied certificate provider.
    const body = init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || init.credentials !== 'omit' || init.redirect !== 'error'
      || (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array))) throw new DexError('usage_error', '네이티브 HTTPS 전송 설정을 확인하세요.');
    const headers = new Headers(init.headers);
    if (body instanceof Uint8Array && (init.method !== 'PUT' || url.search
      || !ATTACHMENT_CONTENT_PATH.test(url.pathname)
      || body.byteLength > 100 * 1024 * 1024 || headers.get('content-type') !== 'application/octet-stream')) {
      throw new DexError('usage_error', '첨부 파일의 원시 PUT 전송 설정을 확인하세요.');
    }
    if (headers.has('Cookie') || headers.has('Origin')) throw new DexError('usage_error', '네이티브 인증에는 브라우저 쿠키와 Origin을 보낼 수 없습니다.');
    // Node does not frame DELETE bodies automatically. Explicit framing also prevents
    // a caller-supplied length or transfer encoding from changing the signed request.
    headers.delete('Transfer-Encoding');
    headers.delete('Content-Length');
    if (typeof body === 'string') headers.set('Content-Length', String(Buffer.byteLength(body)));
    else if (body instanceof Uint8Array) headers.set('Content-Length', String(body.byteLength));
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
        req.end(body);
      });
    } finally { agent.destroy(); }
  };
}

export const desktopNativeFetch = createDesktopNativeFetch(systemCertificates);

/** The renderer can select only the operation; main owns the OS trust roots and WSS transport. */
export function createDesktopNativeSocket(origin: string): NativeAgentSocketTransport {
  return createNativeAgentSocketTransport(origin, { certificates: systemCertificates });
}
