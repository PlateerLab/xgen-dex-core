/**
 * 채팅 — 한 에이전트의 한 대화. 지난 턴은 저장소에서, 도는 턴은 live-store 에서 그린다.
 * 시작 화면에서 넘어오면 그 첫 메시지(`initialMessage`)를 마운트 뒤 한 번만 보낸다.
 *
 * 메시지 마크업·CSS 는 Dex 채팅과 같다(`chat-log`·`msg-row`·`bubble`·`chat-input`). 답은 도구를 쓴 턴이면 Dex 의 작업
 * 과정 타임라인, 아니면 Dex 의 마크다운으로 그린다.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { INTERRUPTED_TEXT } from '@dex/protocol';
import type { XdAgent, XdTurn } from '../../../main/store';
import { xd } from '../bridge';
import { turnMessages, usedTools, type ChatMsg } from '../chat-model';
import { errorText, useData, KIND_LABEL } from '../data';
import { IdeView } from '@dex/ide';
import { ChatIcon, CheckIcon, CopyIcon, FolderCodeIcon, FolderOpenIcon, Markdown, PencilIcon, ProcessTimeline, Tooltip } from '../dex';
import { setVisibleIde } from '../ide/activity';
import { ideStoreFor, setIdeMode, useIdeMode } from '../ide/ide-stores';
import { useTheme } from '../theme';
import { liveStore, useLive, type LiveTurn } from '../live-store';
import { conversationTitle } from '../start-model';
import { Composer } from './Composer';
import { ErrorBlock } from './ErrorBlock';
import { LinkedFolders } from './LinkedFolders';
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

/** 시작 화면이 넘긴 첫 메시지. `key` 하나에 한 번만 보낸다. */
export interface InitialMessage {
  key: string;
  text: string;
}

/**
 * 이미 보낸 첫 메시지의 key. 화면 밖(모듈)에 두어 StrictMode 의 효과 두 번 돌기나 다시 마운트돼도 두 번 보내지 않는다.
 */
const sentInitial = new Set<string>();

export const ChatView: React.FC<{
  agent: XdAgent;
  conversationId: string | null;
  /** 대화 제목(목록이 아는 것). 새 대화면 비어 있다. */
  title?: string;
  initialMessage?: InitialMessage | null;
  onConversation: (id: string) => void;
  onEditAgent: () => void;
}> = ({ agent, conversationId, title = '', initialMessage = null, onConversation, onEditAgent }) => {
  const { accounts } = useData();
  const account = accounts.find((a) => a.id === agent.accountId) ?? null;
  const { live, version, mcp } = useLive(conversationId);
  // 이번(마지막) 턴에 못 붙은 MCP 서버 — 그 도구 없이 답했다.
  const mcpDown = (mcp ?? []).filter((s) => s.state !== 'connected');
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
  const logRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  // 연결 폴더가 그대로 있는지 — 없어진 폴더는 엔진이 빼고 가므로 사용자에게 알린다. 턴이 끝날 때도 다시 본다.
  const [folderStatus, setFolderStatus] = useState<Record<string, string>>({});
  const foldersKey = agent.folders.join('\n');
  useEffect(() => {
    if (!agent.folders.length) {
      setFolderStatus({});
      return;
    }
    let alive = true;
    xd.folders
      .check(agent.folders)
      // 돌아온 path 는 정리된 글자일 수 있다 — 저장된 글자로 찾도록 순서로 맞춘다.
      .then((list) => alive && setFolderStatus(Object.fromEntries(agent.folders.map((f, i) => [f, list[i]?.status ?? 'ok']))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldersKey, version]);
  const missingFolders = agent.folders.some((f) => folderStatus[f] === 'missing');
  const blockedFolders = agent.folders.some((f) => ['relative', 'inside_xd', 'contains_xd'].includes(folderStatus[f]));

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
  const sendText = async (raw: string) => {
    const text = raw.trim();
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
  const send = () => sendText(draft);

  // 시작 화면의 첫 메시지: 새 대화로 한 번만 보낸다. 실패하면 입력창에 그 글이 남는다.
  useEffect(() => {
    if (!initialMessage || sentInitial.has(initialMessage.key)) return;
    sentInitial.add(initialMessage.key);
    void sendText(initialMessage.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage?.key]);

  // [대화 | 작업 공간] — 에이전트마다 기억한다(앱을 다시 켜도). 저장소는 화면 밖에 있어 편집 중인 것이 남는다.
  const ideMode = useIdeMode(agent.id);
  const theme = useTheme();
  const ideStore = ideMode ? ideStoreFor(agent) : null;
  // 보이는 작업 공간만 바뀜을 따라 읽는다(ide/activity.ts).
  useEffect(() => {
    if (!ideMode) return;
    setVisibleIde(agent.id);
    return () => setVisibleIde(null);
  }, [ideMode, agent.id]);
  // 대화 기록 칸은 [작업 공간] 을 켜고 끌 때 새로 그려진다 — 새 칸도 맨 아래(따라가는 중이면)에서 시작한다.
  const setLog = useCallback((el: HTMLDivElement | null) => {
    logRef.current = el;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);

  const modelLabel = account ? `${KIND_LABEL[account.kind] ?? account.kind}${agent.model ? ` · ${agent.model}` : ''}` : '제공자 없음';

  const header = (
    <div className="chat-header">
      <div className="chat-title">
        <XdMark size={26} />
        <div className="chat-title-text">
          <strong>{conversationTitle({ title })}</strong>
          <span className="muted small">
            {agent.name} · {modelLabel}
          </span>
        </div>
      </div>
      <div className="chat-header-actions">
        <LinkedFolders key={agent.id} agent={agent} status={folderStatus} />
        <Tooltip label={ideMode ? '대화만 보기' : '작업 공간 보기'}>
          <button
            type="button"
            className={`chat-hbtn icon xd-ide-toggle${ideMode ? ' on' : ''}`}
            aria-label="작업 공간 보기"
            aria-pressed={ideMode}
            onClick={() => setIdeMode(agent.id, !ideMode)}
          >
            <FolderCodeIcon size={16} />
          </button>
        </Tooltip>
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
  );

  const body = (
    <>
      <div
        className="chat-log"
        ref={setLog}
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
        {blockedFolders && (
          <div className="xd-notice" role="status">
            연결할 수 없는 폴더가 있어 에이전트 설정에서 빼야 대화할 수 있습니다.
          </div>
        )}
        {mcpDown.length > 0 && (
          <div className="xd-notice" role="status" title={mcpDown.map((s) => `${s.label}: ${s.error || s.state}`).join('\n')}>
            MCP 서버({mcpDown.map((s) => s.label).join(', ')})에 {mcpDown.every((s) => s.state === 'connecting') ? '아직 붙는 중이라' : '연결하지 못해'} 이번 답에서는 그
            도구를 쓰지 않았습니다.
          </div>
        )}
        {missingFolders && (
          <div className="xd-notice" role="status">
            연결 폴더 중 찾을 수 없는 것은 빼고 답합니다.
          </div>
        )}
        {!account && (
          <div className="xd-notice" role="status">
            에이전트 설정에서 AI 제공자를 골라야 대화할 수 있습니다.
          </div>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send()}
          sending={sending}
          running={running}
          onStop={() => conversationId && void xd.turn.stop(conversationId)}
        />
      </div>
    </>
  );

  // 작업 공간 — Dex 와 같은 IDE 의 오른쪽 칸에 이 대화(기록·입력)가 들어간다.
  if (ideStore) {
    return (
      <div className="chat chat-ide xd-chat">
        {header}
        <div className="chat-ide-body">
          <IdeView store={ideStore} theme={theme} activityBar={false} chat={<div className="chat chat-ide-column">{body}</div>} />
        </div>
      </div>
    );
  }

  return (
    <div className="chat xd-chat">
      {header}
      {body}
    </div>
  );
};
