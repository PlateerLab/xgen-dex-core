/**
 * 채팅 검색 창 (2026-10-10). 대화 목록 머리의 돋보기가 연다. 데스크톱과 XD 가 같이 쓴다.
 *
 *   [돋보기] 검색...                       [지우기] | [X]
 *   최근 채팅                     ← 검색어가 비었을 때
 *   (말풍선) 대화 제목                                  날
 *            에이전트 이름 · 맞은 자리 둘레의 한 줄
 *
 * 무엇을 어떻게 찾는지는 부르는 쪽이 준 `search` 가 정한다(데스크톱은 서버, XD 는 제 저장소).
 * 낱말·강조 조각 규칙은 @dex/protocol conversation-search 한 곳이다. 이 창은 그리기만 한다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SEARCH_DELAY_MS, conversationDayLabel, searchHasHit, type SearchTextPart } from '@dex/protocol';
import { ChatIcon, CloseIcon, SearchIcon } from '../brand/icons';

/** 창의 한 줄. 데스크톱(서버 대화)과 XD(제 대화)가 이 모양으로 맞춰 넘긴다. */
export interface ConversationSearchRow {
  key: string;
  /** 제목 조각. 비면 "새 대화". */
  title: SearchTextPart[];
  /** 에이전트 이름 조각. */
  agent: SearchTextPart[];
  /** 에이전트가 사라졌다. [지워짐] 이 붙고 이름은 이름이 맞았을 때만 보인다. */
  agentDeleted?: boolean;
  /** 꼬리표 글(배포·Teams …). */
  tag?: string | null;
  /** 맞은 자리 둘레의 한 줄. */
  snippet: SearchTextPart[] | null;
  /** 마지막으로 말한 때. */
  when: string | number | null;
}

export interface ConversationSearchResultSet {
  rows: ConversationSearchRow[];
  hasMore: boolean;
  /** 내용까지 찾았는가(옛 서버는 제목·이름만). */
  contentSearched: boolean;
}

const Highlighted: React.FC<{ parts: SearchTextPart[] }> = ({ parts }) => (
  <>
    {parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}
  </>
);

export const ConversationSearchDialog: React.FC<{
  /** 검색어가 비었을 때 보여 줄 최근 채팅. */
  recent: ConversationSearchRow[];
  search: (query: string) => Promise<ConversationSearchResultSet>;
  onOpen: (key: string) => void;
  onClose: () => void;
}> = ({ recent, search, onOpen, onClose }) => {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ConversationSearchResultSet | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const trimmed = query.trim();

  useEffect(() => {
    const seq = ++seqRef.current;
    if (!trimmed) {
      setResult(null);
      setSearching(false);
      setFailed(null);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      search(trimmed)
        .then((res) => {
          if (seq !== seqRef.current) return;
          setResult(res);
          setFailed(null);
          setActive(0);
        })
        .catch((e: unknown) => {
          if (seq !== seqRef.current) return;
          setFailed(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq === seqRef.current) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed, search]);

  const rows = trimmed ? (result?.rows ?? []) : recent;

  useEffect(() => {
    setActive((i) => (rows.length ? Math.min(i, rows.length - 1) : 0));
  }, [rows.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = useCallback(
    (row: ConversationSearchRow | undefined) => {
      if (row) onOpen(row.key);
    },
    [onOpen],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(rows[active]);
    }
  };

  let status: string | null = null;
  if (trimmed) {
    if (failed) status = `검색하지 못했습니다. ${failed}`.trim();
    else if (!result || (searching && rows.length === 0)) status = '검색 중';
    else if (rows.length === 0) status = '맞는 채팅이 없습니다.';
  }

  return (
    <div className="modal-backdrop conv-search-backdrop" onMouseDown={onClose}>
      <div
        className="conv-search"
        role="dialog"
        aria-modal="true"
        aria-label="채팅 검색"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="conv-search-head">
          <SearchIcon size={18} className="conv-search-glyph" />
          <input
            ref={inputRef}
            className="conv-search-input"
            placeholder="검색..."
            aria-label="채팅 검색"
            value={query}
            maxLength={200}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="conv-search-clear"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              지우기
            </button>
          )}
          <span className="conv-search-sep" aria-hidden />
          <button className="icon-btn" title="닫기" aria-label="닫기" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="conv-search-body" ref={listRef}>
          {!trimmed && rows.length > 0 && <div className="conv-search-label">최근 채팅</div>}
          {status && (
            <div className="conv-search-status" role="status">
              {status}
            </div>
          )}
          {trimmed && result && !result.contentSearched && !failed && (
            <div className="conv-search-note">이 서버는 제목·에이전트 이름으로만 찾습니다.</div>
          )}
          {rows.map((row, index) => {
            const agentHit = searchHasHit(row.agent);
            return (
              <button
                key={row.key}
                data-row={index}
                className={`conv-search-row ${index === active ? 'active' : ''}`}
                onMouseMove={() => {
                  if (index !== active) setActive(index);
                }}
                onClick={() => choose(row)}
              >
                <ChatIcon size={17} className="conv-search-row-icon" />
                <span className="conv-search-row-main">
                  <span className="conv-search-row-top">
                    <span className="conv-search-row-title">
                      {row.title.length ? <Highlighted parts={row.title} /> : '새 대화'}
                    </span>
                    <span className="conv-search-row-when">{conversationDayLabel(row.when)}</span>
                  </span>
                  <span className="conv-search-row-sub">
                    {row.agentDeleted && <span className="conv-tag deleted">지워짐</span>}
                    {row.agent.length > 0 && (!row.agentDeleted || agentHit) && (
                      <span className="conv-search-row-agent">
                        <Highlighted parts={row.agent} />
                      </span>
                    )}
                    {row.tag && <span className="conv-tag">{row.tag}</span>}
                    {row.snippet && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="conv-search-row-snippet">
                          <Highlighted parts={row.snippet} />
                        </span>
                      </>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
          {trimmed && result?.hasMore && !failed && (
            <div className="conv-search-note">맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.</div>
          )}
        </div>
      </div>
    </div>
  );
};
