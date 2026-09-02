/**
 * XGEN Dex Android — 서버 세션 채팅 + 모바일 도구.
 *
 * 구조(제품 지시): 좌상단 [☰] → 사이드바(드로어)로 세 섹션 이동:
 *   [현재 채팅]      마지막으로 연 대화 — 섹션을 오가도 WS/스트림이 살아 있다
 *   [에이전트 목록]  검색 + 새 대화/이어하기
 *   [설정]           모바일 도구(토글·상태·도구 목록)·계정·진단·앱 정보
 *
 * 세 섹션은 전부 마운트를 유지하고 hidden 으로만 전환한다 — 채팅 WS 와
 * 스크롤 위치가 이동 중에도 보존된다. 목록/버튼류는 <button>-flex 대신
 * 일반 블록 마크업을 쓴다 (일부 안드로이드 WebView 의 button 렌더 특이점
 * 회피 — 실기기에서 목록이 빈 줄로 그려진 사고의 재발 방지).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation } from '@dex/protocol';
import { App as CapApp } from '@capacitor/app';
import { createChat, stripAgentMarkers, type ChatWsHandle, type ChatWsState } from './lib/chat-ws';
import { MobileToolBridge, type BridgeStatus } from './lib/tool-bridge';
import {
  advertiseMobileTools,
  callMobileTool,
  TOOL_GROUPS,
  type PermissionState,
  type ToolGroup,
} from './lib/mobile-tools';
import { Preferences } from '@capacitor/preferences';
import { capacitorPort, ensureDevicePermissions } from './lib/capacitor-port';
import { friendlyError } from './lib/errors';
import { diagEntries, diagLog, onDiag } from './lib/diag';
import {
  buildClient,
  clearSession,
  loadCredentials,
  login,
  newInteractionId,
  restoreSession,
  saveCredentials,
  wsBaseOf,
  type XgenMobileClient,
} from './lib/xgen';

type Section = 'chat' | 'agents' | 'settings';

const SECTION_TITLE: Record<Section, string> = {
  chat: '현재 채팅',
  agents: '에이전트',
  settings: '설정',
};

interface Message {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  streaming?: boolean;
}

export default function App(): React.ReactElement {
  const [booting, setBooting] = useState(true);
  const [client, setClient] = useState<XgenMobileClient | null>(null);
  const [section, setSection] = useState<Section>('agents');
  const [drawer, setDrawer] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ state: 'off', toolCount: 0 });
  const [toolsEnabled, setToolsEnabled] = useState(true);
  /** 그룹별 on/off — [도구 켜기] = OS 승인까지 통과해야 true. 영속. */
  const [toolGroups, setToolGroups] = useState<Record<ToolGroup, boolean>>({
    files: true, notify: true, clipboard: true, device: true,
    camera: true, location: false, actions: true,
  });
  const [permStates, setPermStates] = useState<Partial<Record<ToolGroup, PermissionState>>>({});
  const groupsRef = useRef(toolGroups);
  groupsRef.current = toolGroups;
  const bridgeRef = useRef<MobileToolBridge | null>(null);

  // 그룹 설정 영속화 — 위치는 기본 off (민감 권한은 명시적 켜기).
  useEffect(() => {
    void Preferences.get({ key: 'tool-groups' }).then((r) => {
      if (!r.value) return;
      try {
        setToolGroups((prev) => ({ ...prev, ...(JSON.parse(r.value as string) as object) }));
      } catch {
        /* 무시 */
      }
    });
  }, []);
  const persistGroups = useCallback((next: Record<ToolGroup, boolean>) => {
    setToolGroups(next);
    void Preferences.set({ key: 'tool-groups', value: JSON.stringify(next) });
    bridgeRef.current?.refreshCatalog(); // 서버 카탈로그 즉시 갱신
  }, []);

  /** [도구 켜기] — 켜는 순간 OS 승인 요청. 거부되면 켜지지 않는다. */
  const toggleGroup = useCallback(
    async (id: ToolGroup, on: boolean) => {
      if (!on) {
        persistGroups({ ...groupsRef.current, [id]: false });
        return;
      }
      const meta = TOOL_GROUPS.find((g) => g.id === id);
      if (meta?.permission) {
        const state = await capacitorPort.requestPermission(meta.permission);
        setPermStates((prev) => ({ ...prev, [id]: state }));
        diagLog(`도구 그룹 '${id}' 권한 요청 → ${state}`);
        if (state === 'denied') return; // 승인 없인 켜지 않는다
      }
      persistGroups({ ...groupsRef.current, [id]: true });
    },
    [persistGroups],
  );

  // 채팅 대상 — 섹션을 오가도 유지된다 ([현재 채팅]의 실체).
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [activeInteraction, setActiveInteraction] = useState('');
  const [chatWsState, setChatWsState] = useState<ChatWsState>('closed');

  const handleLogout = useCallback(async () => {
    bridgeRef.current?.stop();
    await clearSession();
    await saveCredentials(null);
    setClient(null);
    setActiveAgent(null);
    setSection('agents');
  }, []);

  // ── 자동 로그인 체인: 토큰 검증/회전 → 저장 자격증명 재로그인 → 로그인 화면 ──
  useEffect(() => {
    void (async () => {
      try {
        const s = await restoreSession();
        if (s) {
          const c = buildClient(s, () => void handleLogout());
          const alive = await c.api.restore(s.accessToken, s.refreshToken).catch((e) => {
            diagLog(`토큰 복원 실패: ${e instanceof Error ? e.message : String(e)}`);
            return false;
          });
          if (alive) {
            diagLog('자동 로그인: 저장 토큰 유효');
            setClient(c);
            return;
          }
          await clearSession();
        }
        const cred = await loadCredentials();
        if (cred) {
          try {
            const session = await login(cred.serverUrl, cred.email, cred.password);
            diagLog('자동 로그인: 저장 자격증명으로 재로그인');
            setClient(buildClient(session, () => void handleLogout()));
            return;
          } catch (e) {
            diagLog(`자동 재로그인 실패: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } finally {
        setBooting(false);
      }
    })();
  }, [handleLogout]);

  // ── 모바일 도구 브리지 수명 ──
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
      catalog: () => advertiseMobileTools(groupsRef.current),
      call: (tool, args) => callMobileTool(capacitorPort, tool, args, groupsRef.current),
      onStatus: setBridgeStatus,
      log: diagLog,
    });
    bridge.start();
    bridgeRef.current = bridge;
    return () => bridge.stop();
  }, [client, toolsEnabled]);

  useEffect(() => {
    const sub = CapApp.addListener('resume', () => bridgeRef.current?.kick());
    return () => {
      void sub.then((h) => h.remove());
    };
  }, []);

  const handleLogin = useCallback(
    async (server: string, email: string, password: string, remember: boolean) => {
      const session = await login(server, email, password);
      await saveCredentials(remember ? { serverUrl: session.serverUrl, email, password } : null);
      setClient(buildClient(session, () => void handleLogout()));
    },
    [handleLogout],
  );

  const openChat = useCallback((agent: Agent, interactionId?: string) => {
    setActiveAgent(agent);
    setActiveInteraction(interactionId ?? newInteractionId(agent.workflowId));
    setSection('chat');
    setDrawer(false);
  }, []);

  const go = useCallback((s: Section) => {
    setSection(s);
    setDrawer(false);
  }, []);

  if (booting) {
    return (
      <div className="boot">
        <div className="boot-logo">XGEN Dex</div>
        <div className="boot-sub">자동 로그인 확인 중…</div>
      </div>
    );
  }
  if (!client) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div
          className="icon-btn"
          role="button"
          aria-label="메뉴"
          onClick={() => setDrawer(true)}
        >
          <span className="hamburger" />
        </div>
        <div className="topbar-title">
          {section === 'chat' && activeAgent
            ? activeAgent.workflowName || activeAgent.workflowId
            : SECTION_TITLE[section]}
        </div>
        {section === 'chat' && <WsBadge state={chatWsState} bridge={bridgeStatus} />}
      </header>

      {/* 세 섹션 상시 마운트 — hidden 전환으로 채팅 WS/스크롤 보존 */}
      <main className="content">
        <div className={section === 'chat' ? 'section' : 'section off'}>
          <ChatSection
            client={client}
            agent={activeAgent}
            interactionId={activeInteraction}
            onWsState={setChatWsState}
            onPickAgent={() => go('agents')}
          />
        </div>
        <div className={section === 'agents' ? 'section' : 'section off'}>
          <AgentsSection client={client} onOpenChat={openChat} />
        </div>
        <div className={section === 'settings' ? 'section' : 'section off'}>
          <SettingsSection
            client={client}
            bridgeStatus={bridgeStatus}
            toolsEnabled={toolsEnabled}
            onToggleTools={setToolsEnabled}
            toolGroups={toolGroups}
            permStates={permStates}
            onToggleGroup={(id: ToolGroup, on: boolean) => void toggleGroup(id, on)}
            onLogout={() => void handleLogout()}
          />
        </div>
      </main>

      {/* 드로어 */}
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
      <nav className={drawer ? 'drawer open' : 'drawer'}>
        <div className="drawer-head">
          <div className="drawer-app">XGEN Dex</div>
          <div className="drawer-user">
            {client.session.username} · {shortHost(client.session.serverUrl)}
          </div>
        </div>
        <DrawerItem
          label="현재 채팅"
          hint={activeAgent ? activeAgent.workflowName || activeAgent.workflowId : '대화 없음'}
          active={section === 'chat'}
          onClick={() => go('chat')}
        />
        <DrawerItem
          label="에이전트 목록"
          active={section === 'agents'}
          onClick={() => go('agents')}
        />
        <DrawerItem
          label="설정"
          hint={
            bridgeStatus.state === 'connected'
              ? `모바일 도구 ${bridgeStatus.toolCount}개 연결됨`
              : toolsEnabled
                ? '모바일 도구 연결 중'
                : '모바일 도구 꺼짐'
          }
          active={section === 'settings'}
          onClick={() => go('settings')}
        />
      </nav>
    </div>
  );
}

function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function DrawerItem({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <div
      className={active ? 'drawer-item active' : 'drawer-item'}
      role="button"
      onClick={onClick}
    >
      <div className="drawer-item-label">{label}</div>
      {hint && <div className="drawer-item-hint">{hint}</div>}
    </div>
  );
}

function WsBadge({
  state,
  bridge,
}: {
  state: ChatWsState;
  bridge: BridgeStatus;
}): React.ReactElement {
  const label =
    state === 'connected'
      ? bridge.state === 'connected'
        ? '연결됨 · 도구'
        : '연결됨'
      : state === 'unsupported'
        ? '미지원'
        : state === 'failed'
          ? '연결 실패'
          : state === 'closed'
            ? ''
            : '연결 중';
  if (!label) return <span />;
  return <span className={`ws-badge ${state}`}>{label}</span>;
}

// ── 로그인 ──────────────────────────────────────────────────────

function LoginScreen({
  onLogin,
}: {
  onLogin: (server: string, email: string, password: string, remember: boolean) => Promise<void>;
}): React.ReactElement {
  const [server, setServer] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void loadCredentials().then((c) => {
      if (!c) return;
      setServer((v) => v || c.serverUrl);
      setEmail((v) => v || c.email);
    });
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await onLogin(server, email, password, remember);
    } catch (e) {
      setError(friendlyError(e, '로그인에 실패했습니다. 서버 주소와 계정을 확인하세요.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="login-logo">XGEN Dex</div>
        <div className="login-sub">서버 세션 채팅 · 모바일 도구</div>
        <label className="field">
          <span>서버 주소</span>
          <input
            placeholder="dev-xgen.x2bee.com"
            value={server}
            onChange={(e) => setServer(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>
        <label className="field">
          <span>이메일</span>
          <input
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            inputMode="email"
          />
        </label>
        <label className="field">
          <span>비밀번호</span>
          <input
            placeholder="••••••••"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>자동 로그인 (이 기기에 계정 저장)</span>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div
          className={busy || !server || !email || !password ? 'btn primary disabled' : 'btn primary'}
          role="button"
          onClick={() => {
            if (!busy && server && email && password) void submit();
          }}
        >
          {busy ? '로그인 중…' : '로그인'}
        </div>
      </div>
    </div>
  );
}

// ── 에이전트 목록 ────────────────────────────────────────────────

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function AgentsSection({
  client,
  onOpenChat,
}: {
  client: XgenMobileClient;
  onOpenChat: (agent: Agent, interactionId?: string) => void;
}): React.ReactElement {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 탭한 에이전트 — 대화 내역 시트가 열린다. */
  const [picked, setPicked] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, convs] = await Promise.all([
        client.api.agents.listAll({ pageSize: 100 }, 5),
        client.api.history.conversations().catch(() => [] as Conversation[]),
      ]);
      diagLog(`에이전트 ${list.length}개 / 대화 ${convs.length}개 로드`);
      setAgents(list);
      setConversations(convs);
    } catch (e) {
      const msg = friendlyError(e, '에이전트 목록을 불러오지 못했습니다.');
      diagLog(`에이전트 목록 실패: ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) =>
      `${a.workflowName ?? ''} ${a.workflowId ?? ''}`.toLowerCase().includes(q),
    );
  }, [agents, search]);

  const convsFor = useCallback(
    (workflowId: string) =>
      conversations
        .filter((c) => c.workflowId === workflowId)
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)),
    [conversations],
  );

  return (
    <div className="pane">
      <div className="pane-toolbar">
        <input
          className="search"
          placeholder="에이전트 검색…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="btn small" role="button" onClick={() => setCreating(true)}>
          + 새 에이전트
        </div>
      </div>

      {error && (
        <div className="notice error-notice">
          <div>{error}</div>
          <div className="btn small" role="button" onClick={() => void load()}>
            다시 시도
          </div>
        </div>
      )}
      {loading && <div className="notice">불러오는 중…</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="notice">에이전트가 없습니다.</div>
      )}

      <div className="agent-scroll">
        {filtered.map((a) => {
          const name = a.workflowName || a.workflowId || '(이름 없음)';
          const count = convsFor(a.workflowId).length;
          return (
            <div
              key={a.workflowId || String(a.id)}
              className="agent-row"
              role="button"
              onClick={() => setPicked(a)}
            >
              <div className="agent-meta">
                <div className="agent-title">{name}</div>
                <div className="agent-sub">
                  {count > 0 ? `대화 ${count}개` : '대화 없음'}
                  {a.description ? ` · ${a.description}` : ''}
                </div>
              </div>
              <div className="agent-go">›</div>
            </div>
          );
        })}
      </div>

      {picked && (
        <ConversationSheet
          agent={picked}
          conversations={convsFor(picked.workflowId)}
          onClose={() => setPicked(null)}
          onPick={(iid) => {
            const a = picked;
            setPicked(null);
            onOpenChat(a, iid);
          }}
        />
      )}
      {creating && (
        <CreateAgentSheet
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(agent) => {
            setCreating(false);
            void load();
            onOpenChat(agent);
          }}
        />
      )}
    </div>
  );
}

/** 에이전트 탭 → 대화 내역 시트: [새 대화] + 과거 대화 목록에서 선택해 이동. */
function ConversationSheet({
  agent,
  conversations,
  onClose,
  onPick,
}: {
  agent: Agent;
  conversations: Conversation[];
  onClose: () => void;
  onPick: (interactionId?: string) => void;
}): React.ReactElement {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">{agent.workflowName || agent.workflowId}</div>
        <div className="btn primary sheet-new" role="button" onClick={() => onPick(undefined)}>
          새 대화 시작
        </div>
        {conversations.length > 0 && <div className="sheet-label">대화 내역</div>}
        <div className="sheet-scroll">
          {conversations.map((c) => (
            <div
              key={c.interactionId}
              className="conv-row"
              role="button"
              onClick={() => onPick(c.interactionId)}
            >
              <div className="conv-main">
                <div className="conv-title">{formatWhen(c.updatedAt) || '대화'}</div>
                <div className="conv-sub">메시지 {c.interactionCount}개</div>
              </div>
              <div className="agent-go">›</div>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="notice">아직 대화가 없습니다.</div>
          )}
        </div>
      </div>
    </>
  );
}

/** [새 에이전트] — 이름 + 제공자/모델(서버 옵션, 기본값 선반영) → 생성 → 바로 채팅. */
function CreateAgentSheet({
  client,
  onClose,
  onCreated,
}: {
  client: XgenMobileClient;
  onClose: () => void;
  onCreated: (agent: Agent) => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [providers, setProviders] = useState<
    Array<{ value: string; label: string; models: Array<{ value: string; label: string }>; defaultModel?: string }>
  >([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void client.api.agents
      .createOptions()
      .then((opts) => {
        setProviders(opts.providers);
        const def = opts.providers.find((p) => p.value === opts.defaultProvider) ?? opts.providers[0];
        if (def) {
          setProvider(def.value);
          setModel(def.defaultModel ?? def.models[0]?.value ?? '');
        }
      })
      .catch((e) => setError(friendlyError(e, '생성 옵션을 불러오지 못했습니다.')));
  }, [client]);

  const current = providers.find((p) => p.value === provider);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const created = await client.api.agents.create({ name: name.trim(), provider, model: model || undefined });
      diagLog(`새 에이전트 생성: ${created.workflowName} (${created.workflowId})`);
      onCreated({
        id: 0,
        workflowId: created.workflowId,
        workflowName: created.workflowName,
        nodeCount: 0,
        isShared: false,
        isDeployed: false,
        isCompleted: false,
        workflowType: 'canvas',
        description: '',
        username: '',
        fullName: '',
        createdAt: '',
        updatedAt: '',
        hasAgentGeny: true,
      } as Agent);
    } catch (e) {
      setError(friendlyError(e, '에이전트 생성에 실패했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet">
        <div className="sheet-handle" />
        <div className="sheet-title">새 에이전트</div>
        <label className="field">
          <span>이름</span>
          <input
            placeholder="예: 리서치 도우미"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {providers.length > 0 && (
          <label className="field">
            <span>AI 제공자</span>
            <select
              value={provider}
              onChange={(e) => {
                const v = e.target.value;
                setProvider(v);
                const p = providers.find((x) => x.value === v);
                setModel(p?.defaultModel ?? p?.models[0]?.value ?? '');
              }}
            >
              {providers.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {current && current.models.length > 0 && (
          <label className="field">
            <span>모델</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {current.models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div
          className={busy || !name.trim() || !provider ? 'btn primary disabled' : 'btn primary'}
          role="button"
          onClick={() => {
            if (!busy && name.trim() && provider) void submit();
          }}
        >
          {busy ? '만드는 중…' : '만들기'}
        </div>
      </div>
    </>
  );
}

// ── 현재 채팅 ────────────────────────────────────────────────────

function ChatSection({
  client,
  agent,
  interactionId,
  onWsState,
  onPickAgent,
}: {
  client: XgenMobileClient;
  agent: Agent | null;
  interactionId: string;
  onWsState: (s: ChatWsState) => void;
  onPickAgent: () => void;
}): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [wsState, setWsState] = useState<ChatWsState>('closed');
  const [running, setRunning] = useState(false);
  const chatRef = useRef<ChatWsHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onWsState(wsState);
  }, [wsState, onWsState]);

  // 과거 턴 로드 (이어하기).
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    setMessages([]);
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

  // WS 연결 — 대화 단위 수명. 섹션 전환에도 살아 있다 (부모가 상시 마운트).
  useEffect(() => {
    if (!agent) return;
    const handle = createChat({
      wsBase: wsBaseOf(client.session.serverUrl),
      workflowId: agent.workflowId,
      workflowName: agent.workflowName || agent.workflowId,
      interactionId,
      onState: setWsState,
      log: diagLog,
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
          setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
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

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const send = async (): Promise<void> => {
    const text = input.trim();
    if (!text || running || !chatRef.current) return;
    setInput('');
    if (composerRef.current) composerRef.current.style.height = 'auto';
    setRunning(true);
    setMessages((prev) => [...prev, { role: 'user', text }]);
    try {
      await chatRef.current.execute(text);
    } catch (e) {
      setRunning(false);
      const msg = friendlyError(e, '실행에 실패했습니다.');
      setMessages((prev) =>
        prev[prev.length - 1]?.role === 'error' ? prev : [...prev, { role: 'error', text: msg }],
      );
    }
  };

  if (!agent) {
    return (
      <div className="pane center-pane">
        <div className="empty-title">진행 중인 대화가 없습니다</div>
        <div className="empty-sub">에이전트를 선택해 대화를 시작하세요.</div>
        <div className="btn primary" role="button" onClick={onPickAgent}>
          에이전트 목록 열기
        </div>
      </div>
    );
  }

  return (
    <div className="pane chat-pane">
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
          <div className="notice">메시지를 보내 대화를 시작하세요.</div>
        )}
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={composerRef}
            value={input}
            placeholder={
              wsState === 'connected'
                ? '메시지를 입력하세요'
                : wsState === 'unsupported'
                  ? '이 에이전트는 모바일 채팅을 지원하지 않습니다'
                  : '연결 중…'
            }
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              // 자동 확장 — 내용만큼 (최대 높이는 CSS 가 자른다).
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = `${el.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {running ? (
            <div
              className="send-btn stop"
              role="button"
              aria-label="중지"
              onClick={() => chatRef.current?.stop()}
            >
              <svg viewBox="0 0 24 24" width="16" height="16">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            </div>
          ) : (
            <div
              className={
                wsState !== 'connected' || !input.trim() ? 'send-btn disabled' : 'send-btn'
              }
              role="button"
              aria-label="전송"
              onClick={() => {
                if (wsState === 'connected' && input.trim()) void send();
              }}
            >
              <svg viewBox="0 0 24 24" width="18" height="18">
                <path
                  d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8Z"
                  fill="currentColor"
                />
              </svg>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 설정 ────────────────────────────────────────────────────────

function SettingsSection({
  client,
  bridgeStatus,
  toolsEnabled,
  onToggleTools,
  toolGroups,
  permStates,
  onToggleGroup,
  onLogout,
}: {
  client: XgenMobileClient;
  bridgeStatus: BridgeStatus;
  toolsEnabled: boolean;
  onToggleTools: (on: boolean) => void;
  toolGroups: Record<ToolGroup, boolean>;
  permStates: Partial<Record<ToolGroup, PermissionState>>;
  onToggleGroup: (id: ToolGroup, on: boolean) => void;
  onLogout: () => void;
}): React.ReactElement {
  const bridgeLabel =
    bridgeStatus.state === 'connected'
      ? `연결됨 · 서버에 도구 ${bridgeStatus.toolCount}개 적용`
      : bridgeStatus.state === 'connecting'
        ? '연결 중…'
        : bridgeStatus.state === 'error'
          ? `오류: ${bridgeStatus.error ?? ''}`
          : '꺼짐';

  return (
    <div className="pane settings-scroll">
      <div className="card">
        <div className="card-title">모바일 도구</div>
        <label className="check-row big">
          <input
            type="checkbox"
            checked={toolsEnabled}
            onChange={(e) => onToggleTools(e.target.checked)}
          />
          <span>에이전트가 이 휴대폰을 도구로 사용</span>
        </label>
        <div className={`tool-state ${bridgeStatus.state}`}>{bridgeLabel}</div>
        <div className="card-sub">
          그룹을 켜면 필요한 <b>시스템 권한 승인</b>을 먼저 요청합니다 — 승인해야 켜집니다.
          꺼진 그룹의 도구는 에이전트에게 노출되지 않습니다. 데스크톱 커넥터가 켜져 있어도
          이 앱이 연결된 동안은 휴대폰 도구가 우선합니다.
        </div>

        <div className="group-list">
          {TOOL_GROUPS.map((g) => {
            const on = toolGroups[g.id];
            const perm = permStates[g.id];
            return (
              <div key={g.id} className="group-row">
                <div className="group-meta">
                  <div className="group-name">
                    {g.label}
                    {g.permission && <span className="group-perm-tag">권한 필요</span>}
                  </div>
                  <div className="group-desc">{g.description}</div>
                  {perm === 'denied' && (
                    <div className="group-denied">
                      권한이 거부되었습니다 — 휴대폰 설정 &gt; 앱 &gt; XGEN Dex 에서 허용하세요.
                    </div>
                  )}
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!toolsEnabled}
                    onChange={(e) => onToggleGroup(g.id, e.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">계정</div>
        <div className="kv">
          <span>서버</span>
          <span>{client.session.serverUrl}</span>
        </div>
        <div className="kv">
          <span>사용자</span>
          <span>
            {client.session.username} (id {client.session.userId})
          </span>
        </div>
        <div className="btn danger" role="button" onClick={onLogout}>
          로그아웃
        </div>
      </div>

      <DiagCard />

      <div className="card">
        <div className="card-title">정보</div>
        <div className="card-sub">
          XGEN Dex Android — 서버 세션 채팅 + 모바일 도구. 클라우드/브라우저 등 데스크톱 특수
          기능은 포함하지 않습니다.
        </div>
      </div>
    </div>
  );
}

function DiagCard(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => onDiag(() => force((n) => n + 1)), []);
  return (
    <div className="card">
      <div className="card-title-row" role="button" onClick={() => setOpen((v) => !v)}>
        <div className="card-title">진단</div>
        <div className="card-chevron">{open ? '▾' : '▸'}</div>
      </div>
      {open && (
        <div className="diag-body">
          {diagEntries()
            .slice()
            .reverse()
            .map((e, i) => (
              <div key={i} className="mono">
                {e.at} {e.line}
              </div>
            ))}
          {diagEntries().length === 0 && <div className="card-sub">기록 없음</div>}
        </div>
      )}
    </div>
  );
}
