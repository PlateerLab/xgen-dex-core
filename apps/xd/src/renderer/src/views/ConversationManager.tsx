/**
 * 채팅 기록 관리 (2026-10-10). 사이드바 [⋯] 가 본문에 연다(Dex 데스크톱의 '채팅 기록' 탭과 같은 일, 같은 문구).
 *
 * 검색(제목·에이전트 이름·내용, main 의 store.searchConversations), 모두 선택·선택 삭제, 줄마다 [열기]·[이름 바꾸기]·
 * [삭제]. 검색어가 없으면 앱이 들고 있는 대화 목록(사이드바와 같은 것)을 그대로 보이고, 바꾼 것은 그 목록에 싣는다.
 * 그래서 사이드바에 곧바로 보인다.
 *
 * Dex 에 있고 XD 에 없는 것: 상태 필터(배포·삭제됨)와 [에이전트가 사라진 채팅 제거]. XD 는 서버가 없고, 에이전트를
 * 지우면 그 대화도 함께 지워진다. 답을 만드는 중인 대화는 지울 수 없다(main 이 거절한다).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SEARCH_DELAY_MS, conversationDayLabel } from '@dex/protocol';
import type { XdConversationListItem } from '../../../main/store';
import { xd } from '../bridge';
import { LIST_TEXT, deleteNotice, deleteQuestion, freshFound } from '../chat-list-model';
import { errorText } from '../data';
import { RefreshIcon, SearchIcon } from '../dex';
import { useRunning } from '../live-store';
import { conversationTitle, replaceConversation } from '../start-model';
import { RenameInput } from './RenameInput';

/** 검색이 한 번에 받는 결과 수(main 의 상한). */
const SEARCH_LIMIT = 100;
/** 한꺼번에 지울 때 동시에 보내는 요청 수. */
const DELETE_CONCURRENCY = 4;
const RUNNING_TEXT = '답을 만드는 중에는 지울 수 없습니다.';

export const ConversationManager: React.FC<{
  /** 앱의 대화 목록(사이드바와 같은 것), 마지막으로 말한 순서. */
  conversations: XdConversationListItem[];
  loaded: boolean;
  onConversations: (update: (list: XdConversationListItem[]) => XdConversationListItem[]) => void;
  onReload: () => void;
  onOpen: (agentId: string, conversationId: string) => void;
  onDeleted: (conversationId: string) => void;
}> = ({ conversations, loaded, onConversations, onReload, onOpen, onDeleted }) => {
  const running = useRunning();
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  /** 찾은 대화(검색어가 있을 때). 새 결과가 올 때까지 앞 결과를 그대로 둔다. */
  const [found, setFound] = useState<{ items: XdConversationListItem[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const seqRef = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setError(false);
    try {
      const res = await xd.conversations.search(q, SEARCH_LIMIT);
      if (seq !== seqRef.current) return;
      setFound({ items: res.hits.map((h) => h.conversation), hasMore: res.hasMore });
    } catch (e) {
      if (seq !== seqRef.current) return;
      console.warn('[xd] history search', e);
      setError(true);
    }
  }, []);

  // 검색어가 바뀌면 고른 것을 비우고, 적기를 멈춘 뒤 찾는다. 검색어를 비우면 목록으로.
  useEffect(() => {
    setSelected(new Set());
    if (!trimmed) {
      seqRef.current += 1;
      setFound(null);
      setError(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(trimmed), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [trimmed, runSearch]);

  // 안내 한 줄은 잠시 뒤 사라진다.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(id);
  }, [notice]);

  // 찾은 대화도 지금 목록에 맞춘다(그 사이 바뀐 이름, 지워진 대화).
  const items = trimmed ? (found ? freshFound(found.items, conversations) : []) : conversations;
  const waiting = trimmed ? !found && !error : !loaded;

  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((c) => c.id)));
  const toggleOne = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const refresh = () => {
    onReload();
    if (trimmed) void runSearch(trimmed);
  };

  const deleteMany = async (targets: XdConversationListItem[]) => {
    if (!targets.length || busy) return;
    if (!window.confirm(deleteQuestion(targets))) return;
    setBusy(true);
    // 답을 만드는 중인 대화는 보내지 않는다(main 도 거절한다).
    const live = targets.filter((c) => running.includes(c.id));
    const sendable = targets.filter((c) => !running.includes(c.id));
    const failed = new Set(live.map((c) => c.id));
    try {
      for (let i = 0; i < sendable.length; i += DELETE_CONCURRENCY) {
        const batch = sendable.slice(i, i + DELETE_CONCURRENCY);
        const results = await Promise.allSettled(batch.map((c) => xd.conversations.remove(c.id)));
        results.forEach((r, j) => {
          if (r.status === 'rejected') {
            console.warn('[xd] delete conversation', r.reason);
            failed.add(batch[j].id);
          }
        });
      }
      const gone = targets.filter((c) => !failed.has(c.id));
      const goneIds = new Set(gone.map((c) => c.id));
      if (gone.length) {
        onConversations((list) => list.filter((c) => !goneIds.has(c.id)));
        setSelected((cur) => new Set([...cur].filter((id) => !goneIds.has(id))));
        for (const c of gone) onDeleted(c.id);
      }
      setNotice(deleteNotice({ deleted: gone.length, failed: failed.size, running: live.length }));
    } finally {
      setBusy(false);
    }
  };

  const rename = (c: XdConversationListItem, title: string | null) => {
    setEditing(null);
    if (title === null || title.trim() === c.title.trim()) return;
    xd.conversations
      .rename(c.id, title)
      .then((updated) => onConversations((list) => replaceConversation(list, updated)))
      .catch((e) => setNotice(errorText(e, '이름을 바꾸지 못했습니다.')));
  };

  const selectedItems = items.filter((c) => selected.has(c.id));

  return (
    <div className="conv-manager">
      <div className="conv-manager-head">
        <h2 className="conv-manager-title">{LIST_TEXT.manage}</h2>
        <button type="button" className="icon-btn sm" title="새로고침" aria-label="새로고침" onClick={refresh}>
          <RefreshIcon size={14} />
        </button>
      </div>

      <div className="conv-manager-toolbar">
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
      </div>

      <div className="conv-manager-bar">
        <label className="conv-manager-check">
          <input type="checkbox" checked={allSelected} disabled={items.length === 0 || busy} onChange={toggleAll} />
          모두 선택
        </label>
        {!waiting && !error && <span className="muted">총 {items.length}개</span>}
        {selectedItems.length > 0 && (
          <span className="conv-manager-selected">
            <strong>{selectedItems.length}개 선택</strong>
            <button type="button" className="conv-manager-delete" onClick={() => void deleteMany(selectedItems)} disabled={busy}>
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
            채팅 기록을 불러오지 못했습니다.{' '}
            <button type="button" className="link" onClick={refresh}>
              다시 시도
            </button>
          </div>
        ) : waiting && items.length === 0 ? (
          <div className="muted small pad">불러오는 중…</div>
        ) : items.length === 0 ? (
          <div className="muted small pad">{trimmed ? '맞는 채팅이 없습니다.' : '채팅 기록이 없습니다.'}</div>
        ) : (
          items.map((c) => {
            const checked = selected.has(c.id);
            const title = conversationTitle(c);
            const live = running.includes(c.id);
            return (
              <div key={c.id} className={`conv-manager-row${checked ? ' selected' : ''}`}>
                <input type="checkbox" aria-label={title} checked={checked} disabled={busy} onChange={() => toggleOne(c.id)} />
                <div className="conv-manager-main">
                  {editing === c.id ? (
                    <RenameInput initial={c.title} onDone={(t) => rename(c, t)} />
                  ) : (
                    <span className="conv-manager-row-title" title={title}>
                      {title}
                    </span>
                  )}
                  <span className="conv-row-agent">
                    <span className="conv-row-agent-name">{c.agentName}</span>
                    {live && <span className="live-dot active live conv-row-live" title="답을 만드는 중" />}
                  </span>
                </div>
                <span className="conv-manager-when">{conversationDayLabel(c.updatedAt)}</span>
                <span className="conv-manager-actions">
                  <button type="button" className="conv-manager-btn" onClick={() => onOpen(c.agentId, c.id)} disabled={busy}>
                    열기
                  </button>
                  <button type="button" className="conv-manager-btn" onClick={() => setEditing(c.id)} disabled={busy}>
                    이름 바꾸기
                  </button>
                  <button
                    type="button"
                    className="conv-manager-btn danger"
                    onClick={() => void deleteMany([c])}
                    disabled={busy || live}
                    title={live ? RUNNING_TEXT : undefined}
                  >
                    삭제
                  </button>
                </span>
              </div>
            );
          })
        )}
        {trimmed && found?.hasMore && !error && (
          <div className="muted small pad">맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.</div>
        )}
      </div>
    </div>
  );
};
