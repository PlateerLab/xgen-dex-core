import { validateStopAgentTurn, validateSubmitAgentTurn } from '@dex/protocol/agent-session-mutation';
import { validateCreateAgentSession, validateSwitchAgentFocus } from '@dex/protocol/agent-session-lifecycle';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { DexError } from './errors';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const invalid = () => new DexError('protocol_mismatch', '네이티브 대화 송신 경계를 확인할 수 없습니다.');
/** Exact native Agent Session write routes only. The caller owns the scoped vault and never retries a mutation. */
export function nativeAgentMutationFetch(origin: string, fetchImpl: typeof fetch, check: () => Promise<void>): typeof fetch {
  try {
    const configured = new URL(origin);
    if (configured.protocol !== 'https:' || origin !== configured.origin) throw invalid();
  } catch { throw invalid(); }
  return (async (input, init) => {
    // Capture the exact validated request before an asynchronous vault check can yield.
    if (init) init = { method: init.method, headers: new Headers(init.headers), body: init.body,
      credentials: init.credentials, redirect: init.redirect, cache: init.cache, signal: init.signal };
    init?.signal?.throwIfAborted();
    if (typeof input !== 'string' || !init || (init.method !== 'POST' && init.method !== 'PUT') || typeof init.body !== 'string'
      || init.credentials !== 'omit' || init.redirect !== 'error' || init.cache !== 'no-store') throw invalid();
    const url = new URL(input);
    const turn = init.method === 'POST'
      ? new RegExp(`^/api/agentflow/agent-sessions/(${UUID})/(turns|stop)$`).exec(url.pathname)
      : null;
    const create = init.method === 'POST' && url.pathname === '/api/agentflow/agent-sessions';
    const focus = init.method === 'PUT' && url.pathname === '/api/agentflow/me/agent-state';
    if (url.origin !== origin || url.username || url.password || url.hash || url.search
      || input !== `${origin}${url.pathname}` || (!turn && !create && !focus) || Buffer.byteLength(init.body) > 2 * 1024 * 1024) throw invalid();
    try {
      const body = JSON.parse(init.body) as unknown;
      if (turn?.[2] === 'turns') validateSubmitAgentTurn(turn[1]!, body);
      else if (turn) validateStopAgentTurn(turn[1]!, body);
      else if (create) validateCreateAgentSession(body);
      else validateSwitchAgentFocus(body);
    } catch { throw invalid(); }
    const headers = new Headers(init.headers); const names: string[] = [];
    headers.forEach((_value, name) => names.push(name));
    if (names.sort().join(',') !== 'accept,authorization,content-type,dpop' || headers.get('accept') !== 'application/json'
      || headers.get('content-type') !== 'application/json' || !headers.get('authorization')?.startsWith('DPoP ')
      || !JWT.test(headers.get('authorization')!.slice(5)) || headers.get('authorization')!.length > 8197
      || !JWT.test(headers.get('dpop') ?? '') || headers.get('dpop')!.length > 8192) throw invalid();
    await check();
    let response: Response;
    try { response = await fetchImpl(input, init); }
    catch { init.signal?.throwIfAborted(); throw new NativePlatformTransportError(); }
    try { await check(); }
    catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    if (response.redirected || (response.url && response.url !== input) || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => undefined); throw invalid();
    }
    let used = false;
    return { status: response.status, ok: response.ok, json: async () => {
      if (used) throw invalid(); used = true;
      try { await check(); }
      catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65536)) {
        void response.body?.cancel().catch(() => undefined); throw invalid();
      }
      const reader = response.body?.getReader(); if (!reader) throw invalid();
      const stop = () => { void reader.cancel().catch(() => undefined); }; init.signal?.addEventListener('abort', stop, { once: true });
      const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0; let value = '';
      try {
        for (;;) {
          await check(); const chunk = await reader.read(); await check(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > 65536) throw invalid();
          try { value += decoder.decode(chunk.value, { stream: true }); } catch { throw invalid(); }
        }
        try { value += decoder.decode(); return JSON.parse(value) as unknown; } catch { throw invalid(); }
      } catch (error) {
        stop(); init.signal?.throwIfAborted();
        if (error instanceof DexError) throw error; throw new NativePlatformTransportError();
      } finally { init.signal?.removeEventListener('abort', stop); reader.releaseLock(); }
    }, body: response.body ? { cancel: () => response.body!.cancel() } : null } as Response;
  }) as typeof fetch;
}
