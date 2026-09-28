/**
 * 온스크린 진단 — 실기기에서 "왜 안 되는가"를 스크린샷 한 장으로 확정하기
 * 위한 최근 API/이벤트 기록. HttpClient 에 로깅 fetch 를 주입해 모든 REST
 * 호출의 (메서드·경로·상태·소요)만 남긴다. 응답 본문과 오류 문자열에는
 * 토큰이나 개인 데이터가 포함될 수 있으므로 기록하지 않는다.
 */

export interface DiagEntry {
  at: string;
  line: string;
}

const MAX = 40;
const entries: DiagEntry[] = [];
const listeners = new Set<() => void>();

export function diagLog(line: string): void {
  entries.push({ at: new Date().toISOString().slice(11, 19), line });
  if (entries.length > MAX) entries.shift();
  for (const l of [...listeners]) l();
}

export function diagEntries(): DiagEntry[] {
  return [...entries];
}

export function onDiag(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 전역 fetch 를 감싸 REST 왕복을 기록한다 (CapacitorHttp 패치 위에 얹힘). */
export function loggingFetch(input: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET';
  const path = (() => {
    try {
      return new URL(input).pathname;
    } catch {
      return input;
    }
  })();
  const started = Date.now();
  return (globalThis.fetch as typeof fetch)(input, init).then(
    (res) => {
      diagLog(`${method} ${path} → ${res.status} (${Date.now() - started}ms)`);
      return res;
    },
    (e) => {
      diagLog(`${method} ${path} → 실패 (${Date.now() - started}ms)`);
      throw e;
    },
  );
}
