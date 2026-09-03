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
const LEGACY_JOB_PREFIX = '[영구 작업 결과 보고]';

/**
 * 과거 서버가 본문에 섞어 넣던 **LLM 지시문을 걷어낸다** — 지시문은 사용자
 * 화면(클릭 상세)에 노출되면 안 된다. 현행 서버는 지시문을 아예 넣지 않지만
 * (결과 + 최소 영어 사실 문구만), 이미 저장된 대화의 렌더 호환으로 남긴다.
 */
export function stripTriggerInstructions(body: string): string {
  let b = body;
  // 미래 호환 — 지시문 전용 블록.
  b = b.replace(/<trigger_instructions>[\s\S]*?<\/trigger_instructions>\s*/g, '');
  // 구형 sub-agent 안내 괄호 블록 (선두).
  b = b.replace(/^\s*\(당신이 위임했던 sub-agent 작업이 완료되었습니다\.[\s\S]*?\)\s*/, '');
  // 구형 schedule 지시 문장 (선두 한 문단).
  b = b.replace(/^\s*작업 '[^']*' 이 방금 실행되었다\. 아래 실행 결과를[\s\S]*?하지 마라\.\s*/, '');
  return b.trim();
}

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
      body: stripTriggerInstructions(stripped.slice(LEGACY_PREFIX.length)),
    };
  }
  if (stripped.startsWith(LEGACY_JOB_PREFIX)) {
    // 태그 도입 전의 영구 작업 보고 평문 — 트리거 행으로 정리한다.
    const rest = stripped.slice(LEGACY_JOB_PREFIX.length);
    const nameMatch = /작업 '([^']*)'/.exec(rest);
    return {
      kind: 'schedule',
      source: nameMatch?.[1] ?? '',
      body: stripTriggerInstructions(rest),
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
  const body = stripTriggerInstructions(
    (closeAt === -1 ? afterOpen : afterOpen.slice(0, closeAt)).trim(),
  );
  return { kind, source: attrs.source ?? '', body };
}

/** [Trigger] 행의 한 줄 라벨 — 전 앱이 같은 문구를 쓴다. */
export function triggerRowLabel(t: AgentTrigger): string {
  const kindLabel = t.kind === 'schedule' ? '작업' : t.kind === 'agent' ? '서브에이전트' : t.kind;
  return t.source ? `Trigger · ${kindLabel} · ${t.source}` : `Trigger · ${kindLabel}`;
}
