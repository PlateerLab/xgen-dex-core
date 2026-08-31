// 실행 중인 로컬 MCP 카탈로그와 도구 호출 이력을 메모리에만 보관한다.

const MAX_ENTRIES = 200;

export type McpRuntimeLogKind = 'catalog' | 'call' | 'result';

export interface McpRuntimeLogEntry {
  id: number;
  timestamp: number;
  kind: McpRuntimeLogKind;
  message: string;
  requestId?: string;
  server?: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
}

const entries: McpRuntimeLogEntry[] = [];
const listeners = new Set<(entry: McpRuntimeLogEntry) => void>();
let sequence = 0;

// 로컬 도구 실행·호출·결과는 **항상** 감사 기록한다 (기본 꺼져 있던 문제 수정 —
// 로컬 셸/도구가 사용자 PC 에서 무엇을 했는지는 mcpDebug 여부와 무관하게 남겨야 한다).
// 이 토글은 하위호환용 no-op 이다.
export function setMcpRuntimeLogEnabled(_next: boolean): void {
  /* no-op — 기록은 항상 유지된다. */
}

export function appendMcpRuntimeLog(
  entry: Omit<McpRuntimeLogEntry, 'id' | 'timestamp'>,
): McpRuntimeLogEntry | null {
  const next: McpRuntimeLogEntry = {
    ...entry,
    id: ++sequence,
    timestamp: Date.now(),
  };
  entries.push(next);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* UI 구독자 하나가 MCP 실행을 방해하지 않는다. */
    }
  }
  return next;
}

export function mcpRuntimeLogs(): McpRuntimeLogEntry[] {
  return [...entries];
}

export function clearMcpRuntimeLogs(): void {
  entries.length = 0;
}

export function onMcpRuntimeLog(listener: (entry: McpRuntimeLogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
