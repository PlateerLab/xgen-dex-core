/**
 * 대화 목록과 시작 화면의 규칙 (2026-10-09).
 *
 * 폰의 첫 화면은 이제 "에이전트를 고르고 그 대화를 본다" 가 아니라 **대화 목록**이다(웹·데스크톱과 같다).
 * 한 줄의 말(에이전트 이름·꼬리표·제목)과 목록 고치기 규칙은 @dex/protocol 의 conversation-list 가 정본이고,
 * 여기는 그것을 폰 화면의 상태(쪽 수·커서·사라진 채팅 수)와 시작 화면의 잠금으로 묶을 뿐이다.
 * 화면 부품과 떨어져 있어 단위 시험으로 확인한다.
 */
import {
  CONVERSATION_TAG_LABELS,
  conversationAgentLabel,
  conversationDisplayTitle,
  conversationKey,
  mergeConversationPage,
  removeConversation,
  renameConversationInList,
  type AgentCreateSetting,
  type Conversation,
  type ConversationPage,
} from '@dex/protocol';

// ── 화면의 말 ─────────────────────────────────────────────────────

export const START_TEXT = {
  heading: '오늘은 무엇을 해볼까요?',
  newAgent: '새 에이전트로 시작',
  nameRequired: '에이전트 이름을 먼저 입력해 주세요.',
  nameTaken: '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.',
  checking: '이름을 확인하는 중입니다.',
  optionsLoading: '모델 목록을 불러오는 중입니다.',
  pickAgent: '에이전트를 먼저 골라 주세요.',
  creating: '에이전트를 만드는 중…',
} as const;

export const CONVERSATION_TEXT = {
  newChat: '+ 새 채팅',
  rename: '이름 바꾸기',
  remove: '삭제',
  deletedAgentNotice: '지워진 에이전트입니다. 지난 대화만 볼 수 있습니다.',
  purgeConfirmTitle: '에이전트가 사라진 채팅 제거',
} as const;

/** 목록 머리의 [에이전트가 사라진 채팅 제거 (N)]. 없으면 빈 글(단추를 그리지 않는다). */
export function purgeLabel(count: number): string {
  return count > 0 ? `에이전트가 사라진 채팅 제거 (${count})` : '';
}

// ── 한 줄 ─────────────────────────────────────────────────────────

export interface ConversationRow {
  key: string;
  /** 위쪽 작은 글: 에이전트 이름, 사라졌으면 [지워짐]. */
  agent: string;
  agentDeleted: boolean;
  /** 꼬리표(배포·Teams·스케줄 …). 일반 채팅이면 null. */
  tag: string | null;
  /** 제목, 비었으면 "새 대화". */
  title: string;
}

export function conversationRow(c: Conversation): ConversationRow {
  return {
    key: conversationKey(c),
    agent: conversationAgentLabel(c),
    agentDeleted: c.agentDeleted,
    tag: c.tag ? CONVERSATION_TAG_LABELS[c.tag] : null,
    title: conversationDisplayTitle(c),
  };
}

// ── 목록 상태 ─────────────────────────────────────────────────────

export interface ConversationListState {
  items: Conversation[];
  /** 다음 쪽 커서. 없으면 끝까지 받았다. */
  cursor: string | null;
  /** 받아 둔 쪽 수. 첫 쪽을 다시 읽을 때 커서를 지킬지 가른다. */
  pages: number;
  /** 에이전트가 사라진 대화 수(첫 쪽에만 온다). */
  deletedCount: number;
}

/**
 * 받은 쪽을 목록 상태에 싣는다.
 * - `reset`: 처음부터 다시(당겨서 새로고침·일괄 제거 뒤).
 * - `head`: 화면에 돌아와 첫 쪽만 다시 읽었다. 받아 둔 뒤쪽은 지키고, 두 쪽 이상 받았으면 커서도 지킨다.
 * - `append`: 다음 쪽.
 */
export function applyConversationPage(
  state: ConversationListState | null,
  page: ConversationPage,
  mode: 'reset' | 'head' | 'append',
): ConversationListState {
  if (!state || mode === 'reset') {
    return {
      items: mergeConversationPage([], page.conversations, 'append'),
      cursor: page.nextCursor,
      pages: 1,
      deletedCount: page.agentDeletedCount ?? 0,
    };
  }
  if (mode === 'head') {
    return {
      items: mergeConversationPage(state.items, page.conversations, 'head'),
      cursor: state.pages > 1 ? state.cursor : page.nextCursor,
      pages: state.pages,
      deletedCount: page.agentDeletedCount ?? state.deletedCount,
    };
  }
  return {
    items: mergeConversationPage(state.items, page.conversations, 'append'),
    cursor: page.nextCursor,
    pages: state.pages + 1,
    deletedCount: state.deletedCount,
  };
}

/** 대화 하나를 지웠다. 에이전트가 사라진 대화였으면 그 수도 줄인다. */
export function dropConversation(state: ConversationListState, c: Conversation): ConversationListState {
  const items = removeConversation(state.items, c.workflowId, c.interactionId);
  const removed = items.length < state.items.length;
  return {
    ...state,
    items,
    deletedCount: removed && c.agentDeleted ? Math.max(0, state.deletedCount - 1) : state.deletedCount,
  };
}

/** 이름이 바뀌었다(순서는 그대로). */
export function renameInState(
  state: ConversationListState,
  c: Pick<Conversation, 'workflowId' | 'interactionId'>,
  title: string,
  customTitle: boolean,
): ConversationListState {
  return { ...state, items: renameConversationInList(state.items, c.workflowId, c.interactionId, title, customTitle) };
}

// ── 시작 화면의 잠금 ──────────────────────────────────────────────

export type NameCheckState = 'empty' | 'checking' | 'ok' | 'taken';

/** 지금 적힌 이름의 검사 결과. `checks` 는 이름(앞뒤 공백 없이) → 이미 있는가. 아직 답이 없으면 checking. */
export function nameCheckState(name: string, checks: Readonly<Record<string, boolean>>): NameCheckState {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (!Object.prototype.hasOwnProperty.call(checks, trimmed)) return 'checking';
  return checks[trimmed] ? 'taken' : 'ok';
}

export interface StartLockInput {
  /** [새 에이전트로 시작] 을 골랐다. */
  newAgent: boolean;
  nameCheck: NameCheckState;
  /** 제공자·모델 목록을 받았고 고른 제공자가 있다. */
  optionsReady: boolean;
  /** 기존 에이전트를 골랐다. */
  agentSelected: boolean;
  /** 만들거나 여는 중이다. */
  busy: boolean;
}

/**
 * 시작 화면의 입력창은 보낼 수 있을 때만 풀린다. 잠겼으면 그 이유(보내기를 누르면 보여 준다).
 * 새 에이전트: 이름이 있고, 같은 이름이 없고, 모델 목록을 받았다. 기존 에이전트: 골랐다.
 */
export function startComposerLock(s: StartLockInput): { locked: boolean; reason: string } {
  if (s.busy) return { locked: true, reason: START_TEXT.creating };
  if (!s.newAgent) {
    return s.agentSelected ? { locked: false, reason: '' } : { locked: true, reason: START_TEXT.pickAgent };
  }
  if (s.nameCheck === 'empty') return { locked: true, reason: START_TEXT.nameRequired };
  if (s.nameCheck === 'taken') return { locked: true, reason: START_TEXT.nameTaken };
  if (!s.optionsReady) return { locked: true, reason: START_TEXT.optionsLoading };
  if (s.nameCheck === 'checking') return { locked: true, reason: START_TEXT.checking };
  return { locked: false, reason: '' };
}

// ── 세부 설정 ─────────────────────────────────────────────────────

/** 세부 설정 안의 차례: 자주 손대는 것부터(데스크톱 만들기 화면과 같다). */
const ADVANCED_ORDER = [
  'system_prompt',
  'temperature',
  'max_tokens',
  'max_iterations',
  'context_window',
  'tool_exposure',
  'enable_builtin_tools',
  'enable_self_evolution',
  'enable_memory',
  'enable_compaction',
  'streaming',
  'base_url',
];

export function orderedSettings(settings: readonly AgentCreateSetting[]): AgentCreateSetting[] {
  const rank = (id: string): number => {
    const i = ADVANCED_ORDER.indexOf(id);
    return i === -1 ? ADVANCED_ORDER.length : i;
  };
  return [...settings].sort((a, b) => rank(a.id) - rank(b.id));
}

export function isNumericSetting(s: Pick<AgentCreateSetting, 'type'>): boolean {
  const t = (s.type || '').toUpperCase();
  return t === 'INT' || t === 'FLOAT' || t === 'NUMBER';
}

/**
 * 손댄 세부 설정만 서버로 보낸다(나머지는 서버 기본값). 숫자 칸은 적은 글을 숫자로 바꾸고, 비었거나
 * 숫자가 아니면 뺀다. 목록에 없는 키는 버린다. 보낼 것이 없으면 undefined.
 */
export function settingsPayload(
  settings: readonly AgentCreateSetting[],
  edits: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const s of settings) {
    if (!Object.prototype.hasOwnProperty.call(edits, s.id)) continue;
    const v = edits[s.id];
    if ((s.type || '').toUpperCase() === 'BOOL') {
      out[s.id] = v === true;
    } else if (isNumericSetting(s)) {
      const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      out[s.id] = (s.type || '').toUpperCase() === 'INT' ? Math.trunc(n) : n;
    } else {
      out[s.id] = v == null ? '' : String(v);
    }
  }
  return Object.keys(out).length ? out : undefined;
}
