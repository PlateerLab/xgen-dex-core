/**
 * 사이드바: [최근 채팅] · [에이전트] (2026-10-10, 웹·Dex 와 같은 짜임).
 *
 *   [+ 새 채팅]                       [검색] [⋯]
 *   최근 채팅      마지막으로 말한 대화 5개, [더 보기] 로 5개씩 더, 그보다 많이 보이면 [접기]
 *   ──────
 *   에이전트       대화가 있는 에이전트: 이름, "마지막 대화 제목 · 날", 대화 수, 마지막으로 말한 순서
 *                  ([최근 채팅] 처럼 5개, [더 보기]·[접기])
 *
 * 새 채팅은 맨 위 [+ 새 채팅] 에서만 시작한다. 칸 제목을 누르면 그 칸을 접고 펼친다(다시 켜도 기억한다).
 * 에이전트 줄을 누르면 그 에이전트의 대화로 들어간다([←] 로 돌아온다, 줄에는 에이전트 이름 대신 날). 대화 줄 =
 * 에이전트 이름(작게) + 제목(붙인 이름, 없으면 첫 질문, 둘 다 없으면 "새 대화"). 도는 대화에는 표시가 붙는다(Dex
 * 사이드바와 같은 CSS). 줄마다 [⋯] 메뉴로 [이름 바꾸기]·[삭제].
 *
 * 돋보기는 채팅 검색 창(Dex 와 같은 부품, main 의 store.searchConversations), [⋯] 는 메뉴이고 그 [채팅 기록 관리] 가 본문에 관리 화면을 연다.
 *
 * XD 는 에이전트를 지우면 그 대화도 함께 지운다(store 의 ON DELETE CASCADE). 그래서 웹·Dex 의 [지워짐] 상태도,
 * 지워진 에이전트의 대화를 치우는 동작도 XD 에는 없다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RECENT_CONVERSATION_STEP, SEARCH_RECENT_COUNT, conversationDayLabel, type ConversationSearchMatch } from '@dex/protocol';
import type { XdConversationAgent, XdConversationListItem } from '../../../main/store';
import { xd } from '../bridge';
import { LIST_TEXT, agentLastLine, loadCollapsed, recentSlice, saveCollapsed, type CollapsedSections } from '../chat-list-model';
import { useAgentConversations } from '../conversations';
import { errorText, useData } from '../data';
import {
  BackIcon,
  ChevronRightIcon,
  ConversationSearchDialog,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  type ConversationSearchResultSet,
  type ConversationSearchRow,
} from '../dex';
import { useRunning } from '../live-store';
import { conversationTitle, dropConversation, replaceConversation } from '../start-model';
import { RenameInput } from './RenameInput';

/** 검색 창이 한 번에 받는 결과 수. */
const SEARCH_LIMIT = 50;

/** 대화(+ 맞은 자리) → 검색 창의 한 줄. 맞은 자리가 없으면(최근 채팅) 강조 없는 조각. */
function searchRow(c: XdConversationListItem, match?: ConversationSearchMatch): ConversationSearchRow {
  return {
    key: c.id,
    title: match ? match.title : c.title.trim() ? [{ text: c.title.trim(), hit: false }] : [],
    agent: match ? match.agent : c.agentName ? [{ text: c.agentName, hit: false }] : [],
    snippet: match?.snippet ?? null,
    when: c.updatedAt,
  };
}

/** 목록 머리 [⋯] 메뉴가 열려 있음을 나타내는 menuFor 값(대화 id 와 겹치지 않는다). */
const LIST_MENU = '\u0000list';

export const Sidebar: React.FC<{
  conversations: XdConversationListItem[];
  /** 대화가 있는 에이전트(에이전트마다 대화 수·마지막 대화), 마지막으로 말한 순서. */
  agentGroups: XdConversationAgent[];
  loaded: boolean;
  onConversations: (update: (list: XdConversationListItem[]) => XdConversationListItem[]) => void;
  /** 열려 있는 대화(없으면 null). */
  conversationId: string | null;
  /** 시작 화면이 열려 있는가([새 채팅] 이 눌린 모양). */
  starting: boolean;
  /** 채팅 기록 관리가 열려 있는가. */
  managing: boolean;
  /** 시작 화면. */
  onNewChat: () => void;
  onManageHistory: () => void;
  onOpenConversation: (agentId: string, conversationId: string) => void;
  onDeleted: (conversationId: string) => void;
}> = ({
  conversations,
  agentGroups,
  loaded,
  onConversations,
  conversationId,
  starting,
  managing,
  onNewChat,
  onManageHistory,
  onOpenConversation,
  onDeleted,
}) => {
  const { agents } = useData();
  const running = useRunning();
  const [renaming, setRenaming] = useState<string | null>(null);
  /** [⋯] 메뉴가 열린 대화. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 목록 아래쪽 줄이면 메뉴를 위로 펼친다(아래로 펼치면 목록 칸에 잘린다). */
  const [menuUp, setMenuUp] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  /** 검색 창에 보인 대화(열 때 id 로 찾는다). */
  const searchFound = useRef(new Map<string, XdConversationListItem>());
  /** [최근 채팅] 에 보이는 수. [더 보기] 마다 늘고 [접기] 로 처음 수. */
  const [shown, setShown] = useState(RECENT_CONVERSATION_STEP);
  /** [에이전트] 에 보이는 수([최근 채팅] 과 같다). */
  const [agentsShown, setAgentsShown] = useState(RECENT_CONVERSATION_STEP);
  /** 접은 칸. */
  const [collapsed, setCollapsed] = useState<CollapsedSections>(() => loadCollapsed());
  /** 들어가 있는 에이전트(그 에이전트의 대화를 보는 중). */
  const [drill, setDrill] = useState<string | null>(null);
  const drillItems = useAgentConversations(drill, conversations);
  const drillAgent = drill ? agents.find((a) => a.id === drill) ?? null : null;

  const recent = recentSlice(conversations, shown);
  const agentRows = recentSlice(agentGroups, agentsShown);
  const recentRows = useMemo(() => conversations.slice(0, SEARCH_RECENT_COUNT).map((c) => searchRow(c)), [conversations]);

  const search = useCallback(async (query: string): Promise<ConversationSearchResultSet> => {
    const res = await xd.conversations.search(query, SEARCH_LIMIT);
    for (const h of res.hits) searchFound.current.set(h.conversation.id, h.conversation);
    return { rows: res.hits.map((h) => searchRow(h.conversation, h.match)), hasMore: res.hasMore, contentSearched: true };
  }, []);

  const openFromSearch = (id: string) => {
    const c = searchFound.current.get(id) ?? conversations.find((x) => x.id === id);
    setSearchOpen(false);
    if (c) onOpenConversation(c.agentId, c.id);
  };

  // 메뉴 바깥을 누르면 닫는다.
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.conv-menu-wrap')) setMenuFor(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuFor]);

  // 이름을 바꾸던 대화가 목록에서 빠지면(지워짐) 칸도 닫는다.
  useEffect(() => {
    if (renaming && !conversations.some((c) => c.id === renaming)) setRenaming(null);
  }, [conversations, renaming]);

  // 들어가 있던 에이전트가 지워지면 목록으로 돌아온다.
  useEffect(() => {
    if (drill && !agents.some((a) => a.id === drill)) setDrill(null);
  }, [agents, drill]);

  const goTo = (agentId: string | null) => {
    setMenuFor(null);
    setRenaming(null);
    setDrill(agentId);
  };

  const toggleSection = (key: keyof CollapsedSections) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setMenuFor(null);
    setRenaming(null);
    setCollapsed(next);
    saveCollapsed(next);
  };

  const rename = (c: XdConversationListItem, title: string | null) => {
    setRenaming(null);
    if (title === null || title.trim() === c.title.trim()) return;
    xd.conversations
      .rename(c.id, title)
      .then((updated) => onConversations((list) => replaceConversation(list, updated)))
      .catch((err) => window.alert(errorText(err, '대화 이름을 바꾸지 못했습니다.')));
  };

  const remove = (c: XdConversationListItem) => {
    if (!window.confirm(`"${conversationTitle(c)}" 대화를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    xd.conversations
      .remove(c.id)
      .then(() => {
        onConversations((list) => dropConversation(list, c.id));
        onDeleted(c.id);
      })
      .catch((err) => window.alert(errorText(err, '대화를 지우지 못했습니다.')));
  };

  /** 대화 한 줄. `meta` 는 제목 위의 작은 줄([최근 채팅] 은 에이전트 이름, 에이전트 안에서는 날). */
  const conversationRow = (c: XdConversationListItem, meta: string) => {
    const live = running.includes(c.id);
    const title = conversationTitle(c);
    const open = () => onOpenConversation(c.agentId, c.id);
    if (renaming === c.id) {
      return (
        <div key={c.id} role="listitem" className={`conv-item xd-conv editing${c.id === conversationId ? ' active' : ''}`}>
          <span className="conv-body">
            <div className="xd-conv-agent">{meta}</div>
            <RenameInput initial={c.title} onDone={(t) => rename(c, t)} />
          </span>
        </div>
      );
    }
    return (
      <div
        key={c.id}
        role="listitem"
        className={`conv-item xd-conv${c.id === conversationId ? ' active' : ''}`}
        tabIndex={0}
        title={title}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && open()}
      >
        <span className="conv-body">
          <div className="xd-conv-agent">
            {meta}
            {live && ' · 답을 만드는 중'}
          </div>
          <div className="conv-name">
            {live && <span className="live-dot live" />}
            {title}
          </div>
        </span>
        <span className={`xd-conv-actions conv-menu-wrap${menuFor === c.id ? ' open' : ''}`}>
          <button
            type="button"
            className="xd-conv-act"
            title="대화 메뉴"
            aria-label="대화 메뉴"
            aria-expanded={menuFor === c.id}
            onClick={(e) => {
              e.stopPropagation();
              const button = e.currentTarget.getBoundingClientRect();
              const list = listRef.current?.getBoundingClientRect();
              setMenuUp(!!list && list.bottom - button.bottom < 96);
              setMenuFor((m) => (m === c.id ? null : c.id));
            }}
          >
            <MoreIcon size={14} />
          </button>
          {menuFor === c.id && (
            <div className={`conv-menu${menuUp ? ' up' : ''}`} role="menu" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                role="menuitem"
                className="conv-menu-item"
                onClick={() => {
                  setMenuFor(null);
                  setRenaming(c.id);
                }}
              >
                이름 바꾸기
              </button>
              <button
                type="button"
                role="menuitem"
                className="conv-menu-item danger"
                disabled={live}
                title={live ? '답을 만드는 중에는 지울 수 없습니다.' : undefined}
                onClick={() => {
                  setMenuFor(null);
                  remove(c);
                }}
              >
                삭제
              </button>
            </div>
          )}
        </span>
      </div>
    );
  };

  const agentRow = (g: XdConversationAgent) => (
    <div
      key={g.agentId}
      role="listitem"
      className="xd-agent-row"
      tabIndex={0}
      title={g.agentName}
      onClick={() => goTo(g.agentId)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && goTo(g.agentId)}
    >
      <span className="xd-agent-body">
        <span className="xd-agent-name">{g.agentName}</span>
        <span className="xd-agent-last">{agentLastLine(g)}</span>
      </span>
      <span className="xd-agent-count">{g.conversationCount}</span>
    </div>
  );

  /** 칸 제목: 누르면 그 칸을 접고 펼친다. */
  const sectionHead = (key: keyof CollapsedSections, label: string) => (
    <h2 className="xd-side-heading">
      <button type="button" className="xd-side-section" aria-expanded={!collapsed[key]} onClick={() => toggleSection(key)}>
        <ChevronRightIcon size={12} className="xd-side-caret" />
        {label}
      </button>
    </h2>
  );

  /** [더 보기] · [접기]: 두 칸이 같다. */
  const moreRow = (slice: { canMore: boolean; canCollapse: boolean }, setCount: React.Dispatch<React.SetStateAction<number>>) =>
    (slice.canMore || slice.canCollapse) && (
      <div className="xd-side-more">
        {slice.canMore && (
          <button type="button" className="xd-side-link" onClick={() => setCount((n) => n + RECENT_CONVERSATION_STEP)}>
            {LIST_TEXT.more}
          </button>
        )}
        {slice.canCollapse && (
          <button type="button" className="xd-side-link" onClick={() => setCount(RECENT_CONVERSATION_STEP)}>
            {LIST_TEXT.collapse}
          </button>
        )}
      </div>
    );

  let body: React.ReactNode;
  if (drill && drillAgent) {
    // 에이전트 하나의 대화: 머리 [←] 이름, 줄에는 에이전트 이름 대신 날.
    body = (
      <>
        <div className="xd-drill-head">
          <button type="button" className="xd-conv-act" title={LIST_TEXT.back} aria-label={LIST_TEXT.back} onClick={() => goTo(null)}>
            <BackIcon size={14} />
          </button>
          <span className="xd-drill-name" title={drillAgent.name}>
            {drillAgent.name}
          </span>
        </div>
        <div className="xd-side-scroll" ref={listRef}>
          {drillItems && drillItems.length === 0 && <div className="muted small xd-side-empty">{LIST_TEXT.noChats}</div>}
          <div className="xd-conv-list" role="list" aria-label={drillAgent.name}>
            {(drillItems ?? []).map((c) => conversationRow(c, conversationDayLabel(c.updatedAt)))}
          </div>
        </div>
      </>
    );
  } else {
    body = (
      <div className="xd-side-scroll" ref={listRef}>
        <div className="xd-side-group">
          {sectionHead('recent', LIST_TEXT.recent)}
          {!collapsed.recent && (
            <>
              {loaded && conversations.length === 0 && <div className="muted small xd-side-empty">아직 대화가 없습니다.</div>}
              <div className="xd-conv-list" role="list" aria-label={LIST_TEXT.recent}>
                {recent.rows.map((c) => conversationRow(c, c.agentName))}
              </div>
              {moreRow(recent, setShown)}
            </>
          )}
        </div>
        <div className="xd-side-group">
          {sectionHead('agents', LIST_TEXT.agents)}
          {!collapsed.agents && (
            <>
              {agentGroups.length === 0 && <div className="muted small pad">{LIST_TEXT.noAgents}</div>}
              <div className="xd-agent-list" role="list" aria-label={LIST_TEXT.agents}>
                {agentRows.rows.map(agentRow)}
              </div>
              {moreRow(agentRows, setAgentsShown)}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <aside className="sidebar xd-sidebar">
      <div className="side-panel">
        <div className="sidebar-title">
          <span className="sidebar-title-text">대화</span>
        </div>
        <div className="xd-side-top">
          <button type="button" className={`conv-item xd-new-chat${starting ? ' active' : ''}`} onClick={() => onNewChat()}>
            <span className="conv-icon">
              <PlusIcon size={14} />
            </span>
            <span className="conv-body">
              <div className="conv-name">새 채팅</div>
            </span>
          </button>
          <button
            type="button"
            className="icon-btn xd-search-open"
            title="채팅 검색"
            aria-label="채팅 검색"
            aria-haspopup="dialog"
            onClick={() => {
              setMenuFor(null);
              searchFound.current.clear();
              setSearchOpen(true);
            }}
          >
            <SearchIcon size={16} />
          </button>
          {/* [⋯] 는 메뉴다(웹·Dex 와 같다). [채팅 기록 관리] 를 골라야 본문에 그 화면이 열린다. XD 에는 사라진 에이전트가
              없어(에이전트를 지우면 대화도 함께 지워진다) [에이전트가 사라진 채팅 제거] 는 없다. */}
          <span className={`conv-menu-wrap${menuFor === LIST_MENU ? ' open' : ''}`}>
            <button
              type="button"
              className={`icon-btn xd-manage-open${managing ? ' active' : ''}`}
              title="채팅 목록 메뉴"
              aria-label="채팅 목록 메뉴"
              aria-expanded={menuFor === LIST_MENU}
              onClick={() => setMenuFor((m) => (m === LIST_MENU ? null : LIST_MENU))}
            >
              <MoreIcon size={16} />
            </button>
            {menuFor === LIST_MENU && (
              <div className="conv-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="conv-menu-item"
                  onClick={() => {
                    setMenuFor(null);
                    onManageHistory();
                  }}
                >
                  {LIST_TEXT.manage}
                </button>
              </div>
            )}
          </span>
        </div>
        {body}
      </div>
      {searchOpen && (
        <ConversationSearchDialog
          recent={recentRows}
          search={search}
          onOpen={openFromSearch}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </aside>
  );
};
