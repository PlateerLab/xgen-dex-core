/**
 * 채팅 기록 관리 탭 (2026-10-10). 사이드바 [채팅] 목록 머리의 ⋯ 가 연다(하나뿐인 탭, id 'history').
 *
 * 웹의 채팅 기록 관리 창과 같은 일을 한다: 상태 필터(전체·활성·배포·삭제됨), 검색, 모두 선택·선택 삭제, 줄마다
 * 열기(보기)·이름 바꾸기·삭제, 에이전트가 사라진 채팅 제거. 목록·검색·필터 규칙은 서버가 정한다
 * (@dex/protocol history.conversationPage·searchConversations 의 kind). 바꾼 것은 사이드바 목록에 곧바로 알린다.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONVERSATION_TAG_LABELS,
  DELETED_AGENT_LABEL,
  SEARCH_DELAY_MS,
  conversationDayLabel,
  conversationDisplayTitle,
  conversationKey,
  type Conversation,
  type ConversationKind,
} from '@dex/protocol';
import { xgen } from '../bridge';
import { sessionStore } from '../session';
import { agentForConversation } from '../agent-directory';
import { emitConversationListEvent } from '../conversation-events';
import { RefreshIcon, SearchIcon } from '../brand/icons';
import { Selector, type SelectorOption } from './Selector';

const PAGE_SIZE = 50;
const SEARCH_LIMIT = 100;
/** 한꺼번에 지울 때 동시에 보내는 요청 수. */
const DELETE_CONCURRENCY = 4;

const KIND_OPTIONS: SelectorOption[] = [
  { value: 'all', label: '전체' },
  { value: 'active', label: '활성' },
  { value: 'deploy', label: '배포' },
  { value: 'deleted', label: '삭제됨' },
];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const ConversationManager: React.FC = () => {
  const [kind, setKind] = useState<ConversationKind>('all');
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const renameCancelledRef = useRef(false);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      if (trimmed) {
        const page = await xgen.history.search(trimmed, { limit: SEARCH_LIMIT, kind });
        if (seq !== seqRef.current) return;
        setItems(page.hits.map((h) => h.conversation));
        setCursor(null);
        setTotal(page.hits.length);
        setSearchHasMore(page.hasMore);
      } else {
        const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, kind });
        if (seq !== seqRef.current) return;
        setItems(page.conversations);
        setCursor(page.nextCursor);
        setTotal(page.total ?? null);
        setSearchHasMore(false);
        setDeletedCount(page.agentDeletedCount ?? 0);
      }
    } catch (e) {
      if (seq === seqRef.current) setError(errorText(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [kind, trimmed]);

  // 필터·검색이 바뀌면 처음부터 다시 읽는다(검색은 적기를 멈춘 뒤). 고른 것은 비운다.
  useEffect(() => {
    setSelected(new Set());
    const timer = window.setTimeout(() => void load(), trimmed ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [load, trimmed]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const loadMore = async () => {
    if (!cursor || loadingMore || trimmed) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const page = await xgen.history.conversationPage({ limit: PAGE_SIZE, kind, cursor });
      if (seq !== seqRef.current) return;
      setItems((cur) => {
        const seen = new Set(cur.map(conversationKey));
        return [...cur, ...page.conversations.filter((c) => !seen.has(conversationKey(c)))];
      });
      setCursor(page.nextCursor);
    } catch (e) {
      setNotice(`더 불러오지 못했습니다. ${errorText(e)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  const allSelected = items.length > 0 && items.every((c) => selected.has(conversationKey(c)));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map(conversationKey)));
  const toggleOne = (key: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const open = (c: Conversation) => {
    sessionStore.openResume(agentForConversation(c), c.interactionId, c.workflowName, {
      title: c.title,
      agentDeleted: c.agentDeleted,
    });
  };

  const deleteMany = async (targets: Conversation[]) => {
    if (!targets.length || busy) return;
    const question =
      targets.length === 1
        ? `"${conversationDisplayTitle(targets[0])}" 대화를 삭제할까요? 되돌릴 수 없습니다.`
        : `선택한 채팅 ${targets.length}개를 삭제할까요? 되돌릴 수 없습니다.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    const failed: Conversation[] = [];
    try {
      for (let i = 0; i < targets.length; i += DELETE_CONCURRENCY) {
        const batch = targets.slice(i, i + DELETE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((c) => xgen.history.remove(c.workflowId, c.interactionId, c.workflowName)),
        );
        results.forEach((r, j) => {
          if (r.status === 'rejected') failed.push(batch[j]);
        });
      }
      const failedKeys = new Set(failed.map(conversationKey));
      const gone = targets.filter((c) => !failedKeys.has(conversationKey(c)));
      const goneKeys = new Set(gone.map(conversationKey));
      setItems((cur) => cur.filter((c) => !goneKeys.has(conversationKey(c))));
      setSelected((cur) => new Set([...cur].filter((k) => !goneKeys.has(k))));
      setTotal((n) => (n == null ? n : Math.max(0, n - gone.length)));
      const goneDeleted = gone.filter((c) => c.agentDeleted).length;
      if (goneDeleted) setDeletedCount((n) => Math.max(0, n - goneDeleted));
      // 열려 있던 탭도 닫는다. 지운 대화가 탭으로 남으면 눌러도 빈 대화다.
      for (const c of gone) if (sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
      if (gone.length) emitConversationListEvent({ type: 'removed', items: gone });
      if (failed.length) setNotice(`채팅 ${failed.length}개는 삭제하지 못했습니다.`);
      else if (gone.length > 1) setNotice(`채팅 ${gone.length}개를 삭제했습니다.`);
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    if (deletedCount <= 0 || busy) return;
    if (!window.confirm(`에이전트가 사라진 채팅 ${deletedCount}개를 모두 지웁니다. 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    try {
      const removed = await xgen.history.purgeDeletedAgents();
      for (const c of items) {
        if (c.agentDeleted && sessionStore.get(c.interactionId)) sessionStore.endChat(c.interactionId);
      }
      setDeletedCount(0);
      emitConversationListEvent({ type: 'purged' });
      setNotice(`채팅 ${removed}개를 정리했습니다.`);
      await load();
    } catch (e) {
      setNotice(`채팅 정리에 실패했습니다. ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const startRename = (c: Conversation) => {
    renameCancelledRef.current = false;
    setEditingKey(conversationKey(c));
    setDraft(c.title);
  };

  const commitRename = async (c: Conversation) => {
    setEditingKey(null);
    if (renameCancelledRef.current) return;
    const next = draft.split(/\s+/).filter(Boolean).join(' ');
    if (next === c.title) return;
    try {
      const res = await xgen.history.rename(c.workflowId, c.interactionId, next);
      setItems((cur) =>
        cur.map((x) =>
          conversationKey(x) === conversationKey(c) ? { ...x, title: res.title, customTitle: res.customTitle } : x,
        ),
      );
      sessionStore.applyConversationInfo([{ interactionId: c.interactionId, title: res.title }]);
      emitConversationListEvent({
        type: 'renamed',
        workflowId: c.workflowId,
        interactionId: c.interactionId,
        title: res.title,
        customTitle: res.customTitle,
      });
    } catch (e) {
      setNotice(`이름을 바꾸지 못했습니다. ${errorText(e)}`);
    }
  };

  const selectedItems = items.filter((c) => selected.has(conversationKey(c)));

  return (
    <div className="conv-manager">
      <div className="conv-manager-head">
        <h2 className="conv-manager-title">채팅 기록 관리</h2>
        <button className="icon-btn sm" title="새로고침" aria-label="새로고침" onClick={() => void load()}>
          <RefreshIcon size={14} />
        </button>
      </div>

      <div className="conv-manager-toolbar">
        <Selector
          className="conv-manager-kind"
          value={kind}
          onChange={(v) => setKind(v as ConversationKind)}
          options={KIND_OPTIONS}
          ariaLabel="상태"
        />
        <label className="conv-manager-search">
          <SearchIcon size={15} />
          <input
            placeholder="제목·에이전트 이름·내용으로 검색"
            aria-label="채팅 기록 검색"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="conv-manager-purge"
          onClick={() => void purge()}
          disabled={busy || deletedCount === 0}
          title={deletedCount === 0 ? '정리할 채팅이 없습니다.' : undefined}
        >
          에이전트가 사라진 채팅 제거 ({deletedCount})
        </button>
      </div>

      <div className="conv-manager-bar">
        <label className="conv-manager-check">
          <input type="checkbox" checked={allSelected} disabled={items.length === 0 || busy} onChange={toggleAll} />
          모두 선택
        </label>
        {total != null && <span className="muted">총 {total}개</span>}
        {selectedItems.length > 0 && (
          <span className="conv-manager-selected">
            <strong>{selectedItems.length}개 선택</strong>
            <button className="conv-manager-delete" onClick={() => void deleteMany(selectedItems)} disabled={busy}>
              선택 삭제
            </button>
          </span>
        )}
      </div>

      {notice && (
        <div className="conv-notice small" role="status">
          {notice}
        </div>
      )}

      <div className="conv-manager-list">
        {error ? (
          <div className="error small pad">
            채팅 기록을 불러오지 못했습니다. {error}{' '}
            <button className="link" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="muted small pad">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="muted small pad">{trimmed ? '맞는 채팅이 없습니다.' : '채팅 기록이 없습니다.'}</div>
        ) : (
          items.map((c) => {
            const key = conversationKey(c);
            const checked = selected.has(key);
            const title = conversationDisplayTitle(c);
            return (
              <div key={key} className={`conv-manager-row ${checked ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  aria-label={title}
                  checked={checked}
                  disabled={busy}
                  onChange={() => toggleOne(key)}
                />
                <div className="conv-manager-main">
                  {editingKey === key ? (
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
                  ) : (
                    <span className="conv-manager-row-title" title={title}>
                      {title}
                    </span>
                  )}
                  <span className="conv-row-agent">
                    {c.agentDeleted ? (
                      <span className="conv-tag deleted">{DELETED_AGENT_LABEL}</span>
                    ) : (
                      <span className="conv-row-agent-name">{c.workflowName}</span>
                    )}
                    {c.tag && <span className="conv-tag">{CONVERSATION_TAG_LABELS[c.tag]}</span>}
                  </span>
                </div>
                <span className="conv-manager-when">{conversationDayLabel(c.updatedAt || c.createdAt)}</span>
                <span className="conv-manager-actions">
                  <button className="conv-manager-btn" onClick={() => open(c)} disabled={busy}>
                    {c.agentDeleted ? '대화 보기' : '열기'}
                  </button>
                  <button className="conv-manager-btn" onClick={() => startRename(c)} disabled={busy}>
                    이름 바꾸기
                  </button>
                  <button className="conv-manager-btn danger" onClick={() => void deleteMany([c])} disabled={busy}>
                    삭제
                  </button>
                </span>
              </div>
            );
          })
        )}
        {cursor && !trimmed && !error && (
          <div className="conv-manager-more">
            <button className="conv-manager-btn" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? '더 불러오는 중' : '더 보기'}
            </button>
          </div>
        )}
        {trimmed && searchHasMore && !error && (
          <div className="muted small pad">맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.</div>
        )}
      </div>
    </div>
  );
};
