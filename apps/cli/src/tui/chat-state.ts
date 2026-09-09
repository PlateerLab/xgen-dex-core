import { INTERRUPTED_TEXT, describeStreamError, formatErrorLine } from '@dex/protocol';
import type { ChatEvent, HistoryTurn } from '@dex/engine';

export type ChatMessageRole = 'user' | 'assistant' | 'activity' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  activityKey?: string;
}

export interface ChatState {
  interactionId?: string;
  messages: ChatMessage[];
  running: boolean;
  /**
   * 이 CLI 가 아니라 **다른 곳**(웹·앱·VSCode)에서 시작한 턴이 이 대화에서
   * 돌고 있는가. 서버 실행은 연결이 아니라 대화에 매여 있어서, 여기서 스트림을
   * 쥐고 있지 않아도 대화는 진행 중일 수 있다. 이때 작성기는 잠기지만
   * (같은 대화에서 두 실행이 겹치면 안 된다) 토큰은 흐르지 않는다 — 서버는
   * 진행 중인 턴을 재전송하지 않고, 완결된 턴만 히스토리에 남긴다.
   */
  remote: boolean;
  status?: string;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'history_loaded'; interactionId: string; turns: HistoryTurn[]; running?: boolean }
  | { type: 'remote_finished'; interactionId: string; turns: HistoryTurn[] }
  | { type: 'turn_started'; interactionId: string; input: string }
  | { type: 'event_received'; event: ChatEvent }
  | { type: 'turn_completed' }
  | { type: 'turn_cancelled' }
  | { type: 'turn_failed'; message: string }
  | {
      /** 대화 소켓 push — 서버가 주입한 완결 턴(트리거 반응). */
      type: 'server_turn';
      ioId: number;
      input: string;
      output: string;
    };

export const initialChatState: ChatState = { messages: [], running: false, remote: false };

function lastMessageIndex(
  messages: ChatMessage[],
  predicate: (message: ChatMessage) => boolean,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

function appendAssistant(messages: ChatMessage[], content: string): ChatMessage[] {
  const index = lastMessageIndex(messages, (message) => message.role === 'assistant');
  if (index < 0) {
    return [...messages, { id: `assistant-${messages.length}`, role: 'assistant', text: content }];
  }
  const next = [...messages];
  next[index] = { ...next[index], text: next[index].text + content };
  return next;
}

function upsertActivity(messages: ChatMessage[], key: string, text: string): ChatMessage[] {
  const index = lastMessageIndex(
    messages,
    (message) => message.role === 'activity' && message.activityKey === key,
  );
  const startsNewRun =
    index >= 0 && text.endsWith('실행 중') && !messages[index].text.endsWith('실행 중');
  if (index < 0 || startsNewRun) {
    return [
      ...messages,
      { id: `activity-${messages.length}`, role: 'activity', activityKey: key, text },
    ];
  }
  const next = [...messages];
  next[index] = { ...next[index], text };
  return next;
}

function eventState(state: ChatState, event: ChatEvent): ChatState {
  if (event.kind === 'text') return { ...state, messages: appendAssistant(state.messages, event.content) };
  if (event.kind === 'summary') {
    const assistantIndex = lastMessageIndex(state.messages, (message) => message.role === 'assistant');
    const assistant = assistantIndex >= 0 ? state.messages[assistantIndex] : undefined;
    return assistant?.text ? state : { ...state, messages: appendAssistant(state.messages, event.text) };
  }
  if (event.kind === 'tool') {
    const tool = event.event.toolName ?? 'tool';
    const key = event.event.runId ?? tool;
    const suffix = event.event.error
      ? `실패: ${event.event.error}`
      : event.event.eventType.includes('result')
        ? '완료'
        : '실행 중';
    return { ...state, messages: upsertActivity(state.messages, key, `${tool} · ${suffix}`) };
  }
  if (event.kind === 'node_status') {
    return { ...state, status: `${event.event.nodeId} · ${event.event.status}` };
  }
  if (event.kind === 'status') {
    return { ...state, status: event.detail ?? event.surface };
  }
  if (event.kind === 'quota') {
    return {
      ...state,
      messages: [
        ...state.messages,
        { id: `quota-${state.messages.length}`, role: 'system', text: `Quota ${event.level}` },
      ],
    };
  }
  if (event.kind === 'error') {
    return {
      ...state,
      running: false,
      remote: false,
      status: undefined,
      messages: [
        ...state.messages,
        {
          id: `error-${state.messages.length}`,
          role: 'system',
          // 원문이 아니라 사용자용 문구 — 코드가 붙어 있어 지원 문의가 가능하다.
          text: formatErrorLine(event.info ?? describeStreamError(event.detail)),
        },
      ],
    };
  }
  if (event.kind === 'detached') {
    // 스트림이 끊겼을 뿐 서버의 턴은 계속 돈다. 끝난 것으로 표시하면 받다 만
    // 조각이 최종 답이 되고, 진짜 답은 아무 데도 안 보인다.
    return {
      ...state,
      running: true,
      remote: true,
      status: '연결이 끊겼습니다 — 서버에서 계속 진행 중',
    };
  }
  if (event.kind === 'end') return { ...state, running: false, remote: false, status: undefined };
  return state;
}

function historyMessages(turns: HistoryTurn[]): ChatMessage[] {
  return turns.flatMap((turn, index) => [
    { id: `history-user-${index}`, role: 'user' as const, text: turn.input },
    { id: `history-assistant-${index}`, role: 'assistant' as const, text: turn.output },
  ]);
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'history_loaded':
      return {
        interactionId: action.interactionId,
        running: !!action.running,
        remote: !!action.running,
        status: action.running ? '다른 곳에서 시작한 응답이 진행 중' : undefined,
        messages: historyMessages(action.turns),
      };
    // 다른 곳에서 돌던 턴이 끝났다 — 그 답을 히스토리에서 받아 그린다.
    case 'remote_finished':
      if (!state.remote || state.interactionId !== action.interactionId) return state;
      return {
        interactionId: action.interactionId,
        running: false,
        remote: false,
        status: undefined,
        messages: historyMessages(action.turns),
      };
    case 'turn_started':
      return {
        ...state,
        interactionId: action.interactionId,
        running: true,
        remote: false,
        status: '응답을 기다리는 중',
        messages: [
          ...state.messages,
          { id: `user-${state.messages.length}`, role: 'user', text: action.input },
          { id: `assistant-${state.messages.length + 1}`, role: 'assistant', text: '' },
        ],
      };
    case 'event_received':
      return eventState(state, action.event);
    case 'turn_completed':
      return { ...state, running: false, remote: false, status: undefined };
    case 'turn_cancelled': {
      // 중단은 실패가 아니다 — 받다 만 글은 그대로 두고, 한 글자도 못 받은
      // 자리에만 중단 사실을 세운다(빈 답변으로 남으면 아무 일도 없었던 것처럼
      // 보인다). 데스크톱·웹과 같은 문구를 쓴다.
      const index = lastMessageIndex(state.messages, (m) => m.role === 'assistant');
      const messages =
        index >= 0 && !state.messages[index].text.trim()
          ? state.messages.map((m, i) => (i === index ? { ...m, text: INTERRUPTED_TEXT } : m))
          : state.messages;
      return { ...state, messages, running: false, remote: false, status: undefined };
    }
    case 'turn_failed':
      return {
        ...state,
        running: false,
        remote: false,
        status: undefined,
        messages: [
          ...state.messages,
          { id: `failure-${state.messages.length}`, role: 'system', text: action.message },
        ],
      };
    case 'server_turn': {
      // 서버가 주입한 완결 턴(트리거 반응) — 새로고침 없이 흐른다. 같은
      // io_id 재수신(하트비트 폴백)은 멱등.
      const dupe = state.messages.some((m) => m.id === `server-${action.ioId}`);
      if (dupe) return state;
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: `server-${action.ioId}`, role: 'user', text: action.input },
          { id: `server-${action.ioId}-out`, role: 'assistant', text: action.output },
        ],
      };
    }
  }
}
