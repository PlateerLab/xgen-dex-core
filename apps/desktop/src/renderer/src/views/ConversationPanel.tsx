/**
 * ConversationPanel: 사이드바 [채팅] 뷰 (2026-10-09).
 *
 * ChatGPT·Claude 처럼 **대화 단위, 마지막으로 말한 순서**다. 예전 [Agent] 뷰는 에이전트를 고른 뒤 그
 * 에이전트의 대화를 고르는 두 단계였다. 이제는 대화가 주인이고 에이전트는 작은 표시다.
 *
 *   [+ 새 채팅]                       [검색] [⋯]  채팅 검색 창 · 에이전트가 사라진 채팅 제거
 *   에이전트 이름 · 꼬리표
 *   대화 제목(첫 메시지 한 줄, 붙인 이름)      [⋯]  이름 바꾸기 · 삭제
 *
 * 제목·꼬리표·순서는 서버가 정하고(@dex/protocol conversation-list), 웹과 같은 모양이다. 다른 기기에서
 * 말하거나 지우거나 이름을 바꾼 것은 대화 목록 소켓으로 밀려온다. 에이전트가 사라진 대화는
 * [지워짐] 으로만 보이고, 열면 같은 채팅 화면에서 지난 기록만 보인다.
 *
 * 돋보기(2026-10-10)는 채팅 검색 창을 연다. 제목·에이전트 이름·대화 내용으로 서버가 찾고, 고른 대화는
 * 목록 줄을 누른 것과 똑같이 열린다.
 *
 * 패널은 뷰가 바뀌어도 언마운트되지 않고 숨겨질 뿐이다(예전 AgentPanel 과 같은 이유). 목록·스크롤이
 * 전환 사이에 남는다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  SEARCH_RECENT_COUNT,
  conversationDisplayTitle,
  conversationKey,
  conversationListChange,
  mergeConversationPage,
  removeConversation,
  renameConversationInList,
  touchConversation,
  type Conversation,
  type ConversationSearchMatch,
} from '@dex/protocol';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import { agentDirectory, agentForConversation } from '../agent-directory';
import { MoreIcon, PlusIcon, RefreshIcon, SearchIcon } from '../brand/icons';
import { ConversationSearchDialog, type ConversationSearchResultSet, type ConversationSearchRow } from './ConversationSearchDialog';

const PAGE_SIZE = 40;
/** 지우기·정리 소식이 몰려올 때 첫 쪽을 한 번만 다시 읽도록 모은다. */
const HEAD_RELOAD_DELAY_MS = 400;

/** `up`: 목록 아래쪽 줄이라 메뉴를 위로 펼친다(아래로 펼치면 목록 칸에 잘린다). */
type Menu = { kind: 'list' } | { kind: 'row'; key: string; up: boolean } | null;

/** 줄 메뉴 높이(항목 둘)보다 조금 넉넉하게. 아래 남은 자리가 이보다 작으면 위로 펼친다. */
const ROW_MENU_SPACE = 96;

/** 검색 창이 한 번에 받는 결과 수. */
const SEARCH_LIMIT = 50;

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

export const ConversationPanel: React.FC<{
  /** [+ 새 채팅]: 시작 화면("오늘은 무엇을 해볼까요?")을 메인에 연다. */
  onNewChat: () => void;
}> = ({ onNewChat }) => {
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletedCount, setDeletedCount] = useState(0);
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
  const renameCancelledRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const headTimer = useRef<number | null>(null);

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

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE });
      setItems(page.conversations);
      setCursor(page.nextCursor);
      setDeletedCount(page.agentDeletedCount ?? 0);
      syncSessions(page.conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [syncSessions]);

  /** 첫 쪽만 다시 읽어 합친다. 이미 받아 둔 뒤쪽은 그대로 둔다. */
  const reloadHead = useCallback(async () => {
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE });
      setItems((cur) => mergeConversationPage(cur, page.conversations, 'head'));
      setDeletedCount(page.agentDeletedCount ?? 0);
      setCursor((cur) => cur ?? page.nextCursor);
      syncSessions(page.conversations);
    } catch {
      /* 조용히 실패: 다음 소식이나 [새로고침] 이 다시 맞춘다 */
    }
  }, [syncSessions]);

  const scheduleHeadReload = useCallback(() => {
    if (headTimer.current != null) window.clearTimeout(headTimer.current);
    headTimer.current = window.setTimeout(() => {
      headTimer.current = null;
      void reloadHead();
    }, HEAD_RELOAD_DELAY_MS);
  }, [reloadHead]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, cursor });
      setItems((cur) => mergeConversationPage(cur, page.conversations, 'append'));
      setCursor(page.nextCursor);
      syncSessions(page.conversations);
    } catch {
      /* 다음에 끝까지 내리면 다시 묻는다 */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, syncSessions]);

  useEffect(() => {
    void loadFirst();
    // 대화를 열 때 Agent Geny 인지 알아야 첨부가 제대로 간다. 시작 화면도 같은 목록을 쓴다.
    void agentDirectory.load();
  }, [loadFirst]);

  useEffect(
    () => () => {
      if (headTimer.current != null) window.clearTimeout(headTimer.current);
    },
    [],
  );

  // 끝까지 내려오면 다음 쪽.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !cursor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root: listRef.current },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor, loadMore, items.length]);

  // ── 다른 화면·기기에서 일어난 일 ─────────────────────────────

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
          if (conv && itemsRef.current.some((c) => conversationKey(c) === conversationKey(conv))) {
            setItems((cur) => touchConversation(cur, conv).list);
          } else {
            // 모르는 대화(새 대화이거나 아직 안 받은 쪽). 숨길 대화인지는 서버만 안다.
            scheduleHeadReload();
          }
          return;
        }
        case 'renamed':
          setItems((cur) => renameConversationInList(cur, change.workflowId, change.interactionId, change.title, change.customTitle));
          sessionStore.applyConversationInfo([{ interactionId: change.interactionId, title: change.title }]);
          return;
        case 'removed':
          setItems((cur) => removeConversation(cur, change.workflowId, change.interactionId));
          // 사라진 에이전트 대화 수도 함께 맞춘다.
          scheduleHeadReload();
          return;
        case 'reload':
          scheduleHeadReload();
          return;
        default:
      }
    });
    return () => off?.();
  }, [scheduleHeadReload]);

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
        setItems((cur) => renameConversationInList(cur, c.workflowId, c.interactionId, res.title, res.customTitle));
        sessionStore.applyConversationInfo([{ interactionId: c.interactionId, title: res.title }]);
      } catch (e) {
        setNotice(`이름을 바꾸지 못했습니다. ${e instanceof Error ? e.message : ''}`.trim());
      }
    },
    [draft],
  );

  const remove = useCallback(async (c: Conversation) => {
    setMenu(null);
    const title = conversationDisplayTitle(c);
    if (!window.confirm(`"${title}" 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await xgen.history.remove(c.workflowId, c.interactionId, c.workflowName);
    } catch (e) {
      setNotice(`대화를 삭제하지 못했습니다. ${e instanceof Error ? e.message : ''}`.trim());
      return;
    }
    setItems((cur) => removeConversation(cur, c.workflowId, c.interactionId));
    if (c.agentDeleted) setDeletedCount((n) => Math.max(0, n - 1));
    // 열려 있던 탭도 닫는다. 지운 대화가 탭으로 남으면 눌러도 빈 대화다.
    if (sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
  }, []);

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
    for (const c of itemsRef.current) {
      if (c.agentDeleted && sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
    }
    setItems((cur) => cur.filter((c) => !c.agentDeleted));
    setDeletedCount(0);
    setNotice(`채팅 ${removed}개를 정리했습니다.`);
    void reloadHead();
  }, [deletedCount, reloadHead]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // ── 그리기 ───────────────────────────────────────────────────

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
            }}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      <div className="conv-list-head">
        <button className="new-chat-btn conv-new" onClick={onNewChat}>
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
        {!loading && !error && items.length === 0 && <div className="muted small pad">아직 대화가 없습니다</div>}
        {!loading &&
          items.map((c) => {
            const key = conversationKey(c);
            const active = activeKey === c.interactionId;
            const live = !!liveByInteraction.get(c.interactionId) || running.has(key);
            const title = conversationDisplayTitle(c);
            const agentLine = (
              <span className="conv-row-agent">
                {c.agentDeleted ? (
                  <span className="conv-tag deleted">{DELETED_AGENT_LABEL}</span>
                ) : (
                  <span className="conv-row-agent-name">{c.workflowName}</span>
                )}
                {c.tag && <span className="conv-tag">{CONVERSATION_TAG_LABELS[c.tag]}</span>}
                {live && <span className="live-dot active live conv-row-live" title="진행 중" />}
              </span>
            );
            if (editingKey === key) {
              return (
                <div key={key} className="conv-row editing">
                  {agentLine}
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
            return (
              <div key={key} className={`conv-row ${active ? 'active' : ''}`}>
                <button className="conv-row-main" onClick={() => open(c)} title={`${c.workflowName} · ${title}`}>
                  {agentLine}
                  <span className="conv-row-title">{title}</span>
                </button>
                <div className={`conv-menu-wrap conv-row-menu ${menu?.kind === 'row' && menu.key === key ? 'open' : ''}`}>
                  <button
                    className={`conv-row-more ${menu?.kind === 'row' && menu.key === key ? 'open' : ''}`}
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
                  {menu?.kind === 'row' && menu.key === key && (
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
          })}
        {cursor && (
          <div ref={sentinelRef} className="muted small pad conv-more">
            {loadingMore ? '더 불러오는 중' : ''}
          </div>
        )}
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
