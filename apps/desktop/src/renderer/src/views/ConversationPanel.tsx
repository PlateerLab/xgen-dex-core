/**
 * ConversationPanel: 사이드바 [채팅] 뷰 (2026-10-09, [최근 채팅] · [에이전트] 2026-10-10).
 *
 * 대화가 주인이고 에이전트는 작은 표시인 목록(ChatGPT·Claude)과, 예전 [Agent] 뷰의 에이전트 → 그 에이전트의
 * 대화를 한 칸에 함께 둔다. 웹 사이드바와 같은 모양이다.
 *
 *   [+ 새 채팅]                       [검색] [⋯]   채팅 검색 창 · 메뉴([채팅 기록 관리] 탭 · [에이전트가 사라진 채팅 제거])
 *   ▾ 최근 채팅                                    머리를 누르면 접고 편다. 마지막으로 말한 대화 5개, [더 보기] 로 5개씩
 *     에이전트 이름 · 꼬리표
 *     대화 제목                              [⋯]   이름 바꾸기 · 삭제
 *   ─────────────
 *   ▾ 에이전트                                     머리를 누르면 접고 편다. 최근에 쓴 에이전트 5개, [더 보기] 로 5개씩
 *     에이전트 이름                          N
 *     마지막 대화 제목 · 날
 *
 * 새 채팅은 위의 [+ 새 채팅] 으로만 연다(에이전트 줄에는 [+] 가 없다). 에이전트 줄을 누르면 이 칸이 그
 * 에이전트의 대화 목록이 된다([←] 로 돌아온다). 줄에 올리면 바탕이 바뀐다. 제목·꼬리표·순서·묶음은 서버가
 * 정하고(@dex/protocol conversation-list · conversation-agents), 다른 기기의 변화는 대화 목록 소켓으로, 채팅 기록
 * 관리 탭에서 한 일은 conversation-events 로 와서 세 목록에 함께 반영된다.
 *
 * 패널은 뷰가 바뀌어도 언마운트되지 않고 숨겨질 뿐이다(예전 AgentPanel 과 같은 이유). 목록·스크롤·들어간
 * 에이전트가 전환 사이에 남는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  RECENT_CONVERSATION_STEP,
  SEARCH_RECENT_COUNT,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  conversationListChange,
  dropFromConversationAgents,
  mergeConversationPage,
  removeConversation,
  renameConversationInList,
  renameInConversationAgents,
  touchConversation,
  touchConversationAgent,
  type Conversation,
  type ConversationAgent,
  type ConversationSearchMatch,
} from '@dex/protocol';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import { agentDirectory, agentForConversation } from '../agent-directory';
import { BackIcon, ChevronRightIcon, MoreIcon, PlusIcon, RefreshIcon, SearchIcon } from '../brand/icons';
import { ConversationSearchDialog, type ConversationSearchResultSet, type ConversationSearchRow } from './ConversationSearchDialog';
import { onConversationListEvent } from '../conversation-events';

const PAGE_SIZE = 40;
/** 소식이 몰려올 때 한 번만 다시 읽도록 모은다. */
const RELOAD_DELAY_MS = 400;

/** `list`: 목록 머리 ⋯ 메뉴. `up`: 목록 아래쪽 줄이라 줄 메뉴를 위로 펼친다(아래로 펼치면 목록 칸에 잘린다). */
type Menu = { kind: 'list' } | { kind: 'row'; key: string; up: boolean } | null;

/** 줄 메뉴 높이(항목 둘)보다 조금 넉넉하게. 아래 남은 자리가 이보다 작으면 위로 펼친다. */
const ROW_MENU_SPACE = 96;

/** 검색 창이 한 번에 받는 결과 수. */
const SEARCH_LIMIT = 50;

/** 에이전트를 눌러 들어간 목록. */
interface AgentView {
  workflowId: string;
  workflowName: string;
  agentDeleted: boolean;
}

/** 대화(+ 맞은 자리) → 검색 창의 한 줄. 맞은 자리가 없으면(최근 채팅) 강조 없는 조각. */
function searchRow(c: Conversation, match?: ConversationSearchMatch): ConversationSearchRow {
  return {
    key: conversationKey(c),
    title: match ? match.title : c.title ? [{ text: c.title, hit: false }] : [],
    agent: match ? match.agent : c.workflowName ? [{ text: c.workflowName, hit: false }] : [],
    agentDeleted: c.agentDeleted,
    tag: c.tag ? CONVERSATION_TAG_LABELS[c.tag] : null,
    snippet: match?.snippet ?? null,
    when: c.updatedAt || c.createdAt || null,
  };
}

/** 두 칸을 접어 둔 것을 기억하는 자리. */
const SECTIONS_STORAGE_KEY = 'dex.conversationSections';

interface SectionsOpen {
  recent: boolean;
  agents: boolean;
}

function readSectionsOpen(): SectionsOpen {
  try {
    const raw = window.localStorage.getItem(SECTIONS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<SectionsOpen>) : {};
    return { recent: parsed.recent !== false, agents: parsed.agents !== false };
  } catch {
    return { recent: true, agents: true };
  }
}

function writeSectionsOpen(open: SectionsOpen): void {
  try {
    window.localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(open));
  } catch {
    /* 저장이 막혔다: 이번에만 접힌다 */
  }
}

/** 소식이 몰려올 때 마지막 하나만 돌린다. */
function schedule(timer: React.MutableRefObject<number | null>, run: () => void): void {
  if (timer.current != null) window.clearTimeout(timer.current);
  timer.current = window.setTimeout(() => {
    timer.current = null;
    run();
  }, RELOAD_DELAY_MS);
}

export const ConversationPanel: React.FC<{
  /** [+ 새 채팅]: 시작 화면("오늘은 무엇을 해볼까요?")을 메인에 연다. */
  onNewChat: () => void;
  /** ⋯ 메뉴의 [채팅 기록 관리]: 채팅 기록 관리 탭을 연다. */
  onManageHistory: () => void;
}> = ({ onNewChat, onManageHistory }) => {
  // 최근 채팅
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [recentCount, setRecentCount] = useState(RECENT_CONVERSATION_STEP);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 에이전트가 사라진 대화 수(⋯ 메뉴의 [에이전트가 사라진 채팅 제거 (N)]). 첫 쪽이 알려 준다. */
  const [deletedCount, setDeletedCount] = useState(0);
  // 에이전트
  const [agents, setAgents] = useState<ConversationAgent[]>([]);
  const [agentCount, setAgentCount] = useState(RECENT_CONVERSATION_STEP);
  const [sectionsOpen, setSectionsOpen] = useState<SectionsOpen>(readSectionsOpen);
  // 에이전트를 눌러 들어간 목록
  const [view, setView] = useState<AgentView | null>(null);
  const [agentItems, setAgentItems] = useState<Conversation[]>([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentLoadingMore, setAgentLoadingMore] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<Menu>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 검색 창에 보인 대화(열 때 key 로 찾는다). */
  const searchFound = useRef(new Map<string, Conversation>());

  const { sessions, activeKey } = useSessions();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const viewRef = useRef(view);
  viewRef.current = view;
  const agentItemsRef = useRef(agentItems);
  agentItemsRef.current = agentItems;
  const renameCancelledRef = useRef(false);
  const agentSentinelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const headTimer = useRef<number | null>(null);
  const agentsTimer = useRef<number | null>(null);
  const agentViewTimer = useRef<number | null>(null);
  const agentViewSeq = useRef(0);

  /** 열린 세션(탭)의 대화. 줄에 진행 점을 그린다. */
  const liveByInteraction = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const s of sessions) out.set(s.interactionId, s.streaming || s.remote);
    return out;
  }, [sessions]);

  // ── 읽기 ──────────────────────────────────────────────────────

  /** 목록이 알려 준 제목·지워짐을 열린 탭에 맞춘다(되살린 탭은 제목을 모른다). */
  const syncSessions = useCallback((list: readonly Conversation[]) => {
    sessionStore.applyConversationInfo(
      list.map((c) => ({ interactionId: c.interactionId, title: c.title, agentDeleted: c.agentDeleted })),
    );
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      setAgents(await xgen.history.conversationAgents());
    } catch {
      /* 조용히 실패: 다음 소식이나 [새로고침] 이 다시 맞춘다 */
    }
  }, []);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [page] = await Promise.all([xgen.history.conversationPage({ limit: PAGE_SIZE }), loadAgents()]);
      setItems(page.conversations);
      setCursor(page.nextCursor);
      setDeletedCount(page.agentDeletedCount ?? 0);
      syncSessions(page.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadAgents, syncSessions]);

  /** 첫 쪽만 다시 읽어 합친다. 이미 받아 둔 뒤쪽은 그대로 둔다. */
  const reloadHead = useCallback(async () => {
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE });
      setItems((cur) => mergeConversationPage(cur, page.conversations, 'head'));
      setCursor((cur) => cur ?? page.nextCursor);
      setDeletedCount(page.agentDeletedCount ?? 0);
      syncSessions(page.conversations);
    } catch {
      /* 조용히 실패: 다음 소식이나 [새로고침] 이 다시 맞춘다 */
    }
  }, [syncSessions]);

  const scheduleHeadReload = useCallback(() => schedule(headTimer, () => void reloadHead()), [reloadHead]);
  const scheduleAgentsReload = useCallback(() => schedule(agentsTimer, () => void loadAgents()), [loadAgents]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, cursor });
      setItems((cur) => mergeConversationPage(cur, page.conversations, 'append'));
      setCursor(page.nextCursor);
      syncSessions(page.conversations);
    } catch {
      /* [더 보기] 를 다시 누르면 다시 묻는다 */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, syncSessions]);

  useEffect(() => {
    void loadFirst();
    // 대화를 열 때 Agent Geny 인지 알아야 첨부가 제대로 간다. 시작 화면·[다른 에이전트] 도 같은 목록을 쓴다.
    void agentDirectory.load();
  }, [loadFirst]);

  useEffect(
    () => () => {
      for (const timer of [headTimer, agentsTimer, agentViewTimer]) {
        if (timer.current != null) window.clearTimeout(timer.current);
      }
    },
    [],
  );

  // [더 보기] 로 늘린 만큼 받아 둔 것이 모자라면 다음 쪽을 받는다.
  useEffect(() => {
    if (!loading && items.length < recentCount && cursor) void loadMore();
  }, [cursor, items.length, loadMore, loading, recentCount]);

  // ── 에이전트를 눌러 들어간 목록 ────────────────────────────────

  const loadAgentView = useCallback(
    async (target: AgentView) => {
      const seq = ++agentViewSeq.current;
      setAgentLoading(true);
      setAgentError(null);
      setAgentItems([]);
      setAgentCursor(null);
      try {
        const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, workflowId: target.workflowId });
        if (seq !== agentViewSeq.current) return;
        setAgentItems(page.conversations);
        setAgentCursor(page.nextCursor);
        syncSessions(page.conversations);
      } catch (e) {
        if (seq === agentViewSeq.current) setAgentError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === agentViewSeq.current) setAgentLoading(false);
      }
    },
    [syncSessions],
  );

  /** 에이전트의 대화 목록 첫 쪽만 다시 읽어 합친다(새 대화가 생겼다). */
  const reloadAgentHead = useCallback(async () => {
    const target = viewRef.current;
    if (!target) return;
    const seq = agentViewSeq.current;
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, workflowId: target.workflowId });
      if (seq !== agentViewSeq.current) return;
      setAgentItems((cur) => mergeConversationPage(cur, page.conversations, 'head'));
      setAgentCursor((cur) => cur ?? page.nextCursor);
    } catch {
      /* 다음 소식이 다시 맞춘다 */
    }
  }, []);
  const scheduleAgentViewReload = useCallback(
    () => schedule(agentViewTimer, () => void reloadAgentHead()),
    [reloadAgentHead],
  );

  const loadAgentMore = useCallback(async () => {
    const target = viewRef.current;
    if (!target || !agentCursor || agentLoadingMore) return;
    const seq = agentViewSeq.current;
    setAgentLoadingMore(true);
    try {
      const page = await xgen.history.conversationPage({
        limit: PAGE_SIZE,
        workflowId: target.workflowId,
        cursor: agentCursor,
      });
      if (seq !== agentViewSeq.current) return;
      setAgentItems((cur) => mergeConversationPage(cur, page.conversations, 'append'));
      setAgentCursor(page.nextCursor);
    } catch {
      /* 다시 끝까지 내리면 다시 묻는다 */
    } finally {
      setAgentLoadingMore(false);
    }
  }, [agentCursor, agentLoadingMore]);

  const openAgentView = useCallback(
    (target: AgentView) => {
      setMenu(null);
      setEditingKey(null);
      setView(target);
      listRef.current?.scrollTo({ top: 0 });
      void loadAgentView(target);
    },
    [loadAgentView],
  );

  const closeAgentView = useCallback(() => {
    agentViewSeq.current += 1;
    setMenu(null);
    setEditingKey(null);
    setView(null);
    setAgentItems([]);
    setAgentCursor(null);
  }, []);

  // 에이전트의 대화 목록은 끝까지 내려오면 다음 쪽.
  useEffect(() => {
    const el = agentSentinelRef.current;
    if (!el || !agentCursor || !view) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadAgentMore();
      },
      { root: listRef.current },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [agentCursor, loadAgentMore, view, agentItems.length]);

  // ── 다른 화면·기기에서 일어난 일 ─────────────────────────────

  /** 이름이 바뀌었다(세 목록과 열린 탭). */
  const applyRenamed = useCallback((workflowId: string, interactionId: string, title: string, customTitle: boolean) => {
    setItems((cur) => renameConversationInList(cur, workflowId, interactionId, title, customTitle));
    setAgentItems((cur) => renameConversationInList(cur, workflowId, interactionId, title, customTitle));
    setAgents((cur) => renameInConversationAgents(cur, workflowId, interactionId, title));
    sessionStore.applyConversationInfo([{ interactionId, title }]);
  }, []);

  /** 지워졌다(세 목록). 그 에이전트의 마지막 대화였으면 묶음을 다시 읽는다. */
  const applyRemoved = useCallback(
    (gone: ReadonlyArray<{ workflowId: string; interactionId: string }>) => {
      let next = agentsRef.current;
      let stale = false;
      for (const c of gone) {
        const dropped = dropFromConversationAgents(next, c.workflowId, c.interactionId);
        next = dropped.agents;
        stale = stale || dropped.stale;
      }
      setAgents(next);
      if (stale) scheduleAgentsReload();
      const goneKeys = new Set(gone.map(conversationKey));
      const goneDeleted = [...itemsRef.current, ...agentItemsRef.current].filter(
        (c, i, all) => c.agentDeleted && goneKeys.has(conversationKey(c)) && all.findIndex((x) => conversationKey(x) === conversationKey(c)) === i,
      ).length;
      if (goneDeleted) setDeletedCount((n) => Math.max(0, n - goneDeleted));
      setItems((cur) => gone.reduce((list, c) => removeConversation(list, c.workflowId, c.interactionId), cur));
      setAgentItems((cur) => gone.reduce((list, c) => removeConversation(list, c.workflowId, c.interactionId), cur));
    },
    [scheduleAgentsReload],
  );

  useEffect(() => {
    const off = xgen?.chatWatch?.onConversationsChanged?.((event) => {
      const change = conversationListChange(event.kind, {
        ...(event.data ?? {}),
        interaction_id: event.interactionId,
        workflow_id: event.workflowId,
        ...(typeof event.running === 'boolean' ? { running: event.running } : {}),
      });
      switch (change.type) {
        case 'running': {
          const key = conversationKey(change);
          setRunning((cur) => {
            if (change.running === cur.has(key)) return cur;
            const next = new Set(cur);
            if (change.running) next.add(key);
            else next.delete(key);
            return next;
          });
          return;
        }
        case 'touched': {
          const conv = change.conversation;
          // 목록에 이미 있는 대화만 여기서 고친다. 모르는 대화(새 대화이거나 아직 안 받은 쪽)는 숨길 대화인지
          // 서버만 알므로 다시 읽는다(목록에 없는 대화가 에이전트 수에 섞이지 않게).
          const known = !!conv && itemsRef.current.some((c) => conversationKey(c) === conversationKey(conv));
          if (conv && known) {
            setItems((cur) => touchConversation(cur, conv).list);
            const next = touchConversationAgent(agentsRef.current, conv, false);
            if (next.known) setAgents(next.agents);
            else scheduleAgentsReload();
          } else {
            scheduleHeadReload();
            scheduleAgentsReload();
          }
          const target = viewRef.current;
          if (conv && target && target.workflowId === conv.workflowId) {
            if (agentItemsRef.current.some((c) => conversationKey(c) === conversationKey(conv))) {
              setAgentItems((cur) => touchConversation(cur, conv).list);
            } else {
              scheduleAgentViewReload();
            }
          }
          return;
        }
        case 'renamed':
          applyRenamed(change.workflowId, change.interactionId, change.title, change.customTitle);
          return;
        case 'removed':
          applyRemoved([change]);
          return;
        case 'reload':
          scheduleHeadReload();
          scheduleAgentsReload();
          return;
        default:
      }
    });
    return () => off?.();
  }, [applyRemoved, applyRenamed, scheduleAgentViewReload, scheduleAgentsReload, scheduleHeadReload]);

  // 이 창의 채팅 기록 관리 탭에서 한 일(서버 소식을 기다리지 않고 바로).
  useEffect(
    () =>
      onConversationListEvent((event) => {
        if (event.type === 'removed') {
          applyRemoved(event.items);
        } else if (event.type === 'renamed') {
          applyRenamed(event.workflowId, event.interactionId, event.title, event.customTitle);
        } else {
          setItems((cur) => cur.filter((c) => !c.agentDeleted));
          setAgents((cur) => cur.filter((a) => !a.agentDeleted));
          setDeletedCount(0);
          if (viewRef.current?.agentDeleted) closeAgentView();
          void reloadHead();
        }
      }),
    [applyRemoved, applyRenamed, closeAgentView, reloadHead],
  );

  // 메뉴 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.conv-menu-wrap')) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  // ── 동작 ─────────────────────────────────────────────────────

  const open = useCallback((c: Conversation) => {
    const agent = agentForConversation(c);
    sessionStore.openResume(agent, c.interactionId, c.workflowName, {
      title: c.title,
      agentDeleted: c.agentDeleted,
    });
  }, []);

  const searchConversations = useCallback(async (query: string): Promise<ConversationSearchResultSet> => {
    const page = await xgen.history.search(query, { limit: SEARCH_LIMIT });
    for (const h of page.hits) searchFound.current.set(conversationKey(h.conversation), h.conversation);
    return {
      rows: page.hits.map((h) => searchRow(h.conversation, h.match)),
      hasMore: page.hasMore,
      contentSearched: page.contentSearched,
    };
  }, []);

  const recentRows = useMemo(() => items.slice(0, SEARCH_RECENT_COUNT).map((c) => searchRow(c)), [items]);

  const openFromSearch = useCallback(
    (key: string) => {
      const c = searchFound.current.get(key) ?? itemsRef.current.find((x) => conversationKey(x) === key);
      setSearchOpen(false);
      if (c) open(c);
    },
    [open],
  );

  const startRename = useCallback((c: Conversation) => {
    setMenu(null);
    renameCancelledRef.current = false;
    setEditingKey(conversationKey(c));
    setDraft(c.title);
  }, []);

  const commitRename = useCallback(
    async (c: Conversation) => {
      setEditingKey(null);
      if (renameCancelledRef.current) return;
      const next = draft.split(/\s+/).filter(Boolean).join(' ');
      if (next === c.title) return;
      try {
        const res = await xgen.history.rename(c.workflowId, c.interactionId, next);
        applyRenamed(c.workflowId, c.interactionId, res.title, res.customTitle);
      } catch (e) {
        setNotice(`이름을 바꾸지 못했습니다. ${e instanceof Error ? e.message : ''}`.trim());
      }
    },
    [applyRenamed, draft],
  );

  const remove = useCallback(
    async (c: Conversation) => {
      setMenu(null);
      const title = conversationDisplayTitle(c);
      if (!window.confirm(`"${title}" 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
      try {
        await xgen.history.remove(c.workflowId, c.interactionId, c.workflowName);
      } catch (e) {
        setNotice(`대화를 삭제하지 못했습니다. ${e instanceof Error ? e.message : ''}`.trim());
        return;
      }
      applyRemoved([c]);
      // 열려 있던 탭도 닫는다. 지운 대화가 탭으로 남으면 눌러도 빈 대화다.
      if (sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
    },
    [applyRemoved],
  );

  /** ⋯ 메뉴의 [에이전트가 사라진 채팅 제거]: 묻고 지운 뒤 세 목록과 열린 탭을 맞춘다. */
  const purge = useCallback(async () => {
    setMenu(null);
    if (deletedCount <= 0) return;
    if (!window.confirm(`에이전트가 사라진 채팅 ${deletedCount}개를 모두 지웁니다. 되돌릴 수 없습니다.`)) return;
    let removed = 0;
    try {
      removed = await xgen.history.purgeDeletedAgents();
    } catch (e) {
      setNotice(`채팅 정리에 실패했습니다. ${e instanceof Error ? e.message : ''}`.trim());
      return;
    }
    for (const c of [...itemsRef.current, ...agentItemsRef.current]) {
      if (c.agentDeleted && sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
    }
    setItems((cur) => cur.filter((c) => !c.agentDeleted));
    setAgents((cur) => cur.filter((a) => !a.agentDeleted));
    setDeletedCount(0);
    if (viewRef.current?.agentDeleted) closeAgentView();
    setNotice(`채팅 ${removed}개를 정리했습니다.`);
    void reloadHead();
  }, [closeAgentView, deletedCount, reloadHead]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const toggleSection = useCallback((key: keyof SectionsOpen) => {
    setSectionsOpen((cur) => {
      const next = { ...cur, [key]: !cur[key] };
      writeSectionsOpen(next);
      return next;
    });
  }, []);

  // ── 그리기 ───────────────────────────────────────────────────

  /** 대화 한 줄(최근 채팅·에이전트의 대화). `showAgent` 면 위에 작은 에이전트 이름, 아니면 날. */
  const conversationRow = (c: Conversation, showAgent: boolean) => {
    const key = conversationKey(c);
    const active = activeKey === c.interactionId;
    const live = !!liveByInteraction.get(c.interactionId) || running.has(key);
    const title = conversationDisplayTitle(c);
    const metaLine = (
      <span className="conv-row-agent">
        {showAgent &&
          (c.agentDeleted ? (
            <span className="conv-tag deleted">{DELETED_AGENT_LABEL}</span>
          ) : (
            <span className="conv-row-agent-name">{c.workflowName}</span>
          ))}
        {c.tag && <span className="conv-tag">{CONVERSATION_TAG_LABELS[c.tag]}</span>}
        {!showAgent && <span className="conv-row-agent-name">{conversationDayLabel(c.updatedAt || c.createdAt)}</span>}
        {live && <span className="live-dot active live conv-row-live" title="진행 중" />}
      </span>
    );
    if (editingKey === key) {
      return (
        <div key={key} className="conv-row editing">
          {metaLine}
          <input
            className="conv-rename-input"
            aria-label="대화 이름"
            value={draft}
            maxLength={200}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitRename(c)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                renameCancelledRef.current = true;
                setEditingKey(null);
              }
            }}
          />
        </div>
      );
    }
    const menuOpen = menu?.kind === 'row' && menu.key === key;
    return (
      <div key={key} className={`conv-row ${active ? 'active' : ''}`}>
        <button className="conv-row-main" onClick={() => open(c)} title={`${c.workflowName} · ${title}`}>
          {metaLine}
          <span className="conv-row-title">{title}</span>
        </button>
        <div className={`conv-menu-wrap conv-row-menu ${menuOpen ? 'open' : ''}`}>
          <button
            className={`conv-row-more ${menuOpen ? 'open' : ''}`}
            title="대화 메뉴"
            aria-label="대화 메뉴"
            onClick={(e) => {
              const button = e.currentTarget.getBoundingClientRect();
              const list = listRef.current?.getBoundingClientRect();
              const up = !!list && list.bottom - button.bottom < ROW_MENU_SPACE;
              setMenu((m) => (m?.kind === 'row' && m.key === key ? null : { kind: 'row', key, up }));
            }}
          >
            <MoreIcon size={15} />
          </button>
          {menuOpen && menu && (
            <div className={`conv-menu ${menu.up ? 'up' : ''}`} role="menu">
              <button role="menuitem" className="conv-menu-item" onClick={() => startRename(c)}>
                이름 바꾸기
              </button>
              <button role="menuitem" className="conv-menu-item danger" onClick={() => void remove(c)}>
                삭제
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const recentShown = items.slice(0, recentCount);
  const canShowMore = items.length > recentCount || !!cursor;
  const sectionHead = (key: keyof SectionsOpen, text: string) => (
    <button className="conv-section-head" aria-expanded={sectionsOpen[key]} onClick={() => toggleSection(key)}>
      <ChevronRightIcon size={12} className={sectionsOpen[key] ? 'open' : undefined} />
      {text}
    </button>
  );
  const moreLess = (canMore: boolean, canLess: boolean, onMore: () => void, onLess: () => void, busy = false) =>
    canMore || canLess ? (
      <div className="conv-more-row">
        {canMore && (
          <button className="conv-text-btn" disabled={busy} onClick={onMore}>
            {busy ? '더 불러오는 중' : '더 보기'}
          </button>
        )}
        {canLess && (
          <button className="conv-text-btn" onClick={onLess}>
            접기
          </button>
        )}
      </div>
    ) : null;

  const home = (
    <>
      {sectionHead('recent', '최근 채팅')}
      {sectionsOpen.recent && (
        <>
          {items.length === 0 && <div className="muted small pad">아직 대화가 없습니다</div>}
          {recentShown.map((c) => conversationRow(c, true))}
          {moreLess(
            canShowMore,
            recentCount > RECENT_CONVERSATION_STEP,
            () => setRecentCount((n) => n + RECENT_CONVERSATION_STEP),
            () => setRecentCount(RECENT_CONVERSATION_STEP),
            loadingMore,
          )}
        </>
      )}

      <div className="conv-section-divider" aria-hidden />

      {sectionHead('agents', '에이전트')}
      {sectionsOpen.agents && (
        <>
          {agents.length === 0 && <div className="muted small pad">최근에 쓴 에이전트가 없습니다</div>}
          {agents.slice(0, agentCount).map((a) => {
            const name = a.workflowName || a.workflowId;
            return (
              <button
                key={a.workflowId}
                className="conv-agent-row"
                title={name}
                onClick={() => openAgentView({ workflowId: a.workflowId, workflowName: name, agentDeleted: a.agentDeleted })}
              >
                <span className="conv-agent-main">
                  <span className="conv-agent-name">
                    {a.agentDeleted && <span className="conv-tag deleted">{DELETED_AGENT_LABEL}</span>}
                    <span className={a.agentDeleted ? 'muted' : undefined}>{name}</span>
                  </span>
                  <span className="conv-agent-last">
                    {a.lastTitle || '새 대화'}
                    {a.lastActivity ? ` · ${conversationDayLabel(a.lastActivity)}` : ''}
                  </span>
                </span>
                <span className="conv-agent-count">{a.conversationCount}</span>
              </button>
            );
          })}
          {moreLess(
            agents.length > agentCount,
            agentCount > RECENT_CONVERSATION_STEP,
            () => setAgentCount((n) => n + RECENT_CONVERSATION_STEP),
            () => setAgentCount(RECENT_CONVERSATION_STEP),
          )}
        </>
      )}
    </>
  );

  const agentBody = view && (
    <>
      <div className="conv-agent-head">
        <button className="icon-btn sm" title="뒤로" aria-label="뒤로" onClick={closeAgentView}>
          <BackIcon size={15} />
        </button>
        {view.agentDeleted && <span className="conv-tag deleted">{DELETED_AGENT_LABEL}</span>}
        <span className="conv-agent-head-name" title={view.workflowName}>
          {view.workflowName}
        </span>
      </div>
      {agentLoading && agentItems.length === 0 && <div className="muted small pad">불러오는 중…</div>}
      {!agentLoading && agentError && (
        <div className="error small pad">
          대화 목록을 불러오지 못했습니다.{' '}
          <button className="link" onClick={() => void loadAgentView(view)}>
            다시 시도
          </button>
        </div>
      )}
      {!agentLoading && !agentError && agentItems.length === 0 && (
        <div className="muted small pad">아직 채팅이 없습니다</div>
      )}
      {agentItems.map((c) => conversationRow(c, false))}
      {agentCursor && (
        <div ref={agentSentinelRef} className="muted small pad conv-more">
          {agentLoadingMore ? '더 불러오는 중' : ''}
        </div>
      )}
    </>
  );

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">채팅</span>
        <span className="sidebar-title-actions">
          <button
            className="icon-btn sm"
            title="새로고침"
            onClick={() => {
              void loadFirst();
              void agentDirectory.load(true);
              if (viewRef.current) void loadAgentView(viewRef.current);
            }}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="conv-list-head">
        <button className="new-chat-btn conv-new" onClick={() => onNewChat()}>
          <PlusIcon size={16} /> 새 채팅
        </button>
        <button
          className="icon-btn conv-search-open"
          title="채팅 검색"
          aria-label="채팅 검색"
          aria-haspopup="dialog"
          onClick={() => {
            setMenu(null);
            searchFound.current.clear();
            setSearchOpen(true);
          }}
        >
          <SearchIcon size={16} />
        </button>
        {/* ⋯ 는 메뉴다. [채팅 기록 관리] 를 골라야 그 탭이 열린다. */}
        <div className={`conv-menu-wrap ${menu?.kind === 'list' ? 'open' : ''}`}>
          <button
            className="icon-btn conv-list-more"
            title="채팅 목록 메뉴"
            aria-label="채팅 목록 메뉴"
            aria-expanded={menu?.kind === 'list'}
            onClick={() => setMenu((m) => (m?.kind === 'list' ? null : { kind: 'list' }))}
          >
            <MoreIcon size={16} />
          </button>
          {menu?.kind === 'list' && (
            <div className="conv-menu" role="menu">
              <button
                role="menuitem"
                className="conv-menu-item"
                onClick={() => {
                  setMenu(null);
                  onManageHistory();
                }}
              >
                채팅 기록 관리
              </button>
              <button
                role="menuitem"
                className="conv-menu-item danger"
                disabled={deletedCount === 0}
                title={deletedCount === 0 ? '정리할 채팅이 없습니다.' : undefined}
                onClick={() => void purge()}
              >
                에이전트가 사라진 채팅 제거 ({deletedCount})
              </button>
            </div>
          )}
        </div>
      </div>

      {notice && (
        <div className="conv-notice small" role="status">
          {notice}
        </div>
      )}

      <div className="agent-list conv-list" ref={listRef}>
        {loading && <div className="muted small pad">불러오는 중…</div>}
        {!loading && error && (
          <div className="error small pad">
            대화 목록을 불러오지 못했습니다.{' '}
            <button className="link" onClick={() => void loadFirst()}>
              다시 시도
            </button>
          </div>
        )}
        {!loading && !error && (view ? agentBody : home)}
      </div>
      {searchOpen && (
        <ConversationSearchDialog
          recent={recentRows}
          search={searchConversations}
          onOpen={openFromSearch}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
};
