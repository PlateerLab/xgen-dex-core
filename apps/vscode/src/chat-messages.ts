/**
 * 채팅 창의 줄 — 말풍선·도구 줄의 모양과, 지난 턴을 그 모양으로 옮기는 규칙.
 *
 * vscode 모듈에 기대지 않는 순수한 부분만 여기 둔다(웹뷰 공급자에서 떼어 냄) — 그래야 테스트가 직접 부른다.
 */
import { randomUUID } from 'node:crypto';
import {
  AWAITING_ANSWER_LABEL,
  awaitingAnswer,
  parseAgentTrigger,
  phaseLabel,
  phasesSettledAt,
  triggerRowLabel,
  visiblePhaseRows,
  type AgentTrigger,
  type GeneratedContentProvenance,
  type GeneratedContentVerification,
  type GeneratedContentVerificationStatus,
  type TurnPhaseRow,
} from '@dex/protocol';
import type { ConversationSnapshot, ToolEvent } from '@dex/rpc';

export type MessageRole = 'user' | 'assistant' | 'activity' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  label: string;
  text: string;
  /** user — 이 턴이 Job/sub-agent 트리거 주입이면 렌더용 파싱 결과.
   *  webview 는 이 필드가 있으면 말풍선 대신 [Trigger] 행을 그린다. */
  trigger?: AgentTrigger & { rowLabel: string };
  /** assistant — 이 답변에서 쓴 도구 이벤트 전부 (전체 로그의 원천, 수신 순). */
  tools?: ToolEvent[];
  /** activity — 클릭하면 열 전체 로그의 위치 (assistant 메시지 id + tools 인덱스). */
  toolRef?: { assistantId: string; index: number };
  /**
   * assistant. 답의 첫 글자 전에 서버가 하는 준비 단계 줄(turn_phase). 그릴 때마다 확장이 계산해 싣는다
   * (:func:`phaseLines`). 있으면 웹뷰가 점 대신 도구 줄 모양으로 그린다.
   */
  phaseLines?: PhaseLine[];
  /** 확장 프로세스 전용. proof는 webview 상태로 보내지 않는다. */
  generatedContent?: GeneratedContentProvenance[];
  malformedGeneratedContent?: boolean;
  provenanceFinal?: boolean;
  provenanceCheck?: GeneratedContentVerificationStatus | 'checking' | 'failed';
}

export interface ChatMessageView extends Omit<ChatMessage, 'generatedContent' | 'malformedGeneratedContent' | 'provenanceFinal' | 'provenanceCheck'> {
  provenance?: {
    label: string;
    status: GeneratedContentVerificationStatus | 'declared' | 'missing' | 'malformed' | 'checking' | 'failed';
    canVerify: boolean;
    verified: boolean;
  };
}

export type TextVerificationCandidate =
  | { ok: true; proof: string | null; text: string }
  | { ok: false; reason: 'malformed' | 'media_only' | 'ambiguous' };

export function textVerificationCandidate(message: ChatMessage): TextVerificationCandidate {
  if (message.malformedGeneratedContent) return { ok: false, reason: 'malformed' };
  const declarations = message.generatedContent ?? [];
  if (declarations.length === 0) return { ok: true, proof: null, text: message.text };
  const text = declarations.filter((item) => item.content_type === 'text/plain' && !item.artifact_path);
  if (text.length === 0) return { ok: false, reason: 'media_only' };
  if (text.length !== 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, proof: text[0].proof, text: message.text };
}

/** Run a verifier against the captured visible text and discard a late/stale result. */
export async function verifyMessageProvenance(
  message: ChatMessage,
  verify: (proof: string | null, text: string) => Promise<GeneratedContentVerification>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const candidate = textVerificationCandidate(message);
  if (!candidate.ok || !message.provenanceFinal) return false;
  const expectedText = candidate.text;
  message.provenanceCheck = 'checking';
  try {
    const result = await verify(candidate.proof, expectedText);
    if (!isCurrent() || message.text !== expectedText) return false;
    message.provenanceCheck = result.status;
  } catch {
    if (!isCurrent() || message.text !== expectedText) return false;
    message.provenanceCheck = 'failed';
  }
  return true;
}

function provenanceView(message: ChatMessage): ChatMessageView['provenance'] {
  const checked = message.provenanceCheck;
  if (checked === 'checking') return { label: '본문 출처 확인 중', status: checked, canVerify: false, verified: false };
  if (checked === 'verified') return { label: '본문 출처 확인됨', status: checked, canVerify: true, verified: true };
  if (checked === 'changed') return { label: '본문이 바뀌어 확인되지 않음', status: checked, canVerify: true, verified: false };
  if (checked === 'other_actor') return { label: '다른 계정의 서명', status: checked, canVerify: true, verified: false };
  if (checked === 'invalid') return { label: '서명이 유효하지 않음', status: checked, canVerify: true, verified: false };
  if (checked === 'unsigned_legacy') return { label: '서명 정보 없음', status: checked, canVerify: true, verified: false };
  if (checked === 'unavailable') return { label: '출처 확인을 사용할 수 없음', status: checked, canVerify: true, verified: false };
  if (checked === 'failed') return { label: '본문 출처 확인 실패', status: checked, canVerify: true, verified: false };
  if (message.malformedGeneratedContent) {
    return { label: '출처 정보 손상', status: 'malformed', canVerify: false, verified: false };
  }
  if ((message.generatedContent?.length ?? 0) > 0) {
    const candidate = textVerificationCandidate(message);
    return {
      label: candidate.ok ? 'AI 생성 표시 · 확인 전' : candidate.reason === 'media_only' ? 'AI 생성 표시(미디어) · 본문 확인 불가' : 'AI 생성 표시 · 본문 확인 불가',
      status: 'declared',
      canVerify: candidate.ok && message.provenanceFinal === true,
      verified: false,
    };
  }
  if (message.provenanceFinal) {
    return { label: '출처 정보 없음', status: 'missing', canVerify: true, verified: false };
  }
  return undefined;
}

/** Strip proofs before crossing into the untrusted webview. */
export function messageForView(message: ChatMessage): ChatMessageView {
  const {
    generatedContent: _generatedContent,
    malformedGeneratedContent: _malformedGeneratedContent,
    provenanceFinal: _provenanceFinal,
    provenanceCheck: _provenanceCheck,
    ...visible
  } = message;
  const provenance = provenanceView(message);
  return provenance ? { ...visible, provenance } : visible;
}

/** 준비 단계 한 줄. 웹뷰가 그대로 그린다. */
export interface PhaseLine {
  label: string;
  state: 'run' | 'ok' | 'err';
  /** 하는 중이면 경과 초, 끝났으면 걸린 시간, 실패면 "실패 · 걸린 시간". */
  time: string;
}

const fmtSec = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const fmtDuration = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;

/**
 * 준비 단계 → 웹뷰가 그릴 줄(웹·앱과 같은 규칙, @dex/protocol turn-phases). 0.7초 넘게 걸린 단계만,
 * 준비가 다 끝났는데 답이 아직이면 "답변을 준비하고 있습니다" 를 잇는다. 그릴 줄이 없으면 빈 목록.
 */
export function phaseLines(rows: readonly TurnPhaseRow[], now: number): PhaseLine[] {
  const visible = visiblePhaseRows(rows, now);
  if (visible.length === 0) return [];
  const out: PhaseLine[] = visible.map((r) => {
    const state = r.state === 'retry' ? 'run' : r.state;
    const time =
      state === 'run'
        ? fmtSec(now - r.startedAt)
        : state === 'err'
          ? `실패${r.durationMs !== undefined ? ` · ${fmtDuration(r.durationMs)}` : ''}`
          : fmtDuration(r.durationMs);
    return { label: phaseLabel(r), state, time };
  });
  if (awaitingAnswer(rows, now)) {
    out.push({ label: AWAITING_ANSWER_LABEL, state: 'run', time: fmtSec(now - phasesSettledAt(rows)) });
  }
  return out;
}

/**
 * 지난 턴 → 말풍선. 서버가 실행 기록에서 되살린 작업 과정(`process`)이 있으면 이 창이 스트림으로 받은 턴과
 * 같은 모양 — 답 아래 도구 줄(호출 하나에 한 줄, 마지막 상태)과 [전체 로그] 의 원천(`tools`) — 으로 그린다.
 * 다른 기기(휴대폰·웹)가 돌린 턴이 끝나면 이 창은 이력으로 다시 그리므로, 이것이 없으면 도구 없이 결과만 남는다.
 */
export function historyTurnMessages(turns: ConversationSnapshot['turns'], agentName: string): ChatMessage[] {
  return turns.flatMap((turn) => {
    const user = message('user', '나', turn.input);
    const assistant = message('assistant', agentName, turn.output);
    assistant.generatedContent = turn.generatedContent;
    assistant.malformedGeneratedContent = turn.malformedGeneratedContent;
    assistant.provenanceFinal = true;
    const tools = (turn.process ?? []).flatMap((item) => (item.kind === 'tool' ? [item.event] : []));
    if (tools.length === 0) return [user, assistant];
    assistant.tools = tools;
    // 호출 하나에 한 줄 — 짝은 호출 id 로, id 가 없으면 아직 끝나지 않은 같은 이름의 호출로(정본 규칙과 같다).
    const rows: Array<{ row: ChatMessage; id?: string; name: string; done: boolean }> = [];
    tools.forEach((event, index) => {
      const id = event.toolUseId || event.runId || undefined;
      const name = event.toolName ?? 'tool';
      const done = event.eventType === 'tool_result' || event.eventType === 'tool_error';
      const found = id
        ? rows.find((r) => r.id === id)
        : [...rows].reverse().find((r) => !r.id && r.name === name && !r.done);
      if (found) {
        found.row.text = describeTool(event);
        found.row.toolRef = { assistantId: assistant.id, index };
        found.done = done;
        return;
      }
      const row = message('activity', 'Tool', describeTool(event));
      row.toolRef = { assistantId: assistant.id, index };
      rows.push({ row, id, name, done });
    });
    return [user, assistant, ...rows.map((r) => r.row)];
  });
}

export function message(role: MessageRole, label: string, text: string): ChatMessage {
  const item: ChatMessage = { id: randomUUID(), role, label, text };
  if (role === 'user') {
    // Job/sub-agent 트리거 주입 턴 — 사용자 발화가 아니므로 렌더가 다르다.
    const trig = parseAgentTrigger(text);
    if (trig) item.trigger = { ...trig, rowLabel: triggerRowLabel(trig) };
  }
  return item;
}

export function describeTool(event: ToolEvent): string {
  const name = event.toolName || 'tool';
  if (event.eventType === 'tool_result') return `${name} · 완료${event.durationMs ? ` · ${event.durationMs}ms` : ''}`;
  if (event.eventType === 'tool_error') return `${name} · 실패${event.error ? ` · ${event.error}` : ''}`;
  return `${name} · 실행 중`;
}
