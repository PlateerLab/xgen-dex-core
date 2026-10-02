import React, { useEffect, useRef, useState } from 'react';
import type { NativeSessionSummary } from '@dex/rpc';
import type { DesktopNativeSessionModel } from '../native-session-model';
import { observedDesktopAgentSession, type DesktopNativeSessionBinding } from '../native-session-binding';

const sessionStates: Record<string, string> = {
  signed_out: '로그아웃됨',
  active: '사용 가능',
  access_expired: '세션 갱신 필요',
  access_unavailable: '접근 권한 발급 대기',
  login_pending: '로그인 확인 필요',
  refreshing: '갱신 확인 필요',
  logout_pending: '로그아웃 확인 필요',
  pending_takeover: '기존 세션 전환 승인 대기',
};

const connectionStates = {
  idle: '연결 안 됨',
  waiting: '대화 확인 중',
  connected: '연결됨',
  reconnecting: '다시 연결 중',
  stopped: '확인 필요',
};

function sessionSummary(binding: DesktopNativeSessionBinding): NativeSessionSummary | null {
  const value = binding.view.result?.result;
  return value && 'session_id' in value ? value as NativeSessionSummary : null;
}

function sameModel(binding: DesktopNativeSessionBinding, model: DesktopNativeSessionModel): boolean {
  return binding.model === model;
}

export interface CanonicalChatProps {
  binding: DesktopNativeSessionBinding;
  onOpenSettings: () => void;
}

export const CanonicalChat: React.FC<CanonicalChatProps> = ({ binding, onOpenSettings }) => {
  const { view } = binding;
  const [workflowId, setWorkflowId] = useState('');
  const [title, setTitle] = useState('');
  const [selectedSession, setSelectedSession] = useState('');
  const initializedModel = useRef<DesktopNativeSessionModel | null>(null);
  const currentBinding = useRef(binding);
  currentBinding.current = binding;

  const summary = sessionSummary(binding);
  const ready = summary?.state === 'active'
    && summary.user_id === view.result?.user_id;
  const observedSession = observedDesktopAgentSession(view);
  const activeSessionId = observedSession === undefined ? null : observedSession;
  const conversationSessionId = view.conversation?.snapshot?.id ?? null;
  const authoritativeConversation = ready
    && activeSessionId !== null
    && conversationSessionId === activeSessionId;
  const accountKey = view.result
    ? `${view.result.server_url}\n${view.result.user_id}`
    : '';

  const actionContext = useRef<{
    model: DesktopNativeSessionModel | null;
    account: string;
    session: string | null;
    generation: number;
  }>({ model: null, account: '', session: null, generation: 0 });
  const actionSession = observedSession === undefined ? actionContext.current.session : observedSession;
  if (
    actionContext.current.model !== binding.model
    || actionContext.current.account !== accountKey
    || actionContext.current.session !== actionSession
  ) {
    actionContext.current = {
      model: binding.model,
      account: accountKey,
      session: actionSession,
      generation: actionContext.current.generation + 1,
    };
  }

  useEffect(() => {
    setWorkflowId('');
    setTitle('');
    setSelectedSession('');
  }, [accountKey, binding.model]);

  useEffect(() => {
    const active = view.catalog.focus?.active_agent_session_id ?? '';
    setSelectedSession(
      view.catalog.items.some((item) => item.id === active && item.status === 'active')
        ? active
        : '',
    );
  }, [view.catalog.focus?.active_agent_session_id, view.catalog.items]);

  useEffect(() => {
    const model = binding.model;
    if (!model || initializedModel.current === model || view.catalog.focus || view.catalog.writeBlocked) return;
    initializedModel.current = model;
    let cancelled = false;
    void (async () => {
      const status = model.state.result ?? await model.execute('session', { action: 'status' });
      if (cancelled || currentBinding.current.model !== model) return;
      const verified = status?.result && 'session_id' in status.result
        ? status.result as NativeSessionSummary
        : null;
      if (verified?.state !== 'active' || verified.user_id !== status?.user_id) return;
      const refreshed = await model.refreshAgentSessions();
      if (cancelled || !refreshed || currentBinding.current.model !== model) return;
      await model.execute('watch-live');
    })();
    return () => { cancelled = true; };
  }, [binding.model]);

  const completeMessages = view.conversation?.messages.filter((message) => message.content_complete) ?? [];
  const incompleteMessages = (view.conversation?.messages.length ?? 0) - completeMessages.length;
  const draftBytes = new TextEncoder().encode(binding.draft).length;
  const turnBlocksSessionWrite = ['unknown', 'sending', 'stopping', 'accepted', 'stop-requested'].includes(view.turn.status);
  const sessionWriteDisabled = !binding.model
    || !ready
    || view.busy
    || !view.catalog.focus
    || view.catalog.busy
    || view.catalog.writeBlocked
    || turnBlocksSessionWrite;
  const catalogPageStatus = view.catalog.pageKnown
    ? `${view.catalog.olderPage ? '이전 세션 페이지' : '최신 세션 페이지'} · ${view.catalog.items.length}개 표시`
      + `${view.catalog.olderPage || view.catalog.hasMore ? ' · 전체 목록의 일부' : ' · 전체 목록'}`
      + `${view.catalog.hasMore ? ' · 더 이전 페이지 있음' : ''}`
    : '세션 목록 상태 확인 필요 · 최신 목록을 새로 고쳐 주세요.';

  const refresh = async () => {
    const model = binding.model;
    if (!model) return;
    const status = await model.execute('session', { action: 'status' });
    if (!sameModel(currentBinding.current, model)) return;
    const verified = status?.result && 'session_id' in status.result
      ? status.result as NativeSessionSummary
      : null;
    if (verified?.state !== 'active' || verified.user_id !== status?.user_id) return;
    const refreshed = await model.refreshAgentSessions();
    if (refreshed && sameModel(currentBinding.current, model)) await model.execute('watch-live');
  };

  const read = async () => {
    const model = binding.model;
    if (!model) return;
    const result = await model.execute('conversation');
    if (result && sameModel(currentBinding.current, model)) await model.execute('watch-live');
  };

  const submit = async (retry: boolean) => {
    const model = binding.model;
    const session = conversationSessionId;
    if (!model || !session || !authoritativeConversation) return;
    const draft = binding.draft;
    const generation = actionContext.current.generation;
    const accepted = retry ? await model.retryTurn() : await model.submitTurn(draft);
    const latest = currentBinding.current;
    if (
      accepted
      && latest.model === model
      && actionContext.current.generation === generation
      && observedDesktopAgentSession(model.state) === session
      && latest.draft === draft
    ) {
      latest.setDraft('');
    }
  };

  const historyNotes = [
    view.conversation && view.conversation.omittedMessages > 0
      ? `이전 메시지 ${view.conversation.omittedMessages}개 생략`
      : '',
    view.conversation?.snapshot && !view.conversation.snapshot.message_history_complete
      ? '전체 메시지 이력이 아님'
      : '',
    incompleteMessages > 0 ? `본문이 완전하지 않은 메시지 ${incompleteMessages}개 제외` : '',
    view.hasMore ? '추가 내용 확인 중' : '',
  ].filter(Boolean);

  return <section className="canonical-chat" aria-labelledby="canonical-chat-heading">
    <header className="canonical-chat__header">
      <div>
        <h2 id="canonical-chat-heading">공유 Agent 대화</h2>
        <p>다른 기기에서 시작한 현재 계정의 대화를 이어갈 수 있습니다.</p>
      </div>
      <button id="canonical-chat-settings" type="button" className="secondary" onClick={onOpenSettings}>
        기기·세션 설정
      </button>
    </header>

    <div className="canonical-chat__status" aria-live="polite">
      <span>플랫폼 세션: {summary ? sessionStates[summary.state] ?? summary.state : '확인 전'}</span>
      <span>대화 연결: {connectionStates[view.connection]}</span>
      <span>현재 세션: {observedSession ? observedSession.slice(0, 8) : '없음'}</span>
    </div>

    {!ready && <div className="canonical-chat__notice">
      <p>이 PC의 기기 승인과 Desktop 플랫폼 로그인이 필요합니다.</p>
      <button type="button" className="secondary" onClick={onOpenSettings}>설정에서 등록·로그인하기</button>
    </div>}

    <details className="canonical-chat__sessions">
      <summary>Agent 세션 선택 및 만들기</summary>
      <p className="canonical-chat__hint">서버에서 확인한 현재 계정 소유 세션만 선택할 수 있습니다.</p>
      <p className="canonical-chat__hint" id="canonical-chat-focus-status">
        현재 포커스: {activeSessionId ? activeSessionId.slice(0, 8) : '없음'}
      </p>
      <p className="canonical-chat__hint" id="canonical-chat-page-status" aria-live="polite">{catalogPageStatus}</p>
      <label htmlFor="canonical-chat-select">내 활성 Agent 세션</label>
      <select
        id="canonical-chat-select"
        value={selectedSession}
        disabled={sessionWriteDisabled}
        onChange={(event) => setSelectedSession(event.target.value)}
      >
        <option value="">{activeSessionId
          ? `현재 포커스 ${activeSessionId.slice(0, 8)}${view.catalog.items.some((item) => item.id === activeSessionId) ? '' : ' · 현재 페이지에 없음'}`
          : '현재 포커스 없음 · 세션 선택'}</option>
        {view.catalog.items.filter((item) => item.status === 'active').map((item) =>
          <option key={item.id} value={item.id}>{item.title || item.workflow_id} · {item.id.slice(0, 8)}</option>)}
      </select>
      <div className="canonical-chat__actions">
        <button
          id="canonical-chat-switch"
          type="button"
          className="primary"
          disabled={sessionWriteDisabled || !selectedSession || selectedSession === activeSessionId}
          onClick={() => void binding.model?.switchAgentFocus(selectedSession)}
        >선택한 세션 열기</button>
        <button
          id="canonical-chat-clear"
          type="button"
          className="secondary"
          disabled={sessionWriteDisabled || !activeSessionId}
          onClick={() => void binding.model?.switchAgentFocus(null)}
        >현재 포커스 해제</button>
        <button
          id="canonical-chat-refresh"
          type="button"
          className="secondary"
          disabled={!binding.model || view.busy || view.catalog.busy}
          onClick={() => void refresh()}
        >상태·최신 목록 새로 고침</button>
        <button
          id="canonical-chat-older"
          type="button"
          className="secondary"
          disabled={!binding.model || !ready || view.busy || view.catalog.busy || !view.catalog.hasMore || !view.catalog.nextCursor}
          onClick={() => void binding.model?.loadOlderAgentSessions()}
        >이전 세션 페이지</button>
        {view.catalog.olderPage && <button
          id="canonical-chat-latest"
          type="button"
          className="secondary"
          disabled={!binding.model || !ready || view.busy || view.catalog.busy}
          onClick={() => void refresh()}
        >최신 세션으로 돌아가기</button>}
      </div>
      <label htmlFor="canonical-chat-workflow">Workflow ID</label>
      <input
        id="canonical-chat-workflow"
        type="text"
        maxLength={256}
        autoComplete="off"
        value={workflowId}
        disabled={sessionWriteDisabled}
        onChange={(event) => setWorkflowId(event.target.value)}
      />
      <label htmlFor="canonical-chat-title">제목 (선택)</label>
      <input
        id="canonical-chat-title"
        type="text"
        maxLength={256}
        autoComplete="off"
        value={title}
        disabled={sessionWriteDisabled}
        onChange={(event) => setTitle(event.target.value)}
      />
      <button
        id="canonical-chat-create"
        type="button"
        className="primary"
        disabled={sessionWriteDisabled || !workflowId}
        onClick={() => void binding.model?.createAgentSession(workflowId, title)}
      >새 Agent 세션 만들기</button>
      {view.catalog.notice && <p className={view.catalog.writeBlocked ? 'canonical-chat__warning' : 'canonical-chat__hint'} role="status">
        {view.catalog.notice}
      </p>}
    </details>

    <div className="canonical-chat__toolbar">
      <button
        id="canonical-chat-read"
        type="button"
        className="secondary"
        disabled={!binding.model || !ready || view.busy}
        onClick={() => void read()}
      >현재 대화 다시 읽기</button>
      {view.conversation?.snapshot && conversationSessionId !== activeSessionId && <p className="canonical-chat__hint" role="status">
        다른 기기에서 현재 대화가 바뀌었습니다. 상태·목록을 새로 고쳐 전송할 대화를 확인하세요.
      </p>}
    </div>

    <div className="canonical-chat__messages" aria-label="공유 대화 메시지">
      {view.conversation?.snapshot && <div className="canonical-chat__conversation-heading">
        <h3>{view.conversation.snapshot.title || view.conversation.snapshot.workflow_id}</h3>
        <span>최신 턴: {view.conversation.snapshot.latest_turn?.status ?? '없음'}</span>
      </div>}
      {historyNotes.length > 0 && <p className="canonical-chat__warning" role="status">{historyNotes.join(' · ')}</p>}
      {completeMessages.map((message) => <article className="canonical-chat__message" key={message.turn_id}>
        <header>메시지 {message.sequence} · {message.status} · {message.source}</header>
        <div className="canonical-chat__bubble canonical-chat__bubble--input">
          <strong>요청</strong>
          <p>{message.input_text}</p>
        </div>
        <div className="canonical-chat__bubble canonical-chat__bubble--output">
          <strong>응답</strong>
          <p>{message.output_text}</p>
        </div>
      </article>)}
      {view.conversation?.snapshot && completeMessages.length === 0 && <p className="canonical-chat__empty">표시할 완전한 메시지가 없습니다.</p>}
      {!view.conversation?.snapshot && <p className="canonical-chat__empty">
        {view.busy ? '현재 공유 대화를 확인하고 있습니다.' : '현재 선택된 공유 대화가 없습니다.'}
      </p>}
    </div>

    <div className="canonical-chat__composer">
      <label htmlFor="canonical-chat-input">새 요청</label>
      <textarea
        id="canonical-chat-input"
        rows={5}
        maxLength={262144}
        value={binding.draft}
        disabled={!authoritativeConversation || !view.turn.canSubmit || view.busy}
        placeholder={authoritativeConversation ? 'Agent에게 요청할 내용을 입력하세요.' : '사용 가능한 현재 대화를 먼저 선택하세요.'}
        onChange={(event) => {
          const next = event.target.value;
          if (new TextEncoder().encode(next).length <= 262144) binding.setDraft(next);
        }}
      />
      <p className="canonical-chat__hint">UTF-8 {draftBytes.toLocaleString()} / 262,144 bytes · 공백과 줄바꿈을 입력 그대로 전송합니다.</p>
      <div className="canonical-chat__actions">
        <button
          id="canonical-chat-submit"
          type="button"
          className="primary"
          disabled={!authoritativeConversation || view.busy || !view.turn.canSubmit || draftBytes === 0 || draftBytes > 262144}
          onClick={() => void submit(false)}
        >보내기</button>
        <button
          id="canonical-chat-retry"
          type="button"
          className="secondary"
          disabled={!authoritativeConversation || view.busy || !view.turn.canRetry}
          onClick={() => void submit(true)}
        >같은 요청 다시 시도</button>
        <button
          id="canonical-chat-stop"
          type="button"
          className="secondary"
          disabled={!authoritativeConversation || view.busy || !view.turn.canStop}
          onClick={() => void binding.model?.stopTurn()}
        >최신 실행 턴 중단</button>
      </div>
      {view.turn.notice && <p className={['rejected', 'unknown', 'unavailable'].includes(view.turn.status)
        ? 'canonical-chat__warning' : 'canonical-chat__hint'} role="status">{view.turn.notice}</p>}
      {(view.turn.status === 'accepted' || view.turn.status === 'stop-requested') && <p className="canonical-chat__hint" role="status">
        서버가 요청을 접수했습니다. 응답 완료 또는 중단 완료는 최신 턴의 최종 상태로 확인합니다.
      </p>}
    </div>

    {view.error && <p className="canonical-chat__warning" role="alert">{view.error}</p>}
  </section>;
};
