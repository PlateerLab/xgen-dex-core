/** 사이드바 — 에이전트와, 고른 에이전트의 대화. 도는 대화에는 표시가 붙는다(Dex 사이드바와 같은 CSS). */
import React, { useEffect, useState } from 'react';
import type { XdConversation } from '../../../main/store';
import { xd } from '../bridge';
import { errorText, useData } from '../data';
import { BotIcon, ChatIcon, HistoryIcon, PlusIcon, TrashIcon, Tooltip } from '../dex';
import { liveStore, useRunning } from '../live-store';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return new Date(ms).toLocaleDateString();
}

export const Sidebar: React.FC<{
  agentId: string | null;
  conversationId: string | null;
  onOpenAgent: (agentId: string) => void;
  onOpenConversation: (agentId: string, conversationId: string | null) => void;
  onNewAgent: () => void;
}> = ({ agentId, conversationId, onOpenAgent, onOpenConversation, onNewAgent }) => {
  const { agents } = useData();
  const running = useRunning();
  const [conversations, setConversations] = useState<XdConversation[]>([]);
  // 턴이 끝날 때마다(제목·순서가 바뀐다) 목록을 다시 읽는다 — 끝난 횟수를 합쳐 판으로 쓴다.
  const finishedKey = running.join(',') + ':' + conversations.map((c) => liveStore.conversationVersion(c.id)).join(',');

  useEffect(() => {
    if (!agentId) {
      setConversations([]);
      return;
    }
    let alive = true;
    xd.conversations
      .list(agentId)
      .then((list) => alive && setConversations(list))
      .catch((e) => console.warn('[xd] conversations', e));
    return () => {
      alive = false;
    };
  }, [agentId, finishedKey, conversationId]);

  return (
    <aside className="sidebar xd-sidebar">
      <div className="side-panel">
        <div className="sidebar-title">
          <span className="sidebar-title-text">에이전트</span>
          <div className="sidebar-title-actions">
            <Tooltip label="새 에이전트" side="bottom">
              <button type="button" className="icon-btn sm" aria-label="새 에이전트" onClick={onNewAgent}>
                <PlusIcon size={15} />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="agent-list xd-agent-list">
          {agents.length === 0 && <div className="muted small pad">아직 에이전트가 없습니다.</div>}
          {agents.map((a) => (
            <React.Fragment key={a.id}>
              <button
                type="button"
                className={`conv-item xd-agent-item${a.id === agentId ? ' active' : ''}`}
                onClick={() => onOpenAgent(a.id)}
              >
                <span className="conv-icon">
                  <BotIcon size={15} />
                </span>
                <span className="conv-body">
                  <div className="conv-name">{a.name}</div>
                  <div className="conv-meta">{a.model || '모델 없음'}</div>
                </span>
              </button>
              {a.id === agentId && (
                <div className="xd-conversations">
                  <button
                    type="button"
                    className={`conv-item xd-new-chat${conversationId === null ? ' active' : ''}`}
                    onClick={() => onOpenConversation(a.id, null)}
                  >
                    <span className="conv-icon">
                      <ChatIcon size={14} />
                    </span>
                    <span className="conv-body">
                      <div className="conv-name">새 대화</div>
                    </span>
                  </button>
                  {conversations.map((c) => {
                    const live = running.includes(c.id);
                    return (
                      <div
                        key={c.id}
                        className={`conv-item${c.id === conversationId ? ' active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpenConversation(a.id, c.id)}
                        onKeyDown={(e) => e.key === 'Enter' && onOpenConversation(a.id, c.id)}
                      >
                        <span className="conv-icon">
                          <HistoryIcon size={14} />
                        </span>
                        <span className="conv-body">
                          <div className="conv-name">
                            {live && <span className="live-dot live" />}
                            {c.title || '제목 없는 대화'}
                          </div>
                          <div className="conv-meta">{live ? '답을 만드는 중' : relativeTime(c.updatedAt)}</div>
                        </span>
                        {!live && (
                          <button
                            type="button"
                            className="conv-end"
                            title="대화 지우기"
                            aria-label="대화 지우기"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!window.confirm('이 대화를 지울까요?')) return;
                              xd.conversations
                                .remove(c.id)
                                .then(() => {
                                  setConversations((list) => list.filter((x) => x.id !== c.id));
                                  if (c.id === conversationId) onOpenConversation(a.id, null);
                                })
                                .catch((err) => window.alert(errorText(err, '대화를 지우지 못했습니다.')));
                            }}
                          >
                            <TrashIcon size={13} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </aside>
  );
};
