/**
 * 채팅 한 줄의 모양과, 그 줄을 고치는 규칙.
 *
 * 화면에서 떼어 둔 이유는 하나다: 이 규칙들이 틀리면 **같은 답이 두 번 서거나**
 * 진행 중인 답이 사라진다. 사고가 났던 자리들(완결 push 와 진행분이 겹치는 자리,
 * 다른 기기의 턴, 도구 이벤트의 짝 맞추기)을 눈이 아니라 테스트로 지킨다.
 *
 * 규칙은 데스크톱 SessionStore 와 같다 — 도구·출처·오류는 **그 답변의 것**이고,
 * 말풍선 사이에 따로 떠다니는 줄이 아니다.
 */
import type { Citation, ToolEvent, XgenErrorInfo } from '@dex/protocol';

export type ChatRole = 'user' | 'assistant';

/** 함께 보낸 파일 — 원본은 서버 워크스페이스에 있고, 대화에는 무엇을 붙였는지만 남는다. */
export interface ChatAttachmentMark {
  name: string;
  kind: 'image' | 'file';
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  /** 함께 보낸 파일. */
  attachments?: ChatAttachmentMark[];
  /** 지난 대화에서 온 첨부 개수 — 원본은 서버에 있고 여기서는 사실만 남긴다. */
  attachmentCount?: number;
  /** 이 답변이 쓴 도구. 흐름에는 한 칸씩, 펼치면 전부. */
  tools?: ToolEvent[];
  citations?: Citation[];
  /** 실패한 답변 — 본문 대신 구조로 보여준다. */
  errorInfo?: XgenErrorInfo;
  streaming?: boolean;
  /** 사용자가 [정지] 로 끊은 턴. */
  interrupted?: boolean;
  /**
   * 다른 곳에서 도는 턴의 **진행분** — 우리가 받은 스트림이 아니라 서버 버퍼의
   * 스냅샷이다. 재연결마다 처음부터 다시 오므로 이어붙이지 않고 덮어쓴다.
   */
  remotePartial?: boolean;
  /** 다른 곳에서 도는 턴의 질문 — 완결 턴이 오면 그 턴으로 바뀐다(그대로 두면 두 번 보인다). */
  remoteQuestion?: boolean;
  /** 이 답이 서버에 남은 실행 한 건 — 같은 턴이 두 길(완결 행·종료 프레임)로 와도 한 번만 그린다. */
  ioId?: number;
  /** 표시용 시각(ms). */
  at: number;
}

let seq = 0;
export function newMessageId(): string {
  seq += 1;
  return `m${Date.now().toString(36)}-${seq}`;
}

function make(role: ChatRole, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: newMessageId(), role, text, at: Date.now(), ...extra };
}

export function userMessage(text: string, attachments?: ChatAttachmentMark[]): ChatMessage {
  return make('user', text, attachments && attachments.length > 0 ? { attachments } : {});
}

export function assistantPlaceholder(extra: Partial<ChatMessage> = {}): ChatMessage {
  return make('assistant', '', { streaming: true, tools: [], ...extra });
}

/** 지금 글자를 받고 있는 답변 — 없으면 -1. */
function streamingIndex(list: readonly ChatMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === 'assistant' && (m.streaming || m.remotePartial)) return i;
    if (m.role === 'user') break;
  }
  return -1;
}

function patchAt(list: readonly ChatMessage[], i: number, patch: Partial<ChatMessage>): ChatMessage[] {
  const next = list.slice();
  next[i] = { ...next[i], ...patch };
  return next;
}

/** 스트림 조각을 이어 붙인다. 받을 자리가 없으면 새 답변을 세운다. */
export function appendAssistantText(list: readonly ChatMessage[], chunk: string): ChatMessage[] {
  if (!chunk) return list as ChatMessage[];
  const i = streamingIndex(list);
  if (i < 0) return [...list, make('assistant', chunk, { streaming: true, tools: [] })];
  return patchAt(list, i, { text: list[i].text + chunk });
}

/**
 * 도구 이벤트를 **그 답변에** 붙인다.
 *
 * 같은 호출(tool_call→tool_start→tool_result)은 한 줄로 합친다 — 합치지 않으면
 * [전체 로그 · N건] 이 호출 수가 아니라 이벤트 수를 세어, 도구 하나를 쓴 답변이
 * 3건이라고 말한다. 짝 맞추기 기준은 정본(@dex/protocol)과 같다: 호출 id 우선,
 * 없으면 이름.
 */
export function attachTool(list: readonly ChatMessage[], ev: ToolEvent): ChatMessage[] {
  let i = streamingIndex(list);
  let base = list as ChatMessage[];
  if (i < 0) {
    base = [...list, assistantPlaceholder()];
    i = base.length - 1;
  }
  const tools = base[i].tools ? base[i].tools!.slice() : [];
  const id = ev.toolUseId || ev.runId;
  const at = id
    ? tools.findIndex((t) => (t.toolUseId || t.runId) === id)
    : tools.findIndex((t) => t.toolName === ev.toolName && t.eventType !== 'tool_result' && t.eventType !== 'tool_error');
  if (at >= 0) tools[at] = { ...tools[at], ...ev };
  else tools.push(ev);
  const citations = ev.citations?.length
    ? mergeCitations(base[i].citations, ev.citations)
    : base[i].citations;
  return patchAt(base, i, { tools, citations });
}

function mergeCitations(prev: Citation[] | undefined, next: Citation[]): Citation[] {
  const out = prev ? prev.slice() : [];
  for (const c of next) {
    const dup = out.some((x) => x.fileName === c.fileName && x.pageNumber === c.pageNumber);
    if (!dup) out.push(c);
  }
  return out;
}

/** 다른 곳에서 도는 턴의 진행분 — 한 말풍선을 통째로 덮어쓴다. */
export function setRemotePartial(list: readonly ChatMessage[], text: string): ChatMessage[] {
  const last = list[list.length - 1];
  if (last?.remotePartial) {
    if (last.text === text) return list as ChatMessage[];
    return patchAt(list, list.length - 1, { text });
  }
  return [...list, make('assistant', text, { remotePartial: true, tools: [] })];
}

/** 진행분 말풍선을 걷어낸다 — 완결 턴이 도착했을 때. */
export function dropRemotePartials(list: readonly ChatMessage[]): ChatMessage[] {
  return list.filter((m) => !m.remotePartial);
}

function isTemporary(m: ChatMessage): boolean {
  return m.remotePartial === true || m.remoteQuestion === true;
}

/** 다른 곳에서 도는 턴의 시작 — 질문과 빈 진행분을 세운다. 앞 턴의 임시 말풍선은 받은 만큼으로 굳힌다. */
export function startRemoteTurn(list: readonly ChatMessage[], input: string): ChatMessage[] {
  const settled = list.flatMap((m): ChatMessage[] => {
    if (!isTemporary(m)) return [m];
    if (m.remotePartial && !m.text) return [];
    return [{ ...m, remotePartial: false, remoteQuestion: false, streaming: false }];
  });
  return [
    ...settled,
    make('user', input, { remoteQuestion: true }),
    make('assistant', '', { streaming: false, remotePartial: true, tools: [] }),
  ];
}

/**
 * 다른 곳에서 돈 턴이 **끝났다** — 완결 본문(완결 행 또는 종료 프레임)을 한 번만 넣는다.
 * 서버는 완결 행을 먼저, 종료를 나중에 보낸다. 어느 쪽이 먼저 와도 결과는 같다:
 * 진행분과 그 턴의 질문을 지우고 그 자리에 완결 턴을 넣는다. 이력이 이미 질문을 그렸으면
 * (도는 중에 연 대화) 답만 붙인다. 이미 그린 턴이면 null.
 */
export function completeRemoteTurn(
  list: readonly ChatMessage[],
  turn: { ioId?: number | null; input: string; output: string },
): ChatMessage[] | null {
  const ioId = turn.ioId || undefined;
  if (ioId && list.some((m) => m.role === 'assistant' && m.ioId === ioId && !m.remotePartial)) return null;
  const out = list.filter((m) => !isTemporary(m));
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  if (
    last?.role === 'assistant' && last.text === turn.output && prev?.role === 'user' && prev.text === turn.input &&
    out.length === list.length
  ) {
    if (!ioId || last.ioId) return null;
    return patchAt(out, out.length - 1, { ioId });
  }
  const answer = make('assistant', turn.output, ioId ? { ioId } : {});
  if (last?.role === 'user' && last.text === turn.input) return [...out, answer];
  return [...out, make('user', turn.input), answer];
}

/** 다른 곳의 턴을 그리는 중인가(임시 말풍선이 있다). */
export function hasRemoteTurn(list: readonly ChatMessage[]): boolean {
  return list.some(isTemporary);
}

/** 스트림이 끝났다. 중단이면 그 사실도 남긴다. */
export function finishStreaming(
  list: readonly ChatMessage[],
  opts: { interrupted?: boolean } = {},
): ChatMessage[] {
  return list.map((m) =>
    m.streaming || m.remotePartial
      ? { ...m, streaming: false, remotePartial: false, interrupted: opts.interrupted || m.interrupted }
      : m,
  );
}

/**
 * 실패 — 도구 기록은 지우지 않는다.
 *
 * 무엇을 하다 실패했는지가 그 기록에 있다. 빈 답변 자리가 있으면 그 자리에
 * 오류를 앉히고, 없으면 새 줄을 세운다.
 */
export function setError(list: readonly ChatMessage[], info: XgenErrorInfo): ChatMessage[] {
  const i = streamingIndex(list);
  if (i >= 0 && !list[i].text) {
    return patchAt(list, i, { errorInfo: info, streaming: false, remotePartial: false });
  }
  return [...finishStreaming(list), make('assistant', '', { errorInfo: info })];
}

/** 지난 대화 한 턴 → 말풍선 둘. 빈 쪽은 만들지 않는다. */
export function historyMessages(
  turns: readonly { input: string; output: string; attachments?: readonly unknown[] }[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    if (t.input) {
      out.push(
        make('user', t.input, t.attachments?.length ? { attachmentCount: t.attachments.length } : {}),
      );
    }
    if (t.output) out.push(make('assistant', t.output));
  }
  return out;
}

/** 이 답변에서 쓴 도구가 몇 건인가 — 합쳐진 호출 수. */
export function toolCount(m: ChatMessage): number {
  return m.tools?.length ?? 0;
}
