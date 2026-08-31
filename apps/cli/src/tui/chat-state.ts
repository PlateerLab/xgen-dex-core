import type { ChatEvent, HistoryTurn } from '../types';

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
  status?: string;
}

export type ChatAction =
  | { type: 'reset' }
  | { type: 'history_loaded'; interactionId: string; turns: HistoryTurn[] }
  | { type: 'turn_started'; interactionId: string; input: string }
  | { type: 'event_received'; event: ChatEvent }
  | { type: 'turn_completed' }
  | { type: 'turn_cancelled' }
  | { type: 'turn_failed'; message: string };

export const initialChatState: ChatState = { messages: [], running: false };

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
      status: undefined,
      messages: [
        ...state.messages,
        { id: `error-${state.messages.length}`, role: 'system', text: event.detail },
      ],
    };
  }
  if (event.kind === 'end') return { ...state, running: false, status: undefined };
  return state;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState;
    case 'history_loaded':
      return {
        interactionId: action.interactionId,
        running: false,
        messages: action.turns.flatMap((turn, index) => [
          { id: `history-user-${index}`, role: 'user' as const, text: turn.input },
          { id: `history-assistant-${index}`, role: 'assistant' as const, text: turn.output },
        ]),
      };
    case 'turn_started':
      return {
        ...state,
        interactionId: action.interactionId,
        running: true,
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
      return { ...state, running: false, status: undefined };
    case 'turn_cancelled':
      return { ...state, running: false, status: undefined };
    case 'turn_failed':
      return {
        ...state,
        running: false,
        status: undefined,
        messages: [
          ...state.messages,
          { id: `failure-${state.messages.length}`, role: 'system', text: action.message },
        ],
      };
  }
}
