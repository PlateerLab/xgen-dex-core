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
import { appendFlowItem, liveTurnFlow } from '@dex/protocol';
import type {
  Citation,
  HistoryAttachment,
  HistoryFlowItem,
  LiveTurnSnapshot,
  TimelineFlowItem,
  ToolEvent,
  TurnAttachment,
  XgenErrorInfo,
} from '@dex/protocol';

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
  /** 함께 보낸 파일 — 이 폰에서 보낸 것도, 다른 화면·지난 대화의 것도 같은 이름표로 그린다. */
  attachments?: ChatAttachmentMark[];
  /** 이 답변이 쓴 도구. 흐름에는 한 칸씩, 펼치면 전부. */
  tools?: ToolEvent[];
  /**
   * 글과 도구 사건이 **온 순서** — 작업 과정 타임라인이 "이 문장 다음에 이 도구" 를 그리는 근거.
   * 내 스트림, 다른 화면의 턴(전파·진행분), 지난 대화(서버가 되살린 과정)가 모두 여기로 모인다.
   */
  flow?: TimelineFlowItem[];
  /** 이 턴이 시작된 시각(ms) — 경과 시간. */
  startedAt?: number;
  /** 마지막으로 글·도구를 받은 시각(ms) — "다음 단계를 준비하고 있어요" 와 끝난 턴의 걸린 시간. */
  lastEventAt?: number;
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
  return make('assistant', '', { streaming: true, tools: [], startedAt: Date.now(), ...extra });
}

/** 질문에 붙은 파일 → 말풍선 이름표. 전파 프레임(TurnAttachment)도 지난 대화(HistoryAttachment)도 받는다. */
export function attachmentMarks(
  items: readonly (TurnAttachment | HistoryAttachment)[] | undefined,
): ChatAttachmentMark[] | undefined {
  if (!items || items.length === 0) return undefined;
  return items.map((a) => ({
    name: a.name,
    kind: 'kind' in a ? a.kind : a.type === 'picture' ? 'image' : 'file',
  }));
}

/**
 * 도구 사건을 호출 목록에 합친다 — 같은 호출(tool_call→tool_start→tool_result)은 한 줄.
 * 합치지 않으면 [전체 로그 · N건] 이 호출 수가 아니라 이벤트 수를 센다. 기준은 정본과 같다:
 * 호출 id 우선, 없으면 아직 안 끝난 같은 이름.
 */
function mergeTool(tools: readonly ToolEvent[], ev: ToolEvent): ToolEvent[] {
  const out = tools.slice();
  const id = ev.toolUseId || ev.runId;
  const at = id
    ? out.findIndex((t) => (t.toolUseId || t.runId) === id)
    : out.findIndex((t) => t.toolName === ev.toolName && t.eventType !== 'tool_result' && t.eventType !== 'tool_error');
  if (at >= 0) out[at] = { ...out[at], ...ev };
  else out.push(ev);
  return out;
}

/** 작업 과정 → 호출 목록(합친 것). 과정만 받은 턴(진행분·지난 대화)의 [전체 로그] 가 여기서 나온다. */
export function toolsFromFlow(flow: readonly TimelineFlowItem[]): ToolEvent[] {
  let tools: ToolEvent[] = [];
  for (const item of flow) if (item.kind === 'tool') tools = mergeTool(tools, item.event);
  return tools;
}

/**
 * 완결 본문에 작업 과정의 글을 맞춘다.
 *
 * 다른 화면의 턴은 전파로 받은 조각을 쌓은 것이라, 재연결 사이에 조각을 놓쳤거나 스냅샷이 늦었으면
 * 과정의 글이 완결 본문보다 짧다. 타임라인은 마지막 단계의 글을 답으로 그리므로, 그대로 두면 끝난 답이
 * 잘려 보인다. 마지막 도구까지의 글이 본문의 앞부분과 같으면 그 뒤를 본문으로 채운다. 맞출 수 없으면
 * (본문이 과정과 다르게 시작한다) 과정을 그대로 둔다.
 */
export function reconcileFlow(flow: readonly TimelineFlowItem[], output: string): TimelineFlowItem[] {
  const textOf = (items: readonly TimelineFlowItem[]): string =>
    items.map((f) => (f.kind === 'text' ? f.text : '')).join('');
  const all = textOf(flow);
  if (all === output) return flow.slice();
  const at = flow[flow.length - 1]?.at ?? 0;
  if (output.startsWith(all)) return appendFlowItem(flow, { kind: 'text', text: output.slice(all.length), at });
  let lastTool = -1;
  for (let i = flow.length - 1; i >= 0; i--) {
    if (flow[i].kind === 'tool') {
      lastTool = i;
      break;
    }
  }
  const head = flow.slice(0, lastTool + 1);
  const before = textOf(head);
  if (!output.startsWith(before)) return flow.slice();
  const rest = output.slice(before.length);
  return rest ? [...head, { kind: 'text', text: rest, at }] : head;
}

/** 글·도구 한 칸을 답변의 작업 과정에 붙이고 시각을 적는다. */
function withFlow(m: ChatMessage, item: TimelineFlowItem): Partial<ChatMessage> {
  return {
    flow: appendFlowItem(m.flow, item),
    startedAt: m.startedAt ?? item.at,
    lastEventAt: item.at,
  };
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
export function appendAssistantText(list: readonly ChatMessage[], chunk: string, now = Date.now()): ChatMessage[] {
  if (!chunk) return list as ChatMessage[];
  const item: TimelineFlowItem = { kind: 'text', text: chunk, at: now };
  const i = streamingIndex(list);
  if (i < 0) {
    const fresh = make('assistant', chunk, { streaming: true, tools: [] });
    return [...list, { ...fresh, ...withFlow(fresh, item) }];
  }
  return patchAt(list, i, { text: list[i].text + chunk, ...withFlow(list[i], item) });
}

/**
 * 도구 이벤트를 **그 답변에** 붙인다.
 *
 * 같은 호출(tool_call→tool_start→tool_result)은 한 줄로 합친다 — 합치지 않으면
 * [전체 로그 · N건] 이 호출 수가 아니라 이벤트 수를 세어, 도구 하나를 쓴 답변이
 * 3건이라고 말한다. 짝 맞추기 기준은 정본(@dex/protocol)과 같다: 호출 id 우선,
 * 없으면 이름.
 */
export function attachTool(list: readonly ChatMessage[], ev: ToolEvent, now = Date.now()): ChatMessage[] {
  let i = streamingIndex(list);
  let base = list as ChatMessage[];
  if (i < 0) {
    base = [...list, assistantPlaceholder()];
    i = base.length - 1;
  }
  const tools = mergeTool(base[i].tools ?? [], ev);
  const citations = ev.citations?.length
    ? mergeCitations(base[i].citations, ev.citations)
    : base[i].citations;
  return patchAt(base, i, { tools, citations, ...withFlow(base[i], { kind: 'tool', event: ev, at: now }) });
}

function mergeCitations(prev: Citation[] | undefined, next: Citation[]): Citation[] {
  const out = prev ? prev.slice() : [];
  for (const c of next) {
    const dup = out.some((x) => x.fileName === c.fileName && x.pageNumber === c.pageNumber);
    if (!dup) out.push(c);
  }
  return out;
}

/**
 * 다른 곳에서 도는 턴의 진행분 — 한 말풍선을 통째로 덮어쓴다(글·작업 과정·도구 모두).
 *
 * 스냅샷은 재연결마다 처음부터 다시 온다. 이어붙이면 같은 글이 여러 번 쌓이므로 덮어쓴다.
 * 예전에는 글만 넣고 도구는 버렸다 — 웹에서 도구를 24번 부르며 도는 턴이 폰에서는 글 몇 줄로만 보였다.
 */
export function setRemoteLive(list: readonly ChatMessage[], live: LiveTurnSnapshot): ChatMessage[] {
  const flow = liveTurnFlow(live);
  const patch: Partial<ChatMessage> = {
    text: live.text,
    flow,
    tools: toolsFromFlow(flow),
    startedAt: live.startedAt ?? flow[0]?.at,
    lastEventAt: flow[flow.length - 1]?.at ?? live.startedAt,
  };
  const i = remotePartialIndex(list);
  if (i >= 0) return patchAt(list, i, patch);
  return [...list, make('assistant', '', { remotePartial: true, ...patch })];
}

/** 다른 곳에서 도는 턴의 진행분 말풍선 자리 — 없으면 -1. */
function remotePartialIndex(list: readonly ChatMessage[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].remotePartial) return i;
  return -1;
}

/**
 * 다른 화면의 턴이 보낸 글·도구를 받을 자리를 마련한다.
 *
 * 받을 자리(진행분 말풍선)가 없는데 그냥 이어붙이면 **임시가 아닌** 답변이 새로 서고, 완결 턴이 와도
 * 그 답이 지워지지 않아 같은 답이 두 번 보인다. 도는 중에 대화를 열어 시작 프레임을 못 받은 경우다.
 */
export function ensureRemotePartial(list: readonly ChatMessage[]): ChatMessage[] {
  if (streamingIndex(list) >= 0) return list as ChatMessage[];
  return [...list, make('assistant', '', { remotePartial: true, tools: [] })];
}

/** 진행분 말풍선을 걷어낸다 — 완결 턴이 도착했을 때. */
export function dropRemotePartials(list: readonly ChatMessage[]): ChatMessage[] {
  return list.filter((m) => !m.remotePartial);
}

function isTemporary(m: ChatMessage): boolean {
  return m.remotePartial === true || m.remoteQuestion === true;
}

/** 다른 곳에서 도는 턴의 시작 — 질문과 빈 진행분을 세운다. 앞 턴의 임시 말풍선은 받은 만큼으로 굳힌다. */
export function startRemoteTurn(
  list: readonly ChatMessage[],
  input: string,
  attachments?: readonly TurnAttachment[],
  now = Date.now(),
): ChatMessage[] {
  const settled = list.flatMap((m): ChatMessage[] => {
    if (!isTemporary(m)) return [m];
    if (m.remotePartial && !m.text && !m.flow?.length) return [];
    return [{ ...m, remotePartial: false, remoteQuestion: false, streaming: false }];
  });
  const marks = attachmentMarks(attachments);
  return [
    ...settled,
    make('user', input, { remoteQuestion: true, ...(marks ? { attachments: marks } : {}) }),
    make('assistant', '', { streaming: false, remotePartial: true, tools: [], startedAt: now }),
  ];
}

/**
 * 이 폰이 보낸 턴의 실행 id 를 답에 붙인다 — 스트림이 `execution_io` 를 알려 줄 때. 데스크톱은 진작 붙이고
 * 있었는데 폰은 버려서, 내 턴 뒤에 생긴 소켓 구멍을 이력으로 메울 수 없었다(어디까지 그렸는지 모른다).
 * 붙일 답은 마지막 질문 뒤의 답(도는 중이거나 끊겨 진행분이 된 것, 막 끝난 것)이다. 바뀐 것이 없으면 null.
 */
export function markExecutionIo(list: readonly ChatMessage[], ioId: number): ChatMessage[] | null {
  if (!ioId || list.some((m) => m.ioId === ioId)) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && !m.ioId) return patchAt(list, i, { ioId });
  }
  return null;
}

/** 작업 과정에 도구가 있는가 — 글 조각만 있는 과정으로는 타임라인을 그리지 않는다. */
function hasToolFlow(m: Pick<ChatMessage, 'flow'> | undefined): boolean {
  return !!m?.flow?.some((f) => f.kind === 'tool');
}

/** 작업 과정의 도구 호출 수. */
function toolSteps(flow: readonly { kind: string }[] | undefined): number {
  return flow?.filter((f) => f.kind === 'tool').length ?? 0;
}

/**
 * 진행분이 쌓은 과정과 서버가 실행 기록에서 되살린 과정 중 무엇으로 답을 그리는가(데스크톱과 같다).
 *
 * 서버의 것이 정본이다 — 진행분은 이 폰이 받은 프레임만 쌓았으므로 끊긴 사이의 도구가 빠질 수 있다. 예전에는
 * 진행분에 도구가 하나라도 있으면 그것을 남겨, 빠진 단계가 그 답의 작업 과정에서 영영 사라졌다. 서버의 과정이
 * 진행분보다 도구가 적을 때만(기록이 아직 덜 쓰였다) 진행분을 쓴다.
 */
export function preferServerProcess(
  partialFlow: readonly { kind: string }[] | undefined,
  process: readonly HistoryFlowItem[] | undefined,
): boolean {
  if (!process?.length || !process.some((f) => f.kind === 'tool')) return false;
  return toolSteps(process) >= toolSteps(partialFlow);
}

/**
 * 서버가 실행 기록에서 되살린 작업 과정을 답에 붙인다 — 이력과 대화 소켓의 완결 행이 같은 모양으로 싣는다.
 * 이미 도구 과정이 있으면(이 폰이 진행 프레임으로 받았다) 그대로 둔다. 붙일 것이 없으면 같은 객체를 돌려준다.
 */
function withServerProcess(m: ChatMessage, process: readonly HistoryFlowItem[] | undefined): ChatMessage {
  if (!process?.length || hasToolFlow(m)) return m;
  const flow = process as TimelineFlowItem[];
  return {
    ...m,
    flow: flow.slice(),
    tools: m.tools?.length ? m.tools : toolsFromFlow(flow),
    startedAt: m.startedAt ?? flow[0].at,
    lastEventAt: m.lastEventAt ?? flow[flow.length - 1].at,
  };
}

/** 이 실행 id 의 답에 도구 과정이 없으면 서버의 과정을 붙인다. 바뀐 것이 없으면 null. */
export function attachProcessById(
  list: readonly ChatMessage[],
  ioId: number | null | undefined,
  process: readonly HistoryFlowItem[] | undefined,
): ChatMessage[] | null {
  if (!ioId || !process?.length) return null;
  const at = list.findIndex((m) => m.role === 'assistant' && m.ioId === ioId && !m.remotePartial);
  if (at < 0) return null;
  const patched = withServerProcess(list[at], process);
  if (patched === list[at]) return null;
  const out = list.slice();
  out[at] = patched;
  return out;
}

/**
 * 다른 곳에서 돈 턴이 **끝났다** — 완결 본문(완결 행 또는 종료 프레임)을 한 번만 넣는다.
 * 서버는 완결 행을 먼저, 종료를 나중에 보낸다. 어느 쪽이 먼저 와도 결과는 같다:
 * 진행분과 그 턴의 질문을 지우고 그 자리에 완결 턴을 넣는다. 이력이 이미 질문을 그렸으면
 * (도는 중에 연 대화) 답만 붙인다. 이미 그린 턴이면 null — 단 그 답에 도구 과정이 없고 이 행이 서버의
 * 과정을 실어 왔으면 그것만 붙인다.
 *
 * 작업 과정: 서버가 완결 행에 실어 온 과정(`process`)이 정본이다(preferServerProcess). 그것이 없거나 아직 덜
 * 쓰였으면 이 폰이 진행 프레임으로 쌓은 과정을 쓴다 — 결과만 남지 않는다(데스크톱과 같다, 2026-10-01).
 */
export function completeRemoteTurn(
  list: readonly ChatMessage[],
  turn: {
    ioId?: number | null;
    input: string;
    output: string;
    attachments?: readonly (TurnAttachment | HistoryAttachment)[];
    process?: readonly HistoryFlowItem[];
  },
): ChatMessage[] | null {
  const ioId = turn.ioId || undefined;
  if (ioId && list.some((m) => m.role === 'assistant' && m.ioId === ioId && !m.remotePartial)) {
    return attachProcessById(list, ioId, turn.process);
  }
  const out = list.filter((m) => !isTemporary(m));
  const last = out[out.length - 1];
  const prev = out[out.length - 2];
  if (
    last?.role === 'assistant' && last.text === turn.output && prev?.role === 'user' && prev.text === turn.input &&
    out.length === list.length
  ) {
    const filled = withServerProcess(ioId && !last.ioId ? { ...last, ioId } : last, turn.process);
    if (filled === last) return null;
    return patchAt(out, out.length - 1, filled);
  }
  // 진행분이 쌓아 온 작업 과정은 답에 그대로 남긴다 — 끝난 뒤에도 무엇을 했는지 펼쳐 본다(데스크톱과 같다).
  // 진행분에 도구가 없으면(놓쳤다) 서버가 실어 온 과정으로 채운다.
  const partial = list[remotePartialIndex(list)];
  const question = list.find((m) => m.remoteQuestion && m.text === turn.input);
  const live = !!partial?.flow?.length && !preferServerProcess(partial.flow, turn.process);
  const process: Partial<ChatMessage> = live && partial?.flow
    ? {
        flow: reconcileFlow(partial.flow, turn.output),
        tools: partial.tools?.length ? partial.tools : toolsFromFlow(partial.flow),
        citations: partial.citations,
        startedAt: partial.startedAt,
        lastEventAt: partial.lastEventAt,
      }
    : { citations: partial?.citations };
  let answer = make('assistant', turn.output, { ...process, ...(ioId ? { ioId } : {}) });
  if (!live) answer = withServerProcess(answer, turn.process);
  if (last?.role === 'user' && last.text === turn.input) return [...out, answer];
  const marks = question?.attachments ?? attachmentMarks(turn.attachments);
  return [...out, make('user', turn.input, marks ? { attachments: marks } : {}), answer];
}

/**
 * 대화 소켓에 **구멍**이 났다(끊겼다 다시 붙었거나 번호가 건너뛰었다) — 이력으로 메운다(데스크톱 mergeMissedTurns 와 같다).
 *
 * 끊긴 사이에 시작해 끝난 다른 화면의 턴은 어떤 프레임으로도 오지 않는다. 휴대폰은 화면을 끄고 켤 때마다
 * 소켓이 끊기므로 이 자리가 특히 잦다.
 *
 *   이미 그린 답   도구 과정이 없으면 서버의 과정을 붙인다.
 *   놓친 턴        알고 있는 가장 새 턴보다 뒤의 끝난 턴을 넣는다. 지금 다른 곳에서 도는 턴이 있으면(`remote`)
 *                  임시 말풍선은 그 턴의 것이라 그 앞에 끼우고, 없으면 임시는 놓친 턴의 남은 자리라
 *                  완결 규칙(completeRemoteTurn)으로 바꿔 끼운다.
 *   덧붙이지 않음  마지막 답에 실행 id 가 없으면 어느 행이 그것인지 모른다 — 두 번 그리느니 다음 열기에 맡긴다.
 *
 * 바뀐 것이 없으면 null.
 */
export function mergeMissedTurns(
  list: readonly ChatMessage[],
  turns: readonly {
    ioId?: number;
    input: string;
    output: string;
    attachments?: readonly HistoryAttachment[];
    process?: readonly HistoryFlowItem[];
  }[],
  remote: boolean,
): ChatMessage[] | null {
  let changed = false;
  const byIo = new Map<number, (typeof turns)[number]>();
  for (const t of turns) if (t.ioId) byIo.set(t.ioId, t);
  let out = list.map((m) => {
    if (m.role !== 'assistant' || !m.ioId || isTemporary(m)) return m;
    const next = withServerProcess(m, byIo.get(m.ioId)?.process);
    if (next !== m) changed = true;
    return next;
  });
  const answered = out.filter((m) => m.role === 'assistant' && !isTemporary(m));
  const lastAnswer = answered[answered.length - 1];
  if (lastAnswer && !lastAnswer.ioId) return changed ? out : null;
  const newest = answered.reduce((max, m) => Math.max(max, m.ioId ?? 0), 0);
  const missed = turns.filter((t) => (t.ioId ?? 0) > newest && t.output);
  if (missed.length === 0) return changed ? out : null;
  if (remote) {
    const at = out.findIndex(isTemporary);
    const rows = historyMessages(missed);
    return at >= 0 ? [...out.slice(0, at), ...rows, ...out.slice(at)] : [...out, ...rows];
  }
  for (const t of missed) {
    out = completeRemoteTurn(out, {
      ioId: t.ioId, input: t.input, output: t.output, process: t.process, attachments: t.attachments,
    }) ?? out;
  }
  return out;
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

/**
 * 지난 대화 한 턴 → 말풍선 둘. 빈 쪽은 만들지 않는다.
 *
 * 서버가 되살린 작업 과정(process)이 있으면 답에 붙인다 — 다른 기기에서 돈 턴도 타임라인으로 펼친다.
 * 첨부는 개수가 아니라 이름표로 그린다(이 폰에서 보낸 질문과 같은 모양).
 */
export function historyMessages(
  turns: readonly {
    ioId?: number;
    input: string;
    output: string;
    attachments?: readonly HistoryAttachment[];
    process?: readonly HistoryFlowItem[];
  }[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const t of turns) {
    const marks = attachmentMarks(t.attachments);
    if (t.input || marks) out.push(make('user', t.input, marks ? { attachments: marks } : {}));
    if (!t.output) continue;
    const flow = t.process?.length ? (t.process as TimelineFlowItem[]) : undefined;
    out.push(
      make('assistant', t.output, {
        ...(t.ioId ? { ioId: t.ioId } : {}),
        ...(flow
          ? { flow, tools: toolsFromFlow(flow), startedAt: flow[0].at, lastEventAt: flow[flow.length - 1].at }
          : {}),
      }),
    );
  }
  return out;
}

/**
 * 이력이 도착했다 — 그 사이 먼저 그려 둔 것과 합친다.
 *
 * 구독 확립의 진행분(또는 다른 화면의 턴 시작)이 이력 응답보다 먼저 올 수 있다. 예전에는 이력이
 * 통째로 덮어써서 도는 턴의 진행분이 사라졌다. 먼저 그린 것이 **다른 곳의 턴을 그린 임시 말풍선뿐**이면
 * 이력 뒤에 붙인다(이력이 이미 그린 질문은 빼고). 이 폰에서 보낸 턴이 이미 있으면 그대로 둔다.
 */
export function mergeHistory(history: readonly ChatMessage[], current: readonly ChatMessage[]): ChatMessage[] {
  if (current.length === 0) return history.slice();
  if (!current.every(isTemporary)) return current.slice();
  const tail = history[history.length - 1];
  const temps = current.filter(
    (m) => !(m.remoteQuestion && tail?.role === 'user' && tail.text === m.text),
  );
  return [...history, ...temps];
}

/** 이 답변에서 쓴 도구가 몇 건인가 — 합쳐진 호출 수. */
export function toolCount(m: ChatMessage): number {
  return m.tools?.length ?? 0;
}
