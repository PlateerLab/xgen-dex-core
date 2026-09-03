/**
 * 공통 트리거 규약 파서 — 서버(xgen-workflow editor/geny_bridge/trigger.py)와
 * 계약 동형.
 *
 * Job(영구 작업)/sub-agent 완료 결과는 사용자 발화와 같은 경로로 세션에
 * 주입되되, 텍스트가 이 태그로 감싸여 온다:
 *
 *     <agent_trigger:schedule source="야간 리포트">…</agent_trigger:schedule>
 *     <agent_trigger:agent source="worker-1">…</agent_trigger:agent>
 *
 * 클라이언트(CLI/VSCode/데스크톱/모바일/웹)는 사용자 턴 입력이 트리거면
 * 채팅 말풍선 대신 **한 줄 [Trigger] 행 + 클릭 상세**로 렌더한다.
 * 구형 [SUB_AGENT_RESULT] 평문 블록도 과거 대화 렌더 호환으로 인식한다.
 */

export interface AgentTrigger {
  /** 'schedule'(영구 작업) | 'agent'(sub-agent 보고) | 향후 종류. */
  kind: string;
  /** 무엇이 트리거했는가 — 작업 이름/sub-agent 이름. 없으면 ''. */
  source: string;
  /** 태그 안 원문 (지시문 + 결과) — 상세 보기의 내용. */
  body: string;
}

const OPEN_RE = /^\s*<agent_trigger:([a-z_]+)((?:\s+[a-zA-Z_-]+="[^"]*")*)\s*>/;
const LEGACY_PREFIX = '[SUB_AGENT_RESULT]';

function unescapeAttr(v: string): string {
  return v
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 사용자 턴 입력 → 트리거. 트리거가 아니면 null (일반 채팅으로 렌더). */
export function parseAgentTrigger(text: string | null | undefined): AgentTrigger | null {
  const raw = String(text ?? '');
  const stripped = raw.replace(/^\s+/, '');
  if (stripped.startsWith(LEGACY_PREFIX)) {
    return {
      kind: 'agent',
      source: 'sub-agent',
      body: stripped.slice(LEGACY_PREFIX.length).replace(/^\s+/, ''),
    };
  }
  const m = OPEN_RE.exec(stripped);
  if (!m) return null;
  const kind = m[1];
  const attrs: Record<string, string> = {};
  for (const am of m[2].matchAll(/([a-zA-Z_-]+)="([^"]*)"/g)) {
    attrs[am[1]] = unescapeAttr(am[2]);
  }
  const afterOpen = stripped.slice(m[0].length);
  const close = `</agent_trigger:${kind}>`;
  const closeAt = afterOpen.lastIndexOf(close);
  const body = (closeAt === -1 ? afterOpen : afterOpen.slice(0, closeAt)).trim();
  return { kind, source: attrs.source ?? '', body };
}

/** [Trigger] 행의 한 줄 라벨 — 전 앱이 같은 문구를 쓴다. */
export function triggerRowLabel(t: AgentTrigger): string {
  const kindLabel = t.kind === 'schedule' ? '작업' : t.kind === 'agent' ? '서브에이전트' : t.kind;
  return t.source ? `Trigger · ${kindLabel} · ${t.source}` : `Trigger · ${kindLabel}`;
}
