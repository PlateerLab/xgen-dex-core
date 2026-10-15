/**
 * 대화 목록과 시작 화면의 규칙 (2026-10-09).
 *
 * 폰의 첫 화면은 이제 "에이전트를 고르고 그 대화를 본다" 가 아니라 **대화 목록**이다(웹·데스크톱과 같다).
 * 한 줄의 말(에이전트 이름·꼬리표·제목)과 목록 고치기 규칙은 @dex/protocol 의 conversation-list 가 정본이고,
 * 여기는 그것을 폰 화면의 상태(쪽 수·커서·사라진 채팅 수)와 시작 화면의 잠금으로 묶을 뿐이다.
 * 화면 부품과 떨어져 있어 단위 시험으로 확인한다.
 *
 * (2026-10-10) 목록 몸통이 [최근 채팅] + [에이전트] 가 됐다. 묶음 고치기 규칙은 @dex/protocol
 * conversation-agents 가 정본이고, 여기는 세 목록(최근 채팅·에이전트·들어간 에이전트의 대화)에 함께 싣는다.
 * [⋯] 의 채팅 기록 관리 화면(데스크톱 ConversationManager 와 같은 일)의 규칙도 여기 있다.
 *
 * (2026-10-10 저녁) 에이전트마다 붙던 [+] 와 [다른 에이전트] 를 뺐다. 새 채팅은 맨 위 [+ 새 채팅] 으로만 연다.
 * [에이전트] 도 5개부터 [더 보기]·[접기] 이고, 두 칸의 머리를 누르면 그 칸을 접는다.
 */
import {
  CONVERSATION_TAG_LABELS,
  RECENT_CONVERSATION_STEP,
  conversationAgentLabel,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  dropFromConversationAgents,
  searchHasHit,
  mergeConversationPage,
  removeConversation,
  renameConversationInList,
  renameInConversationAgents,
  touchConversation,
  touchConversationAgent,
  type Agent,
  type AgentCreateSetting,
  type Conversation,
  type ConversationAgent,
  type ConversationKind,
  type ConversationListChange,
  type ConversationPage,
  type ConversationSearchMatch,
  type ConversationSearchPage,
  type SearchTextPart,
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
  purgeNone: '정리할 채팅이 없습니다.',
  listMenu: '채팅 목록',
} as const;

/** 목록 [⋯] 메뉴와 채팅 기록 관리의 [에이전트가 사라진 채팅 제거 (N)]. 0 이어도 같은 말이다. */
export function purgeLabel(count: number): string {
  return `에이전트가 사라진 채팅 제거 (${Math.max(0, count)})`;
}

export function purgeQuestion(count: number): string {
  return `에이전트가 사라진 채팅 ${count}개를 모두 지웁니다. 되돌릴 수 없습니다.`;
}

export function purgeDoneNotice(count: number): string {
  return `채팅 ${count}개를 정리했습니다.`;
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
  /** 마지막으로 말한 날. 에이전트의 대화 화면은 에이전트 이름 대신 이것을 쓴다. */
  day: string;
}

export function conversationRow(c: Conversation, now?: Date): ConversationRow {
  return {
    key: conversationKey(c),
    agent: conversationAgentLabel(c),
    agentDeleted: c.agentDeleted,
    tag: c.tag ? CONVERSATION_TAG_LABELS[c.tag] : null,
    title: conversationDisplayTitle(c),
    day: conversationDayLabel(c.updatedAt || c.createdAt, now),
  };
}

// ── 채팅 검색 (2026-10-10) ────────────────────────────────────────
//
// 목록 머리 [새 채팅] 옆 돋보기가 검색 화면을 연다. 비면 최근 채팅, 적으면 서버가 제목·에이전트 이름·대화
// 내용으로 찾는다(@dex/protocol conversation-search). 한 줄은 제목, 날, 에이전트 이름 · 맞은 자리 한 줄이다.

export const SEARCH_TEXT = {
  title: '채팅 검색',
  placeholder: '검색...',
  clear: '지우기',
  close: '닫기',
  recent: '최근 채팅',
  searching: '검색 중',
  empty: '맞는 채팅이 없습니다.',
  failed: '검색하지 못했습니다.',
  more: '맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.',
  titleOnly: '이 서버는 제목·에이전트 이름으로만 찾습니다.',
} as const;

export interface SearchResultRow {
  key: string;
  conversation: Conversation;
  /** 제목 조각(빈 제목이면 "새 대화" 한 조각). */
  title: SearchTextPart[];
  /** 에이전트 조각. 사라진 에이전트는 이름이 맞았을 때만 이름이 있다. */
  agent: SearchTextPart[];
  agentDeleted: boolean;
  tag: string | null;
  /** 맞은 자리 둘레의 한 줄. 최근 채팅이나 제목·이름으로만 맞았으면 null. */
  snippet: SearchTextPart[] | null;
  /** 마지막으로 말한 날(오늘은 시각, 어제, 월·일). */
  day: string;
}

/** 대화(+ 맞은 자리) → 검색 화면의 한 줄. 맞은 자리가 없으면 최근 채팅 줄(칠하지 않는다). */
export function searchResultRow(c: Conversation, match?: ConversationSearchMatch, now?: Date): SearchResultRow {
  const plain = (text: string): SearchTextPart[] => (text ? [{ text, hit: false }] : []);
  const agentParts = match ? match.agent : plain(c.workflowName);
  return {
    key: conversationKey(c),
    conversation: c,
    title: match?.title.length ? match.title : plain(conversationDisplayTitle(c)),
    agent: c.agentDeleted && !searchHasHit(match?.agent) ? [] : agentParts,
    agentDeleted: c.agentDeleted,
    tag: c.tag ? CONVERSATION_TAG_LABELS[c.tag] : null,
    snippet: match?.snippet ?? null,
    day: conversationDayLabel(c.updatedAt || c.createdAt, now),
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

// ── 목록 몸통: [최근 채팅] + [에이전트] (2026-10-10) ──────────────
//
// 웹·Dex 전 표면과 같은 모양이다(@dex/protocol conversation-agents 머리말).
//   최근 채팅: 마지막으로 말한 대화 5개, [더 보기] 로 5개씩 늘린다. 5개보다 많이 보이면 [접기].
//   에이전트: 대화가 있는 에이전트(이름, 마지막 대화 제목 · 날, 대화 수). 최근 채팅과 같이 5개씩.
//     누르면 그 에이전트의 대화로.
//   두 칸의 머리(최근 채팅·에이전트)를 누르면 그 칸을 접고 편다.

export const LIST_TEXT = {
  recent: '최근 채팅',
  more: '더 보기',
  less: '접기',
  agents: '에이전트',
  agentEmpty: '아직 채팅이 없습니다',
  agentsEmpty: '최근에 쓴 에이전트가 없습니다',
  recentEmpty: '채팅이 없습니다.',
} as const;

/** 목록 몸통의 두 칸. 머리를 누르면 접힌다. */
export type ListSection = 'recent' | 'agents';

export interface RecentWindow<T = Conversation> {
  rows: T[];
  /** [더 보기]: 받아 둔 것이 더 있거나 서버에 다음 쪽이 있다. */
  more: boolean;
  /** [접기]: 5개보다 많이 보인다. */
  less: boolean;
}

/** [최근 채팅] 에 보일 줄. `shown` 은 지금 보이기로 한 수. [에이전트] 도 같다(다 받아 두니 cursor 는 null). */
export function recentWindow<T>(items: readonly T[], shown: number, cursor: string | null): RecentWindow<T> {
  const rows = items.slice(0, Math.max(0, shown));
  return {
    rows,
    more: items.length > rows.length || !!cursor,
    less: rows.length > RECENT_CONVERSATION_STEP,
  };
}

/** [더 보기] 뒤에 보일 수. 그만큼 받아 두지 못했고 다음 쪽이 있으면 `fetch`(다음 쪽을 받는다). */
export function moreRecent(shown: number, loaded: number, cursor: string | null): { shown: number; fetch: boolean } {
  const next = Math.max(shown, RECENT_CONVERSATION_STEP) + RECENT_CONVERSATION_STEP;
  return { shown: next, fetch: loaded < next && !!cursor };
}

export interface AgentRow {
  key: string;
  agent: ConversationAgent;
  /** 에이전트 이름(없으면 id). */
  name: string;
  /** 에이전트가 사라졌다: [지워짐] 과 흐린 이름, 새 채팅은 못 연다. */
  deleted: boolean;
  /** 둘째 줄: 마지막 대화 제목 · 날. */
  sub: string;
  count: number;
}

export function agentRow(a: ConversationAgent, now?: Date): AgentRow {
  const title = conversationDisplayTitle({ title: a.lastTitle });
  const day = conversationDayLabel(a.lastActivity, now);
  return {
    key: a.workflowId,
    agent: a,
    name: a.workflowName || a.workflowId,
    deleted: a.agentDeleted,
    sub: day ? `${title} · ${day}` : title,
    count: a.conversationCount,
  };
}

/** 목록 몸통의 한 칸. 화면은 이 차례대로 그린다. */
export type ChatListItem =
  /** 칸의 머리. 누르면 접고 편다. */
  | { kind: 'title'; key: string; section: ListSection; text: string; open: boolean }
  | { kind: 'conversation'; key: string; conversation: Conversation }
  | { kind: 'more'; key: string; section: ListSection; more: boolean; less: boolean }
  | { kind: 'agent'; key: string; row: AgentRow }
  /** 안내 한 줄. `spinner` 면 받는 중, `retry` 면 누르면 에이전트 묶음을 다시 읽는다. */
  | { kind: 'note'; key: string; text: string; spinner?: boolean; danger?: boolean; retry?: boolean };

export interface ChatListInput {
  recent: ConversationListState | null;
  /** 최근 채팅을 받지 못했다(머리의 오류 상자가 다시 시도를 맡는다). */
  recentError: string;
  shown: number;
  agents: ConversationAgent[] | null;
  agentsError: string;
  /** [에이전트] 에 보이는 수. */
  agentsShown: number;
  /** 접힌 칸. 머리만 남는다. */
  closed: Readonly<Record<ListSection, boolean>>;
  now?: Date;
}

export function chatListItems(s: ChatListInput): ChatListItem[] {
  const out: ChatListItem[] = [];
  /** 칸의 머리를 넣는다. 펼쳐져 있으면 true. */
  const head = (section: ListSection, text: string): boolean => {
    out.push({ kind: 'title', key: `title:${section}`, section, text, open: !s.closed[section] });
    return !s.closed[section];
  };
  const moreBar = (section: ListSection, win: RecentWindow<unknown>) => {
    if (win.more || win.less) out.push({ kind: 'more', key: `more:${section}`, section, more: win.more, less: win.less });
  };

  if (head('recent', LIST_TEXT.recent)) {
    if (!s.recent) {
      if (!s.recentError) out.push({ kind: 'note', key: 'note:recent', text: '', spinner: true });
    } else if (s.recent.items.length === 0) {
      out.push({ kind: 'note', key: 'note:recent', text: LIST_TEXT.recentEmpty });
    } else {
      const win = recentWindow(s.recent.items, s.shown, s.recent.cursor);
      for (const c of win.rows) out.push({ kind: 'conversation', key: `c:${conversationKey(c)}`, conversation: c });
      moreBar('recent', win);
    }
  }

  if (!head('agents', LIST_TEXT.agents)) return out;
  if (!s.agents) {
    out.push(
      s.agentsError
        ? { kind: 'note', key: 'note:agents', text: s.agentsError, danger: true, retry: true }
        : { kind: 'note', key: 'note:agents', text: '', spinner: true },
    );
  } else if (s.agents.length === 0) {
    out.push({ kind: 'note', key: 'note:agents', text: LIST_TEXT.agentsEmpty });
  } else {
    const win = recentWindow(s.agents, s.agentsShown, null);
    for (const a of win.rows) out.push({ kind: 'agent', key: `a:${a.workflowId}`, row: agentRow(a, s.now) });
    moreBar('agents', win);
  }
  return out;
}

// ── 세 목록을 함께 고치기 ─────────────────────────────────────────

/** 채팅 목록 화면이 들고 있는 목록들. */
export interface ChatLists {
  recent: ConversationListState | null;
  agents: ConversationAgent[] | null;
  /** 들어간 에이전트와 그 대화(받기 전이면 list 가 null). 들어가지 않았으면 null. */
  drill: { agent: ConversationAgent; list: ConversationListState | null } | null;
}

export interface ChatListsUpdate {
  lists: ChatLists;
  /** 첫 쪽·묶음을 다시 읽어야 한다(무엇이 바뀌었는지는 서버만 안다). */
  reloadRecent: boolean;
  reloadAgents: boolean;
  reloadDrill: boolean;
}

const sameConversation = (c: Pick<Conversation, 'workflowId' | 'interactionId'>, workflowId: string, interactionId: string) =>
  c.workflowId === workflowId && c.interactionId === interactionId;

/**
 * 소식(@dex/protocol conversationListChange 와 같은 모양)을 세 목록에 싣는다. 이 화면에서 이름을 바꾸거나
 * 지운 것도 같은 소식으로 싣는다.
 * - touched: 최근 채팅에 있으면 맨 위로, 에이전트 묶음도 맨 위로(새 대화가 아니니 수는 그대로). 없으면 다시 읽는다.
 * - renamed: 제목만 고친다(그 대화가 에이전트의 마지막 대화면 둘째 줄도).
 * - removed: 빼고, 에이전트의 수를 줄인다. 그 에이전트의 마지막 대화였으면 묶음을 다시 읽는다.
 */
export function applyChatListChanges(lists: ChatLists, changes: readonly ConversationListChange[]): ChatListsUpdate {
  let { recent, agents, drill } = lists;
  let reloadRecent = false;
  let reloadAgents = false;
  let reloadDrill = false;
  const inDrill = (workflowId: string) => !!drill && drill.agent.workflowId === workflowId;

  for (const change of changes) {
    if (change.type === 'touched') {
      const c = change.conversation;
      if (!c) {
        reloadRecent = true;
        reloadAgents = true;
        if (drill) reloadDrill = true;
        continue;
      }
      const touched = recent ? touchConversation(recent.items, c) : null;
      if (recent && touched?.known) {
        recent = { ...recent, items: touched.list };
        if (agents) {
          const t = touchConversationAgent(agents, c, false);
          agents = t.agents;
          if (!t.known) reloadAgents = true;
        }
      } else {
        reloadRecent = true;
        reloadAgents = true;
      }
      if (drill && inDrill(c.workflowId)) {
        const t = drill.list ? touchConversation(drill.list.items, c) : null;
        if (drill.list && t?.known) drill = { ...drill, list: { ...drill.list, items: t.list } };
        else reloadDrill = true;
      }
    } else if (change.type === 'renamed') {
      const { workflowId, interactionId, title, customTitle } = change;
      if (recent) recent = renameInState(recent, { workflowId, interactionId }, title, customTitle);
      if (agents) agents = renameInConversationAgents(agents, workflowId, interactionId, title);
      if (drill?.list) drill = { ...drill, list: renameInState(drill.list, { workflowId, interactionId }, title, customTitle) };
    } else if (change.type === 'removed') {
      const { workflowId, interactionId } = change;
      const found = recent?.items.find((c) => sameConversation(c, workflowId, interactionId));
      if (recent && found) recent = dropConversation(recent, found);
      if (agents) {
        const d = dropFromConversationAgents(agents, workflowId, interactionId);
        agents = d.agents;
        if (d.stale) reloadAgents = true;
      }
      if (drill?.list && inDrill(workflowId)) {
        drill = { ...drill, list: { ...drill.list, items: removeConversation(drill.list.items, workflowId, interactionId) } };
      }
    } else if (change.type === 'reload') {
      reloadRecent = true;
      reloadAgents = true;
      if (drill) reloadDrill = true;
    }
  }
  return { lists: { recent, agents, drill }, reloadRecent, reloadAgents, reloadDrill };
}

/** 들어간 에이전트의 대화 한 쪽을 싣는다. 그사이 나왔거나 다른 에이전트로 들어갔으면 버린다. */
export function withDrillPage(
  lists: ChatLists,
  workflowId: string,
  page: ConversationPage,
  mode: 'reset' | 'head' | 'append',
): ChatLists {
  const drill = lists.drill;
  if (!drill || drill.agent.workflowId !== workflowId) return lists;
  if (mode === 'append' && !drill.list) return lists;
  return { ...lists, drill: { ...drill, list: applyConversationPage(drill.list, page, mode) } };
}

// ── 채팅 기록 관리 (2026-10-10) ───────────────────────────────────
//
// 목록 머리 [⋯] 가 여는 화면. 데스크톱 채팅 기록 관리 탭(ConversationManager)과 같은 일과 말이다.
// 상태 필터, 검색, 모두 선택·선택 삭제, 줄마다 열기(대화 보기)·이름 바꾸기·삭제, 에이전트가 사라진 채팅 제거.

export const MANAGER_TEXT = {
  title: '채팅 기록 관리',
  refresh: '새로고침',
  kind: '상태',
  placeholder: '제목·에이전트 이름·내용으로 검색',
  searchLabel: '채팅 기록 검색',
  selectAll: '모두 선택',
  deleteSelected: '선택 삭제',
  open: '열기',
  view: '대화 보기',
  loading: '불러오는 중…',
  empty: '채팅 기록이 없습니다.',
  noMatch: '맞는 채팅이 없습니다.',
  loadFailed: '채팅 기록을 불러오지 못했습니다.',
  moreFailed: '더 불러오지 못했습니다.',
  purgeFailed: '채팅 정리에 실패했습니다.',
  searchMore: '맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.',
  retry: '다시 시도',
} as const;

export const MANAGER_KINDS: ReadonlyArray<{ value: ConversationKind; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'active', label: '활성' },
  { value: 'deploy', label: '배포' },
  { value: 'deleted', label: '삭제됨' },
];

/** 한꺼번에 지울 때 동시에 보내는 요청 수. */
export const DELETE_CONCURRENCY = 4;

/** 줄의 [열기]. 에이전트가 사라진 대화는 기록만 본다. */
export function openLabel(c: Pick<Conversation, 'agentDeleted'>): string {
  return c.agentDeleted ? MANAGER_TEXT.view : MANAGER_TEXT.open;
}

export function deleteQuestion(targets: readonly Conversation[]): string {
  return targets.length === 1
    ? `"${conversationDisplayTitle(targets[0])}" 대화를 삭제할까요? 되돌릴 수 없습니다.`
    : `선택한 채팅 ${targets.length}개를 삭제할까요? 되돌릴 수 없습니다.`;
}

/** 지운 뒤 안내. 못 지운 것이 있으면 그 수, 여럿을 지웠으면 지운 수. 하나만 지웠으면 줄이 사라진 것으로 충분하다. */
export function deleteResultNotice(done: number, failed: number): string | null {
  if (failed > 0) return `채팅 ${failed}개는 삭제하지 못했습니다.`;
  if (done > 1) return `채팅 ${done}개를 삭제했습니다.`;
  return null;
}

/** `size` 개씩 함께 보낸다. 실패한 것은 따로 모은다(나머지는 계속 지운다). */
export async function removeInBatches<T>(
  targets: readonly T[],
  remove: (t: T) => Promise<unknown>,
  size: number = DELETE_CONCURRENCY,
): Promise<{ done: T[]; failed: T[] }> {
  const done: T[] = [];
  const failed: T[] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < targets.length; i += step) {
    const batch = targets.slice(i, i + step);
    const results = await Promise.allSettled(batch.map((t) => remove(t)));
    results.forEach((r, j) => (r.status === 'fulfilled' ? done : failed).push(batch[j]));
  }
  return { done, failed };
}

export interface ManagerListState {
  items: Conversation[];
  /** 다음 쪽 커서. 검색 중이면 없다. */
  cursor: string | null;
  /** 이 필터(또는 검색)의 수. 모르면 null(필터를 모르는 옛 서버). */
  total: number | null;
  /** 검색: 보낸 것보다 맞은 대화가 더 있다. */
  searchHasMore: boolean;
  /** 에이전트가 사라진 대화 수(필터와 상관없다, 첫 쪽에만 온다). */
  deletedCount: number;
}

export function managerFromPage(page: ConversationPage): ManagerListState {
  return {
    items: mergeConversationPage([], page.conversations, 'append'),
    cursor: page.nextCursor,
    total: page.total ?? null,
    searchHasMore: false,
    deletedCount: page.agentDeletedCount ?? 0,
  };
}

/** 검색 결과. 사라진 채팅 수는 검색이 세지 않아 앞 값을 지킨다. */
export function managerFromSearch(page: ConversationSearchPage, prev: ManagerListState | null): ManagerListState {
  return {
    items: page.hits.map((h) => h.conversation),
    cursor: null,
    total: page.hits.length,
    searchHasMore: page.hasMore,
    deletedCount: prev?.deletedCount ?? 0,
  };
}

export function managerAppend(state: ManagerListState, page: ConversationPage): ManagerListState {
  return { ...state, items: mergeConversationPage(state.items, page.conversations, 'append'), cursor: page.nextCursor };
}

/** 지운 대화를 뺀다. 총 수와(사라진 에이전트의 대화였으면) 사라진 채팅 수도 줄인다. */
export function managerAfterRemove(state: ManagerListState, gone: readonly Conversation[]): ManagerListState {
  const goneKeys = new Set(gone.map(conversationKey));
  const removed = state.items.filter((c) => goneKeys.has(conversationKey(c)));
  return {
    ...state,
    items: state.items.filter((c) => !goneKeys.has(conversationKey(c))),
    total: state.total == null ? null : Math.max(0, state.total - removed.length),
    deletedCount: Math.max(0, state.deletedCount - removed.filter((c) => c.agentDeleted).length),
  };
}

export function managerAfterRename(
  state: ManagerListState,
  c: Pick<Conversation, 'workflowId' | 'interactionId'>,
  title: string,
  customTitle: boolean,
): ManagerListState {
  return { ...state, items: renameConversationInList(state.items, c.workflowId, c.interactionId, title, customTitle) };
}

// ── 시작 화면의 잠금 ──────────────────────────────────────────────

/**
 * 넘겨받은 에이전트(채팅의 [새 대화])를 골라 둔 채로 둘까. 고를 수 있는 목록에 없으면
 * (공유가 풀렸거나 지워졌다) 평소처럼 [새 에이전트로 시작] 에서 시작한다(데스크톱 시작 화면과 같다).
 */
export function keepPresetAgent(workflowId: string, agents: readonly Pick<Agent, 'workflowId'>[]): boolean {
  return !!workflowId && agents.some((a) => a.workflowId === workflowId);
}

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
