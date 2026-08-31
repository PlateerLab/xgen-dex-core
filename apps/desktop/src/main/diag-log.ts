/**
 * 진단 로그 — 사용자가 그대로 복사해 보낼 수 있는 최근 기록.
 *
 * 패키징된 Electron 앱에서 `console.log` 는 아무 데도 남지 않는다(터미널에서
 * 띄우지 않는 한). 마운트 실패처럼 **한 번에 재현하기 어려운 문제**는 그
 * 순간의 명령·종료코드·stderr 가 없으면 추측만 하게 된다.
 *
 * 그래서 링 버퍼 하나를 둔다: 메모리에만 있고(디스크에 시크릿을 남기지
 * 않는다), 최근 N 줄을 유지하며, UI 가 통째로 복사할 수 있다.
 *
 * 민감정보는 :func:`redact` 로 걸러 낸다 — 이 로그는 사용자가 그대로 붙여
 * 넣는 것이 목적이므로, 토큰이 섞여 나가면 그게 곧 유출이다.
 */

const MAX_LINES = 800

export interface DiagEntry {
  ts: number
  scope: string
  msg: string
}

const buffer: DiagEntry[] = []
const listeners = new Set<(e: DiagEntry) => void>()

/**
 * 로그 문자열에서 비밀을 지운다.
 *
 * WebDAV URL 에는 **접근 토큰이 경로에 들어 있다**(인증 대신 비밀 경로를
 * 쓰기 때문). 그 URL 이 그대로 로그에 남으면 사용자가 로그를 공유하는 순간
 * 자기 워크스페이스를 남에게 열어 주는 셈이다.
 */
export function redact(s: string): string {
  return String(s)
    // http://127.0.0.1:PORT/<token>/...  → 토큰만 가린다 (포트는 진단에 필요)
    .replace(/(https?:\/\/127\.0\.0\.1:\d+\/)[A-Za-z0-9_-]{12,}/g, '$1<token>')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>')
    .replace(/("?(?:access_token|refresh_token|password|api[_-]?key)"?\s*[:=]\s*)"?[^\s",}]+/gi,
      '$1<redacted>')
}

/** 한 줄 남긴다. `data` 는 JSON 으로 붙는다 (실패해도 로그를 깨지 않는다). */
export function diag(scope: string, msg: string, data?: unknown): void {
  let line = msg
  if (data !== undefined) {
    try {
      line += ` ${typeof data === 'string' ? data : JSON.stringify(data)}`
    } catch {
      line += ' [직렬화 불가]'
    }
  }
  const entry: DiagEntry = { ts: Date.now(), scope, msg: redact(line) }
  buffer.push(entry)
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES)
  // 개발 중 터미널에서도 보이게 (패키징본에서는 어차피 아무 데도 안 간다).
  // eslint-disable-next-line no-console
  console.log(`[${scope}] ${entry.msg}`)
  for (const l of listeners) {
    try {
      l(entry)
    } catch {
      /* 구독자 하나가 로깅을 깨지 않는다 */
    }
  }
}

export function onDiag(cb: (e: DiagEntry) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 사용자가 복사해 보낼 텍스트. */
export function diagText(): string {
  return buffer
    .map((e) => `${new Date(e.ts).toISOString()} [${e.scope}] ${e.msg}`)
    .join('\n')
}

export function diagEntries(): DiagEntry[] {
  return [...buffer]
}

export function clearDiag(): void {
  buffer.length = 0
}

/** 진단 머리말 — 환경이 안 적히면 로그를 받아도 절반은 추측이 된다. */
export function diagHeader(extra: Record<string, unknown> = {}): string {
  const os = require('os') as typeof import('os')
  const lines = [
    `platform : ${process.platform} ${process.arch}`,
    `os       : ${os.type()} ${os.release()}`,
    `node     : ${process.versions.node}  electron: ${process.versions.electron ?? '-'}`,
    ...Object.entries(extra).map(([k, v]) => `${k.padEnd(9)}: ${redact(String(v))}`),
  ]
  return lines.join('\n')
}
