/**
 * XGEN Dex Android — 서버 세션 채팅 + 모바일 도구.
 *
 * 화면 셋: 로그인 → 에이전트 목록 → 채팅. 데스크톱의 클라우드/브라우저 등
 * 특수 기능은 없다 — 모바일은 "서버 세션의 채팅 클라이언트 + 이 휴대폰을
 * 조작하는 도구"가 전부다 (제품 정의).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation } from '@dex/protocol';
import { App as CapApp } from '@capacitor/app';
import { createChat, stripAgentMarkers, type ChatWsHandle, type ChatWsState } from './lib/chat-ws';
import { MobileToolBridge, type BridgeStatus } from './lib/tool-bridge';
import { advertiseMobileTools, callMobileTool } from './lib/mobile-tools';
import { capacitorPort, ensureDevicePermissions } from './lib/capacitor-port';
import {
  buildClient,
  clearSession,
  login,
  newInteractionId,
  restoreSession,
  wsBaseOf,
  type XgenMobileClient,
} from './lib/xgen';

type Screen = 'login' | 'agents' | 'chat';

interface Message {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  streaming?: boolean;
}

export default function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>('login');
  const [client, setClient] = useState<XgenMobileClient | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ state: 'off', toolCount: 0 });
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const bridgeRef = useRef<MobileToolBridge | null>(null);

  // ── 세션 복원 — 저장 토큰을 서버에 **검증/회전**하고 나서야 화면을 연다
  //    (만료 토큰이면 조용히 로그인 화면으로; 회전되면 onTokensRotated 가
  //    쿠키/저장분을 갱신해 WS 인증까지 정합). ──
  useEffect(() => {
    void restoreSession().then(async (s) => {
      if (!s) return;
      const c = buildClient(s, () => void handleLogout());
      const alive = await c.api.restore(s.accessToken, s.refreshToken).catch(() => false);
      if (!alive) {
        await clearSession();
        return;
      }
      setClient(c);
      setScreen('agents');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 앱 복귀 — 백그라운드에서 끊긴 도구 브리지를 즉시 다시 세운다
  // (백오프 대기를 기다리지 않는다).
  useEffect(() => {
    const sub = CapApp.addListener('resume', () => bridgeRef.current?.kick());
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);

  // ── 모바일 도구 브리지 수명 — 로그인 상태 + 토글에 따른다 ──
  useEffect(() => {
    bridgeRef.current?.stop();
    bridgeRef.current = null;
    if (!client || !toolsEnabled) {
      setBridgeStatus({ state: 'off', toolCount: 0 });
      return;
    }
    void ensureDevicePermissions();
    const bridge = new MobileToolBridge({
      wsBase: wsBaseOf(client.session.serverUrl),
      userId: client.session.userId,
      catalog: advertiseMobileTools,
      call: (tool, args) => callMobileTool(capacitorPort, tool, args),
      onStatus: setBridgeStatus,
    });
    bridge.start();
    bridgeRef.current = bridge;
    return () => bridge.stop();
  }, [client, toolsEnabled]);

  const handleLogin = useCallback(async (server: string, email: string, password: string) => {
    const session = await login(server, email, password);
    setClient(buildClient(session, () => void handleLogout()));
    setScreen('agents');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = useCallback(async () => {
    bridgeRef.current?.stop();
    await clearSession();
    setClient(null);
    setScreen('login');
  }, []);

  // ── 채팅 대상 ──
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [activeInteraction, setActiveInteraction] = useState<string>('');

  const openChat = useCallback((agent: Agent, interactionId?: string) => {
    setActiveAgent(agent);
    setActiveInteraction(interactionId ?? newInteractionId(agent.workflowId));
    setScreen('chat');
  }, []);

  if (screen === 'login' || !client) {
    return <LoginScreen onLogin={handleLogin} />;
  }
  if (screen === 'chat' && activeAgent) {
    return (
      <ChatScreen
        client={client}
        agent={activeAgent}
        interactionId={activeInteraction}
        bridgeStatus={bridgeStatus}
        onBack={() => setScreen('agents')}
      />
    );
  }
  return (
    <AgentsScreen
      client={client}
      bridgeStatus={bridgeStatus}
      toolsEnabled={toolsEnabled}
      onToggleTools={setToolsEnabled}
      onOpenChat={openChat}
      onLogout={() => void handleLogout()}
    />
  );
}

// ── 로그인 ──────────────────────────────────────────────────────

function LoginScreen({
  onLogin,
}: {
  onLogin: (server: string, email: string, password: string) => Promise<void>;
}): React.ReactElement {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await onLogin(server, email, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen login">
      <div className="login-card">
        <h1>XGEN Dex</h1>
        <p className="muted">서버 세션 채팅 · 모바일 도구</p>
        <input
          placeholder="XGEN 서버 주소 (예: xgen.plateer.com)"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          autoCapitalize="none"
        />
        <input
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoCapitalize="none"
          inputMode="email"
        />
        <input
          placeholder="비밀번호"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !server || !email || !password} onClick={() => void submit()}>
          {busy ? '로그인 중…' : '로그인'}
        </button>
      </div>
    </div>
  );
}

// ── 에이전트 목록 ────────────────────────────────────────────────

function AgentsScreen({
  client,
  bridgeStatus,
  toolsEnabled,
  onToggleTools,
  onOpenChat,
  onLogout,
}: {
  client: XgenMobileClient;
  bridgeStatus: BridgeStatus;
  toolsEnabled: boolean;
  onToggleTools: (on: boolean) => void;
  onOpenChat: (agent: Agent, interactionId?: string) => void;
  onLogout: () => void;
}): React.ReactElement {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, convs] = await Promise.all([
        client.api.agents.list({ pageSize: 100 }),
        client.api.history.conversations().catch(() => [] as Conversation[]),
      ]);
      setAgents(list.items);
      setConversations(convs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      agents.filter((a) =>
        (a.workflowName || a.workflowId).toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [agents, search],
  );
  const recentFor = useCallback(
    (workflowId: string) =>
      conversations
        .filter((c) => c.workflowId === workflowId)
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
        .slice(0, 1),
    [conversations],
  );

  const bridgeLabel =
    bridgeStatus.state === 'connected'
      ? `모바일 도구 연결됨 · ${bridgeStatus.toolCount}개`
      : bridgeStatus.state === 'connecting'
        ? '모바일 도구 연결 중…'
        : bridgeStatus.state === 'error'
          ? '모바일 도구 오류'
          : '모바일 도구 꺼짐';

  return (
    <div className="screen">
      <header className="bar">
        <span className="title">에이전트</span>
        <button className="link" onClick={onLogout}>
          로그아웃
        </button>
      </header>

      <div className="tools-row">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={toolsEnabled}
            onChange={(e) => onToggleTools(e.target.checked)}
          />
          <span>{bridgeLabel}</span>
        </label>
        <p className="muted small">
          켜져 있으면 에이전트가 이 휴대폰의 파일(문서/XGenDex)·알림·클립보드·카메라 등을 도구로
          사용합니다. 데스크톱 커넥터가 켜져 있어도 이 앱이 연결된 동안은 휴대폰 도구가
          우선합니다.
        </p>
      </div>

      <input
        className="search"
        placeholder="에이전트 검색…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && <p className="muted center">불러오는 중…</p>}
      {error && (
        <p className="error center">
          {error}{' '}
          <button className="link" onClick={() => void load()}>
            다시 시도
          </button>
        </p>
      )}

      <div className="agent-list">
        {filtered.map((a) => {
          const recent = recentFor(a.workflowId);
          return (
            <div key={a.workflowId} className="agent-card">
              <button className="agent-main" onClick={() => onOpenChat(a)}>
                <span className="agent-name">{a.workflowName || a.workflowId}</span>
                <span className="muted small">새 대화</span>
              </button>
              {recent.map((c) => (
                <button
                  key={c.interactionId}
                  className="agent-recent"
                  onClick={() => onOpenChat(a, c.interactionId)}
                >
                  최근 대화 이어하기
                </button>
              ))}
            </div>
          );
        })}
        {!loading && filtered.length === 0 && <p className="muted center">에이전트가 없습니다.</p>}
      </div>
    </div>
  );
}

// ── 채팅 ────────────────────────────────────────────────────────

function ChatScreen({
  client,
  agent,
  interactionId,
  bridgeStatus,
  onBack,
}: {
  client: XgenMobileClient;
  agent: Agent;
  interactionId: string;
  bridgeStatus: BridgeStatus;
  onBack: () => void;
}): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [wsState, setWsState] = useState<ChatWsState>('connecting');
  const [running, setRunning] = useState(false);
  const chatRef = useRef<ChatWsHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 과거 턴 로드 (이어하기).
  useEffect(() => {
    let cancelled = false;
    void client.api.history
      .turns(agent.workflowId, interactionId, agent.workflowName)
      .then((turns) => {
        if (cancelled) return;
        const past: Message[] = [];
        for (const t of turns) {
          if (t.input) past.push({ role: 'user', text: t.input });
          if (t.output) past.push({ role: 'assistant', text: t.output });
        }
        setMessages(past);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, agent, interactionId]);

  // WS 연결 — 화면 수명과 함께.
  useEffect(() => {
    const handle = createChat({
      wsBase: wsBaseOf(client.session.serverUrl),
      workflowId: agent.workflowId,
      workflowName: agent.workflowName || agent.workflowId,
      interactionId,
      onState: setWsState,
      callbacks: {
        onData: (text) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { role: 'assistant', text, streaming: true }];
          });
        },
        onTool: (ev) => {
          if (ev.eventType === 'tool_start' || ev.eventType === 'tool_use') {
            setMessages((prev) => [
              ...prev,
              { role: 'tool', text: `도구 실행: ${ev.toolName ?? ''}` },
            ]);
          }
        },
        onEnd: () => {
          setRunning(false);
          setMessages((prev) =>
            prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          );
        },
        onError: (message) => {
          setRunning(false);
          setMessages((prev) => [...prev, { role: 'error', text: message }]);
        },
      },
    });
    chatRef.current = handle;
    return () => handle.close();
  }, [client, agent, interactionId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || running || !chatRef.current) return;
    setInput('');
    setRunning(true);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    try {
      await chatRef.current.execute(text);
    } catch (e) {
      setRunning(false);
      const msg = e instanceof Error ? e.message : String(e);
      setMessages((prev) =>
        prev[prev.length - 1]?.role === 'error' ? prev : [...prev, { role: 'error', text: msg }],
      );
    }
  };

  const stateLabel =
    wsState === 'connected'
      ? bridgeStatus.state === 'connected'
        ? '연결됨 · 모바일 도구 사용 가능'
        : '연결됨'
      : wsState === 'unsupported'
        ? '이 에이전트는 모바일 채팅을 지원하지 않습니다'
        : wsState === 'failed'
          ? '연결 실패'
          : '연결 중…';

  return (
    <div className="screen chat">
      <header className="bar">
        <button className="link" onClick={onBack}>
          ← 목록
        </button>
        <span className="title">{agent.workflowName || agent.workflowId}</span>
        <span className={`ws-state ${wsState}`}>{stateLabel}</span>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.map((m, i) => {
          const text = m.role === 'assistant' ? stripAgentMarkers(m.text) : m.text;
          if (!text && !m.streaming) return null;
          return (
            <div key={i} className={`msg ${m.role}`}>
              {text}
              {m.streaming && <span className="cursor">▍</span>}
            </div>
          );
        })}
        {messages.length === 0 && (
          <p className="muted center">메시지를 보내 대화를 시작하세요.</p>
        )}
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder="메시지…"
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running ? (
          <button className="primary" onClick={() => chatRef.current?.stop()}>
            중지
          </button>
        ) : (
          <button
            className="primary"
            disabled={wsState !== 'connected' || !input.trim()}
            onClick={() => void send()}
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}
