import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { DexError } from './errors';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const invalid = () => new DexError('protocol_mismatch', '네이티브 공유 대화 응답을 확인할 수 없습니다.');
function decimal(value: string, min: number, max: number): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
}
function route(path: string): boolean {
  if (path === '/api/agentflow/me/agent-state' || new RegExp(`^/api/agentflow/agent-sessions/${UUID}/snapshot$`).test(path)) return true;
  const query = new RegExp(`^(?:/api/agentflow/me/agent-events|/api/agentflow/agent-sessions/${UUID}/(events|messages))\\?after_sequence=([0-9]+)&limit=([0-9]+)$`).exec(path);
  return !!query && decimal(query[2]!, 0, Number.MAX_SAFE_INTEGER) && decimal(query[3]!, 1, query[1] === 'messages' ? 20 : 200);
}
/** A scoped read adapter for a host-provided system TLS fetch. No arbitrary routes or credentials. */
export function nativeConversationFetch(origin: string, fetchImpl: typeof fetch, check: () => Promise<void>): typeof fetch {
  return (async (input, init) => {
    init?.signal?.throwIfAborted();
    if (typeof input !== 'string' || !init || init.method !== 'GET' || init.body !== undefined || init.credentials !== 'omit'
      || init.redirect !== 'error' || init.cache !== 'no-store') throw invalid();
    const url = new URL(input); const path = `${url.pathname}${url.search}`;
    if (url.origin !== origin || url.username || url.password || url.hash || input !== `${origin}${path}` || !route(path)) throw invalid();
    const headers = new Headers(init.headers);
    const names: string[] = []; headers.forEach((_value, name) => names.push(name));
    if (names.sort().join(',') !== 'accept,authorization,dpop' || headers.get('accept') !== 'application/json'
      || !headers.get('authorization')?.startsWith('DPoP ') || !JWT.test(headers.get('authorization')!.slice(5))
      || headers.get('authorization')!.length > 8197 || !JWT.test(headers.get('dpop') ?? '') || headers.get('dpop')!.length > 8192) throw invalid();
    await check();
    let response: Response;
    try { response = await fetchImpl(input, init); }
    catch { init.signal?.throwIfAborted(); throw new NativePlatformTransportError(); }
    try { await check(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    if (response.redirected || (response.url && response.url !== input) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined); throw invalid();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status, ok: false } as Response;
    }
    const cap = url.pathname.endsWith('/messages') ? 1048576 : 65536;
    return { status: response.status, ok: true, json: async () => {
      try { await check(); }
      catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > cap)) { void response.body?.cancel().catch(() => undefined); throw invalid(); }
      const reader = response.body?.getReader(); if (!reader) throw invalid();
      const stop = () => { void reader.cancel().catch(() => undefined); }; init.signal?.addEventListener('abort', stop, { once: true });
      const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let text = '';
      try {
        for (;;) {
          await check(); const chunk = await reader.read(); await check(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > cap) throw invalid();
          try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw invalid(); }
        }
        try { text += decoder.decode(); return JSON.parse(text) as unknown; } catch { throw invalid(); }
      } catch (error) {
        stop(); init.signal?.throwIfAborted();
        if (error instanceof DexError) throw error; throw new NativePlatformTransportError();
      } finally { init.signal?.removeEventListener('abort', stop); reader.releaseLock(); }
    } } as Response;
  }) as typeof fetch;
}
