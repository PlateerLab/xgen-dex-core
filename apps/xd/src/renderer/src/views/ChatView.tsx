/**
 * 채팅 — 한 에이전트의 한 대화. 지난 턴은 저장소에서, 도는 턴은 live-store 에서 그린다.
 *
 * 메시지 마크업·CSS 는 Dex 채팅과 같다(`chat-log`·`msg-row`·`bubble`·`chat-input`). 답은 도구를 쓴 턴이면 Dex 의 작업
 * 과정 타임라인, 아니면 Dex 의 마크다운으로 그린다.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { INTERRUPTED_TEXT } from '@dex/protocol';
import type { XdAgent, XdTurn } from '../../../main/store';
import { xd } from '../bridge';
import { turnMessages, usedTools, type ChatMsg } from '../chat-model';
import { errorText, useData, KIND_LABEL } from '../data';
import { ChatIcon, CheckIcon, CopyIcon, FolderOpenIcon, Markdown, PencilIcon, ProcessTimeline, SendIcon, StopIcon, Tooltip } from '../dex';
import { liveStore, useLive, type LiveTurn } from '../live-store';
import { ErrorBlock } from './ErrorBlock';
import { XdMark } from './XdMark';

interface Row {
  key: string;
  msg: ChatMsg;
}

const AssistantBody: React.FC<{ msg: ChatMsg }> = ({ msg }) => {
  if (msg.errorInfo) {
    return (
      <>
        {usedTools(msg) && <ProcessTimeline msg={msg} />}
        <ErrorBlock info={msg.errorInfo} />
      </>
    );
  }
  if (usedTools(msg)) return <ProcessTimeline msg={msg} />;
  if (msg.text) return <Markdown text={msg.text} />;
  return msg.streaming ? <span className="cursor" /> : <span className="muted small">답이 없습니다.</span>;
};

const AnswerFooter: React.FC<{ msg: ChatMsg }> = ({ msg }) => {
  const [copied, setCopied] = useState(false);
  if (msg.streaming || !msg.text || msg.error) return null;
  return (
    <div className="msg-footer">
      <div className="msg-actions">
        <Tooltip label={copied ? '복사됨' : '답변 복사'}>
          <button
            type="button"
            aria-label={copied ? '복사됨' : '답변 복사'}
            onClick={() =>
              void xd.clipboard.write(msg.text).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
};

export const ChatView: React.FC<{
  agent: XdAgent;
  conversationId: string | null;
  onConversation: (id: string) => void;
  onEditAgent: () => void;
}> = ({ agent, conversationId, onConversation, onEditAgent }) => {
  const { accounts } = useData();
  const account = accounts.find((a) => a.id === agent.accountId) ?? null;
  const { live, version } = useLive(conversationId);
  const [turns, setTurns] = useState<XdTurn[]>([]);
  const [loading, setLoading] = useState(false);
  /** 끝난 턴이 저장소에서 다시 읽힐 때까지 그 모습을 붙들어 둔다 — 깜박이지 않게. */
  const [ghost, setGhost] = useState<LiveTurn | null>(null);
  const lastLive = useRef<LiveTurn | null>(null);
  const [draft, setDraft] = useState('');
  /** 보내기 대답을 기다리는 중 — CLI 를 처음 찾는 동안 몇 초 걸릴 수 있다. 그 사이 두 번 보내지 않게. */
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode(개발 실행)는 효과를 마운트·정리·마운트로 두 번 돈다 — 여기서 다시 세워야 한다.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentConversation = useRef(conversationId);
  currentConversation.current = conversationId;
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 입력창은 쓰는 만큼 늘어난다(CSS 의 최대 높이까지).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const stick = useRef(true);

  // 대화를 옮기면 다른 대화의 붙든 모습은 버린다. 새 대화의 첫 답은 보내는 중에 그 대화로 옮겨 오므로, 그 대화의
  // 도는 턴은 그대로 따라간다(그래야 끝난 뒤에도 붙들 수 있다).
  const shownConversation = useRef(conversationId);
  useEffect(() => {
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      setGhost((g) => (g && g.conversationId === conversationId ? g : null));
      stick.current = true;
      setSendError('');
    }
    if (live) lastLive.current = live;
    else if (lastLive.current) {
      const last = lastLive.current;
      lastLive.current = null;
      if (last.conversationId === conversationId) setGhost({ ...last, answer: { ...last.answer, streaming: false } });
    }
  }, [live, conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setTurns([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    xd.conversations
      .turns(conversationId)
      .then((list) => {
        if (!alive) return;
        setTurns(list);
        setGhost((g) => (g && list.some((t) => t.id === g.turnId && t.status !== 'running') ? null : g));
      })
      .catch(() => alive && setTurns([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [conversationId, version]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // 시작 때 저장된 "도는 중" 행은 live(또는 끝난 뒤 다시 읽기 전까지는 붙든 모습)로 그린다.
    const settled = (id: string) => turns.some((t) => t.id === id && t.status !== 'running');
    for (const t of turns) {
      if (live?.turnId === t.id) continue;
      if (ghost?.turnId === t.id && t.status === 'running') continue;
      const [q, a] = turnMessages(t);
      out.push({ key: `${t.id}:q`, msg: q }, { key: `${t.id}:a`, msg: a });
    }
    const current = live ?? (ghost && !settled(ghost.turnId) ? ghost : null);
    if (current) {
      out.push(
        { key: `${current.turnId}:q`, msg: { role: 'user', text: current.question } },
        { key: `${current.turnId}:a`, msg: current.answer },
      );
    }
    return out;
  }, [turns, live, ghost]);

  // 맨 아래 따라가기 — 사용자가 위로 올려 읽는 동안은 따라가지 않는다.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  const running = !!live;
  const send = async () => {
    const text = draft.trim();
    if (!text || running || sending) return;
    const from = conversationId;
    setSendError('');
    setSending(true);
    setDraft('');
    try {
      const sent = await xd.turn.send({ agentId: agent.id, conversationId: from ?? undefined, text });
      liveStore.begin(sent.turnId, sent.conversationId, text);
      if (!mounted.current) return;
      stick.current = true;
      // 기다리는 사이 사용자가 다른 대화로 옮겼다면 끌고 오지 않는다.
      if (sent.conversationId !== from && currentConversation.current === from) onConversation(sent.conversationId);
    } catch (e) {
      if (!mounted.current) return;
      setDraft((d) => d || text);
      setSendError(errorText(e, '메시지를 보내지 못했습니다.'));
    } finally {
      if (mounted.current) setSending(false);
    }
  };

  const modelLabel = account ? `${KIND_LABEL[account.kind] ?? account.kind}${agent.model ? ` · ${agent.model}` : ''}` : '제공자 없음';

  return (
    <div className="chat xd-chat">
      <div className="chat-header">
        <div className="chat-title">
          <XdMark size={26} />
          <div className="chat-title-text">
            <strong>{agent.name}</strong>
            <span className="muted small">{modelLabel}</span>
          </div>
        </div>
        <div className="chat-header-actions">
          <Tooltip label="작업 공간 폴더 열기">
            <button type="button" className="chat-hbtn icon" aria-label="작업 공간 폴더 열기" onClick={() => void xd.openFolder('agent', agent.id)}>
              <FolderOpenIcon size={16} />
            </button>
          </Tooltip>
          <Tooltip label="에이전트 설정">
            <button type="button" className="chat-hbtn icon" aria-label="에이전트 설정" onClick={onEditAgent}>
              <PencilIcon size={15} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className="chat-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {loading && rows.length === 0 ? (
          <div className="chat-empty">
            <p>대화를 불러오는 중…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="chat-empty">
            <ChatIcon size={44} className="mark" />
            <h3>{agent.name}</h3>
            <p>{agent.description || '이 에이전트와 대화를 시작하세요.'}</p>
          </div>
        ) : (
          rows.map(({ key, msg }) =>
            msg.role === 'user' ? (
              <div key={key} className="msg-row user">
                <div className="msg-col">
                  <div className="bubble user">
                    <span className="bubble-plain">{msg.text}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div key={key} className="msg-row assistant">
                <div className="msg-avatar assistant">
                  <XdMark size={22} />
                </div>
                <div className="msg-col">
                  <div className={`bubble assistant${msg.error ? ' error' : ''}`}>
                    <AssistantBody msg={msg} />
                  </div>
                  {msg.interrupted && (
                    <div className="shot-note" role="status">
                      <span>{INTERRUPTED_TEXT}</span>
                    </div>
                  )}
                  <AnswerFooter msg={msg} />
                </div>
              </div>
            ),
          )
        )}
      </div>

      <div className="chat-input">
        {live?.approval && (
          <div className="xd-notice" role="status">
            위험할 수 있는 명령의 실행 여부를 묻는 창이 열려 있습니다.
          </div>
        )}
        {sendError && (
          <div className="voice-error small" role="alert">
            {sendError}
          </div>
        )}
        {!account && (
          <div className="xd-notice" role="status">
            에이전트 설정에서 AI 제공자를 골라야 대화할 수 있습니다.
          </div>
        )}
        <div className="composer">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={running ? '답을 만드는 중입니다' : '메시지를 입력하세요'}
            aria-label="메시지"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {running ? (
            <Tooltip label="정지">
              <button
                type="button"
                className="composer-send stop"
                aria-label="정지"
                onClick={() => conversationId && void xd.turn.stop(conversationId)}
              >
                <StopIcon size={15} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="보내기">
              <button type="button" className="composer-send" aria-label="보내기" disabled={!draft.trim() || sending} onClick={() => void send()}>
                <SendIcon size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};
