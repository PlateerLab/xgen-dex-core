/**
 * AgentPanel — 사이드바 [Agent] 뷰. 예전 Workspace 사이드바의 에이전트 목록
 * 그대로다: 검색 → 필터 → 목록 → (선택 시) 그 에이전트의 세션 선택기 드릴다운.
 *
 * 상태(목록·페이지·선택)는 전부 이 패널이 소유한다 — Workspace 는 뷰 전환만
 * 한다. 패널은 뷰가 탐색기로 바뀌어도 **언마운트되지 않고 숨겨질 뿐**이라
 * (orca 가 겪은 패널 리마운트 IPC 폭주의 교훈), 목록·스크롤·드릴다운이
 * 전환 사이에 유지되고 최초 자동 랜딩도 뷰와 무관하게 동작한다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { sessionStore, useSessions } from '../session';
import {
  agentSessions,
  isKeepable,
  openSessions,
  sessionDotState,
  type SessionState,
} from '../session-store';
import type { Agent, Conversation } from '../../../core/index';
import type { ConnectorConfig } from '../../../main/config';
import { BackIcon, ChatIcon, CloseIcon, HistoryIcon, PlusIcon, RefreshIcon } from '../brand/icons';

function relativeTime(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(t).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

/** 세션 미리보기 — 마지막 내용 한 줄 (방어적: 문자열이 아니어도 던지지 않는다). */
function sessionPreview(s: SessionState): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const raw = s.messages[i].text;
    const t = (typeof raw === 'string' ? raw : raw == null ? '' : String(raw)).trim();
    if (t) return t.length > 42 ? `${t.slice(0, 42)}…` : t;
  }
  return '새 대화';
}

/** 목록에 있으면 그 에이전트를, 없으면 대화 기록에서 합성한다. */
function synthAgent(c: Conversation, agents: Agent[]): Agent {
  return (
    agents.find((a) => a.workflowId === c.workflowId) ?? {
      id: c.id,
      workflowId: c.workflowId,
      workflowName: c.workflowName,
      nodeCount: 0,
      isShared: false,
      isDeployed: false,
      isCompleted: true,
      workflowType: 'canvas',
      description: '',
      username: '',
      fullName: '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }
  );
}

export const AgentPanel: React.FC<{ config: ConnectorConfig }> = ({ config }) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<'all' | 'personal' | 'shared'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convLoading, setConvLoading] = useState(false);

  // 드릴다운: null = 목록(1단계), 에이전트 = 그 세션 선택기(2단계)
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const { sessions, activeKey } = useSessions();
  const activeSession = activeKey ? (sessions.find((s) => s.key === activeKey) ?? null) : null;
  // 열린 세션(활성 에이전트) — 최근 활동순. 목록 상단에 항상 보여 준다.
  const open = useMemo(() => openSessions(sessions), [sessions]);

  // idle 상태 점(회색=삭제 예정)이 시간 경과에 따라 갱신되도록 now 를 주기적으로
  // 올린다 — 스트리밍/메시지 없이도 idle 임계를 넘기면 색이 바뀌어야 하기 때문.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      setError(null);
      try {
        const res = await xgen.agents.list({
          page: p,
          pageSize: 24,
          search: search || undefined,
          owner: owner === 'all' ? undefined : owner,
        });
        setAgents(res.items);
        setTotalPages(res.pagination.totalPages);
        setPage(res.pagination.page);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, owner],
  );

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, owner]);

  const loadConversations = useCallback(async () => {
    setConvLoading(true);
    try {
      setConversations(await xgen.history.conversations());
    } catch {
      /* 조용히 실패 — 이어보기 목록이 없을 뿐 새 대화는 가능하다 */
    } finally {
      setConvLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // 랜딩: 최초 로드 때 마지막(또는 첫) 에이전트와의 대화를 바로 연다. 한 번만.
  const landedRef = useRef(false);
  useEffect(() => {
    if (landedRef.current || loading || agents.length === 0) return;
    landedRef.current = true;
    if (activeKey || sessions.some(isKeepable)) return;
    const last = agents.find((a) => a.workflowId === config.lastWorkflowId);
    sessionStore.openNew(last ?? agents[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, loading]);

  const rememberAgent = useCallback((a: Agent) => {
    void xgen.config.set({ lastWorkflowId: a.workflowId });
  }, []);

  const clickAgent = useCallback(
    (a: Agent) => {
      rememberAgent(a);
      const live = agentSessions(sessions, a.workflowId);
      const past = conversations.filter((c) => c.workflowId === a.workflowId);
      if (live.length > 0 || past.length > 0) {
        setSelectedAgent(a);
      } else {
        sessionStore.openNew(a);
      }
    },
    [sessions, conversations, rememberAgent],
  );

  const startNew = useCallback(
    (a: Agent) => {
      rememberAgent(a);
      sessionStore.openNew(a);
      setSelectedAgent(null);
    },
    [rememberAgent],
  );

  const resumeConversation = useCallback(
    (c: Conversation) => {
      const agent = synthAgent(c, agents);
      rememberAgent(agent);
      sessionStore.openResume(agent, c.interactionId, c.workflowName);
      // 드릴다운을 닫지 않는다 — 여기서 여러 대화를 연달아 열 수 있어야 한다.
      // (탭은 메인 영역에 쌓이고, 이 목록은 계속 골라 담는 곳으로 남는다.)
    },
    [agents, rememberAgent],
  );

  const focusSession = useCallback((key: string) => {
    sessionStore.setActive(key);
  }, []);

  // 2단계(선택된 에이전트) 데이터.
  const selectedLive = selectedAgent ? agentSessions(sessions, selectedAgent.workflowId) : [];
  const selectedLiveIds = useMemo(
    () => new Set(selectedLive.map((s) => s.interactionId)),
    [selectedLive],
  );
  const selectedPast = selectedAgent
    ? conversations.filter(
        (c) => c.workflowId === selectedAgent.workflowId && !selectedLiveIds.has(c.interactionId),
      )
    : [];

  return (
    <div className="side-panel">
      <div className="sidebar-title">
        <span className="sidebar-title-text">Agent</span>
        <span className="sidebar-title-actions">
          <button
            className="icon-btn sm"
            title="새로고침"
            onClick={() => {
              void load(page);
              void loadConversations();
            }}
          >
            <RefreshIcon size={14} />
          </button>
        </span>
      </div>

      {selectedAgent ? (
        <>
          <div className="drill-head">
            <button className="icon-btn" title="목록으로" onClick={() => setSelectedAgent(null)}>
              <BackIcon size={18} />
            </button>
            <div className="drill-title" title={selectedAgent.workflowName}>
              {selectedAgent.workflowName}
            </div>
          </div>

          <div className="agent-list">
            <button className="new-chat-btn" onClick={() => startNew(selectedAgent)}>
              <PlusIcon size={16} /> 새 대화 시작
            </button>

            {selectedLive.length > 0 && (
              <>
                <div className="list-label">진행 중인 대화</div>
                {selectedLive.map((s) => (
                  <div
                    key={s.key}
                    className={`conv-item ${activeKey === s.key ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => focusSession(s.key)}
                    onKeyDown={(e) => e.key === 'Enter' && focusSession(s.key)}
                  >
                    <span className="conv-icon">
                      <ChatIcon size={15} />
                    </span>
                    <span className="conv-body">
                      <div className="conv-name">
                        <span
                          className={`live-dot ${sessionDotState(s, now)}${s.streaming ? ' live' : ''}`}
                        />
                        {sessionPreview(s)}
                      </div>
                      <div className="conv-meta">{s.streaming ? '응답 중…' : '열려 있음'}</div>
                    </span>
                    <button
                      className="conv-end"
                      title="채팅 종료"
                      onClick={(e) => {
                        e.stopPropagation();
                        sessionStore.endChat(s.key);
                      }}
                    >
                      <CloseIcon size={13} />
                    </button>
                  </div>
                ))}
              </>
            )}

            {selectedPast.length > 0 && (
              <>
                <div className="list-label">이전 대화</div>
                {selectedPast.map((c) => (
                  <button
                    key={c.interactionId}
                    className="conv-item"
                    onClick={() => resumeConversation(c)}
                  >
                    <span className="conv-icon">
                      <HistoryIcon size={15} />
                    </span>
                    <span className="conv-body">
                      <div className="conv-name">{c.workflowName || '대화'}</div>
                      <div className="conv-meta">
                        {relativeTime(c.updatedAt || c.createdAt)}
                        {c.interactionCount ? ` · ${c.interactionCount}개 대화` : ''}
                      </div>
                    </span>
                  </button>
                ))}
              </>
            )}

            {convLoading && selectedPast.length === 0 && selectedLive.length === 0 && (
              <div className="muted small pad">불러오는 중…</div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* 활성 에이전트(열린 대화) — 어느 에이전트를 보다가도 지금 열려 있는
              대화를 바로 되돌아갈 수 있게 목록 위에 고정한다. */}
          {open.length > 0 && (
            <div className="open-sessions">
              <div className="list-label">진행 중인 대화</div>
              {open.map((s) => (
                <div
                  key={s.key}
                  className={`open-item ${activeKey === s.key ? 'active' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => focusSession(s.key)}
                  onKeyDown={(e) => e.key === 'Enter' && focusSession(s.key)}
                  title={sessionPreview(s)}
                >
                  <span
                    className={`open-dot ${sessionDotState(s, now)}${s.streaming ? ' live' : ''}`}
                    title={
                      sessionDotState(s, now) === 'error'
                        ? '오류로 끝난 대화'
                        : sessionDotState(s, now) === 'idle'
                          ? 'idle — 곧 정리됩니다'
                          : '활성 대화'
                    }
                  />
                  <span className="open-body">
                    <div className="open-name">{s.agent.workflowName}</div>
                    <div className="open-meta">{s.streaming ? '응답 중…' : sessionPreview(s)}</div>
                  </span>
                  <button
                    className="conv-end"
                    title="채팅 종료"
                    onClick={(e) => {
                      e.stopPropagation();
                      sessionStore.endChat(s.key);
                    }}
                  >
                    <CloseIcon size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="sidebar-search">
            <input
              className="search"
              placeholder="에이전트 검색…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-row">
            {(['all', 'personal', 'shared'] as const).map((o) => (
              <button
                key={o}
                className={`chip ${owner === o ? 'active' : ''}`}
                onClick={() => setOwner(o)}
              >
                {o === 'all' ? '전체' : o === 'personal' ? '개인' : '공유'}
              </button>
            ))}
          </div>

          <div className="agent-list">
            {loading && <div className="muted small pad">불러오는 중…</div>}
            {error && <div className="error small pad">{error}</div>}
            {!loading &&
              agents.map((a) => {
                const live = agentSessions(sessions, a.workflowId);
                const isActive = activeSession?.agent.workflowId === a.workflowId;
                return (
                  <button
                    key={a.workflowId}
                    className={`agent-item ${isActive ? 'active' : ''}`}
                    onClick={() => clickAgent(a)}
                  >
                    <span className="agent-body">
                      <div className="agent-name">{a.workflowName}</div>
                      <div className="agent-meta">
                        {a.isDeployed && <span className="dot" />}
                        {a.isShared ? '공유' : '개인'} · 노드 {a.nodeCount}개
                        {a.isDeployed ? ' · 배포됨' : ''}
                      </div>
                    </span>
                    {live.length > 0 && (
                      <span
                        className={`agent-live ${live.some((s) => s.streaming) ? 'streaming' : ''}`}
                        title={live.some((s) => s.streaming) ? '응답 중' : '열린 대화 있음'}
                      />
                    )}
                  </button>
                );
              })}
            {!loading && !error && agents.length === 0 && (
              <div className="muted small pad">에이전트가 없습니다.</div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="pager">
              <button disabled={page <= 1} onClick={() => void load(page - 1)}>
                ‹
              </button>
              <span className="small muted">
                {page} / {totalPages}
              </span>
              <button disabled={page >= totalPages} onClick={() => void load(page + 1)}>
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
