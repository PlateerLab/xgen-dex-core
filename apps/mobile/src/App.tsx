/**
 * XGEN Dex Mobile — React Native(Expo) 크로스플랫폼 (Android/iOS).
 *
 * 구조는 WebView 세대와 동일(제품 지시): 좌상단 [☰] → 드로어로
 * [현재 채팅] / [에이전트 목록] / [설정]. 세 섹션은 상시 마운트(숨김 전환)라
 * 채팅 WS/스크롤이 이동 중에도 살아 있다. 순수 로직(chat-ws/tool-bridge/
 * mobile-tools)은 WebView 세대와 같은 파일 — 전송로만 RN 네이티브다
 * (fetch/WS 에 CORS 없음, WS 는 Bearer 헤더 인증).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RnStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import MarkdownDisplay from 'react-native-markdown-display';
import type { Agent, Conversation } from '@dex/protocol';
import { createChat, stripAgentMarkers, type ChatWsHandle, type ChatWsState } from './lib/chat-ws';
import { MobileToolBridge, type BridgeStatus } from './lib/tool-bridge';
import {
  advertiseMobileTools,
  callMobileTool,
  TOOL_GROUPS,
  type PermissionState,
  type ToolGroup,
} from './lib/mobile-tools';
import { rnPort, ensureToolRoot } from './lib/rn-port';
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
import AsyncStorage from '@react-native-async-storage/async-storage';

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

// ── 팔레트 (라이트/다크) ─────────────────────────────────────────

interface Palette {
  bg: string; panel: string; panel2: string; text: string; muted: string;
  border: string; primary: string; onPrimary: string; danger: string; ok: string;
  assistantBubble: string;
}
const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    bg: '#F5F6F8', panel: '#FFFFFF', panel2: '#EEF0F4', text: '#16181D',
    muted: '#667085', border: '#E3E6EC', primary: '#5B5BD6', onPrimary: '#FFFFFF',
    danger: '#D92D20', ok: '#12B76A', assistantBubble: '#FFFFFF',
  },
  dark: {
    bg: '#0E1015', panel: '#171A21', panel2: '#1F232C', text: '#E9ECF2',
    muted: '#8B93A3', border: '#262B35', primary: '#5B5BD6', onPrimary: '#FFFFFF',
    danger: '#F97066', ok: '#32D583', assistantBubble: '#1C202A',
  },
};
const PaletteCtx = React.createContext<Palette>(PALETTES.dark);
const useP = () => React.useContext(PaletteCtx);

export default function App(): React.ReactElement {
  const scheme = useColorScheme();
  const p = PALETTES[scheme === 'light' ? 'light' : 'dark'];

  const [booting, setBooting] = useState(true);
  const [client, setClient] = useState<XgenMobileClient | null>(null);
  const [section, setSection] = useState<Section>('agents');
  const [drawer, setDrawer] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ state: 'off', toolCount: 0 });
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [toolGroups, setToolGroups] = useState<Record<ToolGroup, boolean>>({
    files: true, notify: true, clipboard: true, device: true,
    camera: true, location: false, actions: true,
  });
  const [permStates, setPermStates] = useState<Partial<Record<ToolGroup, PermissionState>>>({});
  const groupsRef = useRef(toolGroups);
  groupsRef.current = toolGroups;
  const bridgeRef = useRef<MobileToolBridge | null>(null);

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

  // 자동 로그인 체인 — 토큰 검증/회전 → 저장 자격증명 재로그인 → 로그인 화면.
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

  // 도구 그룹 설정 영속.
  //
  // ⚠ groupsRef 는 렌더 때만 따라오므로, hello(카탈로그 광고)가 그룹 변경을
  // **즉시** 보려면 ref 를 상태보다 먼저 직접 갱신해야 한다 — 안 그러면
  // 토글 직후의 재광고가 옛 카탈로그를 내보내는 스테일 버그가 된다(실사고:
  // 세션 실행 중 [위치] 를 켜도 에이전트에 Location 도구가 안 보임).
  useEffect(() => {
    void AsyncStorage.getItem('tool-groups').then((v) => {
      if (!v) return;
      try {
        const merged = { ...groupsRef.current, ...(JSON.parse(v) as object) } as Record<
          ToolGroup,
          boolean
        >;
        groupsRef.current = merged;
        setToolGroups(merged);
        // 브리지가 저장값 로드 전에 기본 카탈로그로 hello 했을 수 있다 — 재광고.
        bridgeRef.current?.refreshCatalog();
      } catch {
        /* 무시 */
      }
    });
  }, []);
  const persistGroups = useCallback((next: Record<ToolGroup, boolean>) => {
    groupsRef.current = next; // 재광고가 새 그룹을 보도록 렌더보다 먼저.
    setToolGroups(next);
    void AsyncStorage.setItem('tool-groups', JSON.stringify(next));
    bridgeRef.current?.refreshCatalog();
  }, []);
  const toggleGroup = useCallback(
    async (id: ToolGroup, on: boolean) => {
      if (!on) {
        persistGroups({ ...groupsRef.current, [id]: false });
        return;
      }
      const meta = TOOL_GROUPS.find((g) => g.id === id);
      if (meta?.permission) {
        const state = await rnPort.requestPermission(meta.permission);
        setPermStates((prev) => ({ ...prev, [id]: state }));
        diagLog(`도구 그룹 '${id}' 권한 요청 → ${state}`);
        if (state === 'denied') return;
      }
      persistGroups({ ...groupsRef.current, [id]: true });
    },
    [persistGroups],
  );

  // 도구 브리지 수명.
  useEffect(() => {
    bridgeRef.current?.stop();
    bridgeRef.current = null;
    if (!client || !toolsEnabled) {
      setBridgeStatus({ state: 'off', toolCount: 0 });
      return;
    }
    void ensureToolRoot();
    const bridge = new MobileToolBridge({
      wsBase: wsBaseOf(client.session.serverUrl),
      userId: client.session.userId,
      catalog: () => advertiseMobileTools(groupsRef.current),
      call: (tool, args) => callMobileTool(rnPort, tool, args, groupsRef.current),
      onStatus: setBridgeStatus,
      wsFactory: client.wsFactory,
      log: diagLog,
    });
    bridge.start();
    bridgeRef.current = bridge;
    return () => bridge.stop();
  }, [client, toolsEnabled]);

  // 앱 복귀 — 브리지 즉시 재연결.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') bridgeRef.current?.kick();
    });
    return () => sub.remove();
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

  const st = useMemo(() => makeStyles(p), [p]);

  let body: React.ReactElement;
  if (booting) {
    body = (
      <View style={st.boot}>
        <Text style={st.bootLogo}>XGEN Dex</Text>
        <Text style={st.mutedText}>자동 로그인 확인 중…</Text>
      </View>
    );
  } else if (!client) {
    body = <LoginScreen onLogin={handleLogin} />;
  } else {
    body = (
      <View style={st.shell}>
        <View style={st.topbar}>
          <Pressable style={st.iconBtn} onPress={() => setDrawer(true)} accessibilityLabel="메뉴">
            <View style={st.hambLine} />
            <View style={[st.hambLine, { marginVertical: 4 }]} />
            <View style={st.hambLine} />
          </Pressable>
          <Text style={st.topbarTitle} numberOfLines={1}>
            {section === 'chat' && activeAgent
              ? activeAgent.workflowName || activeAgent.workflowId
              : SECTION_TITLE[section]}
          </Text>
          {section === 'chat' && <WsBadge state={chatWsState} bridge={bridgeStatus} />}
        </View>

        <View style={st.content}>
          <View style={[st.section, section !== 'chat' && st.off]}>
            <ChatSection
              client={client}
              agent={activeAgent}
              interactionId={activeInteraction}
              onWsState={setChatWsState}
              onPickAgent={() => go('agents')}
            />
          </View>
          <View style={[st.section, section !== 'agents' && st.off]}>
            <AgentsSection client={client} onOpenChat={openChat} />
          </View>
          <View style={[st.section, section !== 'settings' && st.off]}>
            <SettingsSection
              client={client}
              bridgeStatus={bridgeStatus}
              toolsEnabled={toolsEnabled}
              onToggleTools={setToolsEnabled}
              toolGroups={toolGroups}
              permStates={permStates}
              onToggleGroup={(id, on) => void toggleGroup(id, on)}
              onLogout={() => void handleLogout()}
            />
          </View>
        </View>

        <Modal visible={drawer} transparent animationType="fade" onRequestClose={() => setDrawer(false)}>
          <Pressable style={st.scrim} onPress={() => setDrawer(false)} />
          <View style={st.drawer}>
            <View style={st.drawerHead}>
              <Text style={st.drawerApp}>XGEN Dex</Text>
              <Text style={st.mutedSmall} numberOfLines={1}>
                {client.session.username} · {shortHost(client.session.serverUrl)}
              </Text>
            </View>
            <DrawerItem
              label="현재 채팅"
              hint={activeAgent ? activeAgent.workflowName || activeAgent.workflowId : '대화 없음'}
              active={section === 'chat'}
              onPress={() => go('chat')}
            />
            <DrawerItem label="에이전트 목록" active={section === 'agents'} onPress={() => go('agents')} />
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
              onPress={() => go('settings')}
            />
          </View>
        </Modal>
      </View>
    );
  }

  return (
    <PaletteCtx.Provider value={p}>
      <View style={{ flex: 1, backgroundColor: p.bg, paddingTop: Platform.OS === 'android' ? RnStatusBar.currentHeight ?? 0 : 0 }}>
        <StatusBar style={scheme === 'light' ? 'dark' : 'light'} />
        {body}
      </View>
    </PaletteCtx.Provider>
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
  onPress,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onPress: () => void;
}): React.ReactElement {
  const p = useP();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        { borderRadius: 12, padding: 13 },
        active && { backgroundColor: `${p.primary}20` },
        pressed && { backgroundColor: p.panel2 },
      ]}
    >
      <Text style={{ fontSize: 15, fontWeight: '700', color: active ? p.primary : p.text }}>{label}</Text>
      {hint ? (
        <Text style={{ fontSize: 12, color: p.muted, marginTop: 2 }} numberOfLines={1}>
          {hint}
        </Text>
      ) : null}
    </Pressable>
  );
}

function WsBadge({ state, bridge }: { state: ChatWsState; bridge: BridgeStatus }): React.ReactElement | null {
  const p = useP();
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
  if (!label) return null;
  const color = state === 'connected' ? p.ok : state === 'failed' || state === 'unsupported' ? p.danger : p.muted;
  return <Text style={{ fontSize: 11, fontWeight: '700', color, maxWidth: 110 }}>{label}</Text>;
}

// ── 로그인 ──────────────────────────────────────────────────────

function LoginScreen({
  onLogin,
}: {
  onLogin: (server: string, email: string, password: string, remember: boolean) => Promise<void>;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
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
  const ready = !busy && !!server && !!email && !!password;

  return (
    <ScrollView contentContainerStyle={st.loginWrap} keyboardShouldPersistTaps="handled">
      <Text style={st.bootLogo}>XGEN Dex</Text>
      <Text style={[st.mutedText, { marginBottom: 14 }]}>서버 세션 채팅 · 모바일 도구</Text>
      <Field label="서버 주소" value={server} onChange={setServer} placeholder="dev-xgen.x2bee.com" />
      <Field label="이메일" value={email} onChange={setEmail} placeholder="you@company.com" keyboard="email-address" />
      <Field label="비밀번호" value={password} onChange={setPassword} placeholder="••••••••" secure />
      <Pressable style={st.checkRow} onPress={() => setRemember((v) => !v)}>
        <Switch value={remember} onValueChange={setRemember} trackColor={{ true: p.primary }} />
        <Text style={{ color: p.text, fontSize: 14 }}>자동 로그인 (이 기기에 계정 저장)</Text>
      </Pressable>
      {error ? <Text style={st.formError}>{error}</Text> : null}
      <Pressable
        style={[st.btnPrimary, !ready && { opacity: 0.4 }]}
        disabled={!ready}
        onPress={() => void submit()}
      >
        {busy ? <ActivityIndicator color={p.onPrimary} /> : <Text style={st.btnPrimaryText}>로그인</Text>}
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
  keyboard,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secure?: boolean;
  keyboard?: 'email-address';
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  return (
    <View style={{ width: '100%', marginBottom: 10 }}>
      <Text style={st.fieldLabel}>{label}</Text>
      <TextInput
        style={st.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={p.muted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        keyboardType={keyboard}
        returnKeyType="done"
      />
    </View>
  );
}

// ── 에이전트 목록 ────────────────────────────────────────────────

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function AgentsSection({
  client,
  onOpenChat,
}: {
  client: XgenMobileClient;
  onOpenChat: (agent: Agent, interactionId?: string) => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    return agents.filter((a) => `${a.workflowName ?? ''} ${a.workflowId ?? ''}`.toLowerCase().includes(q));
  }, [agents, search]);

  const convsFor = useCallback(
    (workflowId: string) =>
      conversations
        .filter((c) => c.workflowId === workflowId)
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)),
    [conversations],
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={st.paneToolbar}>
        <TextInput
          style={[st.input, { flex: 1, backgroundColor: p.panel2, borderColor: 'transparent' }]}
          placeholder="에이전트 검색…"
          placeholderTextColor={p.muted}
          value={search}
          onChangeText={setSearch}
        />
        <Pressable style={st.btnSmall} onPress={() => setCreating(true)}>
          <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>+ 새 에이전트</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={st.notice}>
          <Text style={{ color: p.danger, textAlign: 'center' }}>{error}</Text>
          <Pressable style={[st.btnSmall, { marginTop: 8, alignSelf: 'center' }]} onPress={() => void load()}>
            <Text style={{ color: p.text, fontSize: 13, fontWeight: '700' }}>다시 시도</Text>
          </Pressable>
        </View>
      ) : null}
      {loading ? <ActivityIndicator style={{ marginTop: 20 }} color={p.primary} /> : null}
      {!loading && !error && filtered.length === 0 ? (
        <Text style={st.notice}>에이전트가 없습니다.</Text>
      ) : null}

      <FlatList
        data={filtered}
        keyExtractor={(a) => a.workflowId || String(a.id)}
        contentContainerStyle={{ padding: 12, paddingBottom: 24 }}
        renderItem={({ item: a }) => {
          const name = a.workflowName || a.workflowId || '(이름 없음)';
          const count = convsFor(a.workflowId).length;
          return (
            <Pressable
              style={({ pressed }) => [st.agentRow, pressed && { backgroundColor: p.panel2 }]}
              onPress={() => setPicked(a)}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.agentTitle} numberOfLines={1}>
                  {name}
                </Text>
                <Text style={st.mutedSmall} numberOfLines={1}>
                  {count > 0 ? `대화 ${count}개` : '대화 없음'}
                  {a.description ? ` · ${a.description}` : ''}
                </Text>
              </View>
              <Text style={{ color: p.muted, fontSize: 18, fontWeight: '700' }}>›</Text>
            </Pressable>
          );
        }}
      />

      <Modal visible={!!picked} transparent animationType="slide" onRequestClose={() => setPicked(null)}>
        <Pressable style={st.scrim} onPress={() => setPicked(null)} />
        <KeyboardAvoidingView behavior="padding" style={st.sheetHost} pointerEvents="box-none">
          {picked && (
            <View style={st.sheet}>
            <View style={st.sheetHandle} />
            <Text style={st.sheetTitle} numberOfLines={1}>
              {picked.workflowName || picked.workflowId}
            </Text>
            <Pressable
              style={st.btnPrimary}
              onPress={() => {
                const a = picked;
                setPicked(null);
                onOpenChat(a);
              }}
            >
              <Text style={st.btnPrimaryText}>새 대화 시작</Text>
            </Pressable>
            {convsFor(picked.workflowId).length > 0 && (
              <Text style={[st.fieldLabel, { marginTop: 8 }]}>대화 내역</Text>
            )}
            <FlatList
              data={convsFor(picked.workflowId)}
              keyExtractor={(c) => c.interactionId}
              style={{ maxHeight: 340 }}
              renderItem={({ item: c }) => (
                <Pressable
                  style={({ pressed }) => [st.convRow, pressed && { backgroundColor: p.panel2 }]}
                  onPress={() => {
                    const a = picked;
                    setPicked(null);
                    onOpenChat(a, c.interactionId);
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: p.text, fontSize: 14, fontWeight: '700' }}>
                      {formatWhen(c.updatedAt) || '대화'}
                    </Text>
                    <Text style={st.mutedSmall}>메시지 {c.interactionCount}개</Text>
                  </View>
                  <Text style={{ color: p.muted, fontSize: 18 }}>›</Text>
                </Pressable>
              )}
            />
            </View>
          )}
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
        <Pressable style={st.scrim} onPress={() => setCreating(false)} />
        <KeyboardAvoidingView behavior="padding" style={st.sheetHost} pointerEvents="box-none">
          <CreateAgentSheet
            client={client}
            onCreated={(agent) => {
              setCreating(false);
              void load();
              onOpenChat(agent);
            }}
          />
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function CreateAgentSheet({
  client,
  onCreated,
}: {
  client: XgenMobileClient;
  onCreated: (agent: Agent) => void;
}): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
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
        const def = opts.providers.find((x) => x.value === opts.defaultProvider) ?? opts.providers[0];
        if (def) {
          setProvider(def.value);
          setModel(def.defaultModel ?? def.models[0]?.value ?? '');
        }
      })
      .catch((e) => setError(friendlyError(e, '생성 옵션을 불러오지 못했습니다.')));
  }, [client]);

  const current = providers.find((x) => x.value === provider);
  const ready = !busy && !!name.trim() && !!provider;

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
    <View style={st.sheet}>
      <View style={st.sheetHandle} />
      <Text style={st.sheetTitle}>새 에이전트</Text>
      {/* 키보드가 떠서 공간이 줄어도 provider/model/만들기 버튼이 전부 닿도록
          내용은 스크롤 컨테이너에 담고, 키보드를 내리지 않고도 칩을 바로
          누를 수 있게 keyboardShouldPersistTaps 를 켠다. */}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 10 }}
      >
      <Field label="이름" value={name} onChange={setName} placeholder="예: 리서치 도우미" />
      {providers.length > 0 && (
        <View style={{ width: '100%', marginBottom: 10 }}>
          <Text style={st.fieldLabel}>AI 제공자</Text>
          <View style={st.chipsWrap}>
            {providers.map((pr) => (
              <Pressable
                key={pr.value}
                style={[st.chip, provider === pr.value && { backgroundColor: p.primary }]}
                onPress={() => {
                  setProvider(pr.value);
                  setModel(pr.defaultModel ?? pr.models[0]?.value ?? '');
                }}
              >
                <Text style={{ color: provider === pr.value ? p.onPrimary : p.text, fontSize: 13 }}>
                  {pr.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {current && current.models.length > 0 && (
        <View style={{ width: '100%', marginBottom: 10 }}>
          <Text style={st.fieldLabel}>모델</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={st.chipsWrap}>
              {current.models.map((m) => (
                <Pressable
                  key={m.value}
                  style={[st.chip, model === m.value && { backgroundColor: p.primary }]}
                  onPress={() => setModel(m.value)}
                >
                  <Text style={{ color: model === m.value ? p.onPrimary : p.text, fontSize: 13 }}>
                    {m.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      )}
      {error ? <Text style={st.formError}>{error}</Text> : null}
      <Pressable style={[st.btnPrimary, !ready && { opacity: 0.4 }]} disabled={!ready} onPress={() => void submit()}>
        {busy ? <ActivityIndicator color={p.onPrimary} /> : <Text style={st.btnPrimaryText}>만들기</Text>}
      </Pressable>
      </ScrollView>
    </View>
  );
}

// ── 어시스턴트 마크다운 ──────────────────────────────────────────

/** 채팅 답변 마크다운 렌더 — 웹/데스크톱과 동일하게 볼드·리스트·표·코드블록·
 *  링크가 실제로 그려진다 (이전엔 평문이라 마크업 기호가 그대로 보였다). */
const AssistantMarkdown: React.FC<{ text: string }> = React.memo(({ text }) => {
  const p = useP();
  const styles = useMemo(
    () => ({
      body: { color: p.text, fontSize: 15, lineHeight: 22 },
      paragraph: { marginTop: 0, marginBottom: 8 },
      heading1: { fontSize: 20, fontWeight: '800' as const, marginBottom: 8, color: p.text },
      heading2: { fontSize: 18, fontWeight: '800' as const, marginBottom: 6, color: p.text },
      heading3: { fontSize: 16, fontWeight: '700' as const, marginBottom: 6, color: p.text },
      heading4: { fontSize: 15, fontWeight: '700' as const, color: p.text },
      strong: { fontWeight: '700' as const },
      link: { color: p.primary, textDecorationLine: 'underline' as const },
      bullet_list: { marginBottom: 8 },
      ordered_list: { marginBottom: 8 },
      list_item: { flexDirection: 'row' as const, marginBottom: 3 },
      blockquote: {
        backgroundColor: p.panel2, borderLeftWidth: 3, borderLeftColor: p.primary,
        paddingHorizontal: 10, paddingVertical: 4, marginBottom: 8, borderRadius: 4,
      },
      code_inline: {
        backgroundColor: p.panel2, color: p.text, borderRadius: 4,
        paddingHorizontal: 4, fontSize: 13,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      },
      code_block: {
        backgroundColor: p.panel2, color: p.text, borderRadius: 8, padding: 10,
        fontSize: 12.5, borderWidth: 0,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      },
      fence: {
        backgroundColor: p.panel2, color: p.text, borderRadius: 8, padding: 10,
        fontSize: 12.5, borderWidth: 0, marginBottom: 8,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      },
      table: { borderWidth: 1, borderColor: p.border, borderRadius: 6, marginBottom: 8 },
      th: { padding: 6, fontWeight: '700' as const },
      td: { padding: 6, borderTopWidth: 1, borderColor: p.border },
      hr: { backgroundColor: p.border, height: 1, marginVertical: 10 },
    }),
    [p],
  );
  return (
    <MarkdownDisplay
      style={styles}
      onLinkPress={(url) => {
        void Linking.openURL(url).catch(() => undefined);
        return false; // 기본 핸들러 중복 방지
      }}
    >
      {text}
    </MarkdownDisplay>
  );
});
AssistantMarkdown.displayName = 'AssistantMarkdown';

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
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [wsState, setWsState] = useState<ChatWsState>('closed');
  const [running, setRunning] = useState(false);
  const chatRef = useRef<ChatWsHandle | null>(null);
  const listRef = useRef<FlatList<Message>>(null);

  useEffect(() => {
    onWsState(wsState);
  }, [wsState, onWsState]);

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

  useEffect(() => {
    if (!agent) return;
    const handle = createChat({
      wsBase: wsBaseOf(client.session.serverUrl),
      workflowId: agent.workflowId,
      workflowName: agent.workflowName || agent.workflowId,
      interactionId,
      onState: setWsState,
      wsFactory: client.wsFactory,
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
            setMessages((prev) => [...prev, { role: 'tool', text: `도구 실행: ${ev.toolName ?? ''}` }]);
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
    const t = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length]);

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
      const msg = friendlyError(e, '실행에 실패했습니다.');
      setMessages((prev) =>
        prev[prev.length - 1]?.role === 'error' ? prev : [...prev, { role: 'error', text: msg }],
      );
    }
  };

  if (!agent) {
    return (
      <View style={[st.notice, { flex: 1, justifyContent: 'center' }]}>
        <Text style={{ color: p.text, fontSize: 17, fontWeight: '800', textAlign: 'center' }}>
          진행 중인 대화가 없습니다
        </Text>
        <Text style={[st.mutedText, { textAlign: 'center', marginVertical: 8 }]}>
          에이전트를 선택해 대화를 시작하세요.
        </Text>
        <Pressable style={[st.btnPrimary, { alignSelf: 'center' }]} onPress={onPickAgent}>
          <Text style={st.btnPrimaryText}>에이전트 목록 열기</Text>
        </Pressable>
      </View>
    );
  }

  const canSend = wsState === 'connected' && !!input.trim();

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        renderItem={({ item: m }) => {
          const text = m.role === 'assistant' ? stripAgentMarkers(m.text) : m.text;
          if (!text && !m.streaming) return null;
          return (
            <View
              style={[
                st.msg,
                m.role === 'user' && st.msgUser,
                m.role === 'assistant' && st.msgAssistant,
                m.role === 'tool' && st.msgTool,
                m.role === 'error' && st.msgError,
              ]}
            >
              {m.role === 'assistant' ? (
                <AssistantMarkdown text={m.streaming ? `${text} ▍` : text} />
              ) : (
                <Text
                  style={{
                    color: m.role === 'user' ? '#fff' : m.role === 'error' ? p.danger : p.muted,
                    fontSize: m.role === 'tool' || m.role === 'error' ? 12 : 15,
                  }}
                >
                  {text}
                </Text>
              )}
            </View>
          );
        }}
        ListEmptyComponent={<Text style={st.notice}>메시지를 보내 대화를 시작하세요.</Text>}
      />

      <View style={st.composer}>
        <View style={st.composerBox}>
          <TextInput
            style={st.composerInput}
            value={input}
            onChangeText={setInput}
            placeholder={
              wsState === 'connected'
                ? '메시지를 입력하세요'
                : wsState === 'unsupported'
                  ? '이 에이전트는 모바일 채팅을 지원하지 않습니다'
                  : '연결 중…'
            }
            placeholderTextColor={p.muted}
            multiline
          />
          {running ? (
            <Pressable style={[st.sendBtn, { backgroundColor: p.danger }]} onPress={() => chatRef.current?.stop()}>
              <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' }} />
            </Pressable>
          ) : (
            <Pressable
              style={[st.sendBtn, !canSend && { opacity: 0.35 }]}
              disabled={!canSend}
              onPress={() => void send()}
            >
              <Text style={{ color: p.onPrimary, fontSize: 16, fontWeight: '900', marginLeft: 2 }}>➤</Text>
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
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
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const bridgeLabel =
    bridgeStatus.state === 'connected'
      ? `연결됨 · 서버에 도구 ${bridgeStatus.toolCount}개 적용`
      : bridgeStatus.state === 'connecting'
        ? '연결 중…'
        : bridgeStatus.state === 'error'
          ? `오류: ${bridgeStatus.error ?? ''}`
          : '꺼짐';

  return (
    <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 28 }}>
      <View style={st.card}>
        <Text style={st.cardTitle}>모바일 도구</Text>
        <Pressable style={st.checkRow} onPress={() => onToggleTools(!toolsEnabled)}>
          <Switch value={toolsEnabled} onValueChange={onToggleTools} trackColor={{ true: p.primary }} />
          <Text style={{ color: p.text, fontSize: 15, fontWeight: '600', flex: 1 }}>
            에이전트가 이 휴대폰을 도구로 사용
          </Text>
        </Pressable>
        <Text
          style={{
            fontSize: 13,
            fontWeight: '700',
            marginTop: 6,
            color: bridgeStatus.state === 'connected' ? p.ok : bridgeStatus.state === 'error' ? p.danger : p.muted,
          }}
        >
          {bridgeLabel}
        </Text>
        <Text style={st.cardSub}>
          그룹을 켜면 필요한 시스템 권한 승인을 먼저 요청합니다 — 승인해야 켜집니다. 꺼진 그룹의
          도구는 에이전트에게 노출되지 않습니다.
        </Text>

        <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: p.border }}>
          {TOOL_GROUPS.map((g) => (
            <View key={g.id} style={st.groupRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: p.text, fontSize: 14, fontWeight: '700' }}>{g.label}</Text>
                  {g.permission ? (
                    <Text style={st.permTag}>권한 필요</Text>
                  ) : null}
                </View>
                <Text style={st.mutedSmall}>{g.description}</Text>
                {permStates[g.id] === 'denied' ? (
                  <Text style={{ fontSize: 11, color: p.danger, marginTop: 3 }}>
                    권한이 거부되었습니다 — 휴대폰 설정 &gt; 앱 &gt; XGEN Dex 에서 허용하세요.
                  </Text>
                ) : null}
              </View>
              <Switch
                value={toolGroups[g.id]}
                disabled={!toolsEnabled}
                onValueChange={(on) => onToggleGroup(g.id, on)}
                trackColor={{ true: p.primary }}
              />
            </View>
          ))}
        </View>
      </View>

      <View style={st.card}>
        <Text style={st.cardTitle}>계정</Text>
        <KV k="서버" v={client.session.serverUrl} />
        <KV k="사용자" v={`${client.session.username} (id ${client.session.userId})`} />
        <Pressable style={st.btnDanger} onPress={onLogout}>
          <Text style={{ color: p.danger, fontWeight: '700' }}>로그아웃</Text>
        </Pressable>
      </View>

      <DiagCard />

      <View style={st.card}>
        <Text style={st.cardTitle}>정보</Text>
        <Text style={st.cardSub}>
          XGEN Dex Mobile — React Native 크로스플랫폼(Android/iOS). 서버 세션 채팅 + 모바일 도구.
          클라우드/브라우저 등 데스크톱 특수 기능은 포함하지 않습니다.
        </Text>
      </View>
    </ScrollView>
  );
}

function KV({ k, v }: { k: string; v: string }): React.ReactElement {
  const p = useP();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 7 }}>
      <Text style={{ color: p.muted, fontSize: 14 }}>{k}</Text>
      <Text style={{ color: p.text, fontSize: 14, flex: 1, textAlign: 'right' }}>{v}</Text>
    </View>
  );
}

function DiagCard(): React.ReactElement {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => onDiag(() => force((n) => n + 1)), []);
  return (
    <View style={st.card}>
      <Pressable
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        onPress={() => setOpen((v) => !v)}
      >
        <Text style={st.cardTitle}>진단</Text>
        <Text style={{ color: p.muted }}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open && (
        <View style={{ marginTop: 8, maxHeight: 360 }}>
          <ScrollView>
            {diagEntries()
              .slice()
              .reverse()
              .map((e, i) => (
                <Text key={i} style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, color: p.muted }}>
                  {e.at} {e.line}
                </Text>
              ))}
            {diagEntries().length === 0 && <Text style={st.cardSub}>기록 없음</Text>}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ── 스타일 ──────────────────────────────────────────────────────

function makeStyles(p: Palette) {
  return StyleSheet.create({
    boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
    bootLogo: { fontSize: 28, fontWeight: '800', color: p.text, letterSpacing: -0.5 },
    mutedText: { color: p.muted, fontSize: 14 },
    mutedSmall: { color: p.muted, fontSize: 12, marginTop: 1 },

    shell: { flex: 1 },
    topbar: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingHorizontal: 12, paddingVertical: 10,
      backgroundColor: p.panel, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    topbarTitle: { flex: 1, fontSize: 17, fontWeight: '800', color: p.text },
    iconBtn: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
    hambLine: { width: 20, height: 2, borderRadius: 1, backgroundColor: p.text },
    content: { flex: 1 },
    section: { ...StyleSheet.absoluteFillObject },
    off: { display: 'none' },
    notice: { color: p.muted, textAlign: 'center', padding: 18, fontSize: 14 },

    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
    drawer: {
      position: 'absolute', top: 0, bottom: 0, left: 0, width: 300,
      backgroundColor: p.panel, borderRightWidth: 1, borderRightColor: p.border,
      paddingTop: (Platform.OS === 'android' ? RnStatusBar.currentHeight ?? 0 : 50) + 12,
      paddingHorizontal: 14, paddingBottom: 18, gap: 6,
    },
    drawerHead: { paddingHorizontal: 10, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: p.border, marginBottom: 8 },
    drawerApp: { fontSize: 19, fontWeight: '800', color: p.text },

    loginWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 24, maxWidth: 420, width: '100%', alignSelf: 'center' },
    fieldLabel: { fontSize: 12, color: p.muted, fontWeight: '600', marginBottom: 6 },
    input: {
      backgroundColor: p.panel, color: p.text, borderWidth: 1, borderColor: p.border,
      borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, width: '100%',
    },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8, width: '100%' },
    formError: {
      backgroundColor: `${p.danger}1A`, color: p.danger, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, width: '100%', marginBottom: 8,
    },
    btnPrimary: {
      backgroundColor: p.primary, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 18,
      alignItems: 'center', width: '100%', marginTop: 4,
    },
    btnPrimaryText: { color: p.onPrimary, fontSize: 15, fontWeight: '700' },
    btnSmall: { backgroundColor: p.panel2, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
    btnDanger: {
      borderWidth: 1, borderColor: p.danger, borderRadius: 12, paddingVertical: 11,
      alignItems: 'center', marginTop: 10,
    },

    paneToolbar: {
      flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10,
      backgroundColor: p.panel, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    agentRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14,
      paddingHorizontal: 16, paddingVertical: 15, marginBottom: 10, minHeight: 60,
    },
    agentTitle: { color: p.text, fontSize: 15, fontWeight: '700' },

    sheet: {
      width: '100%',
      backgroundColor: p.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18,
      borderWidth: 1, borderColor: p.border, padding: 16, paddingBottom: 28, gap: 10, maxHeight: '80%',
    },
    // 시트를 바닥에 붙이면서 키보드가 뜨면 겹치는 만큼만 밀어 올리고, 내려가면
    // 원위치로 되돌리는 컨테이너. RN Modal 은 별도 윈도우라 adjustResize 를
    // 못 받는 경우가 있어(안드로이드 실사고: provider/model 선택이 키보드에
    // 밀려 들어감) 겹침 기반 KeyboardAvoidingView 로 결정적으로 처리한다.
    sheetHost: { flex: 1, justifyContent: 'flex-end' },
    sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, alignSelf: 'center' },
    sheetTitle: { fontSize: 16, fontWeight: '800', color: p.text, textAlign: 'center' },
    convRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingVertical: 13, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      backgroundColor: p.panel2, borderRadius: 16, paddingVertical: 8, paddingHorizontal: 14,
      borderWidth: 1, borderColor: p.border,
    },

    msg: { maxWidth: '86%', paddingHorizontal: 14, paddingVertical: 11, borderRadius: 16 },
    msgUser: { alignSelf: 'flex-end', backgroundColor: p.primary, borderBottomRightRadius: 5 },
    msgAssistant: {
      alignSelf: 'flex-start', backgroundColor: p.assistantBubble,
      borderWidth: 1, borderColor: p.border, borderBottomLeftRadius: 5,
    },
    msgTool: { alignSelf: 'flex-start', paddingVertical: 2, paddingHorizontal: 6 },
    msgError: { alignSelf: 'center' },
    composer: { backgroundColor: p.panel, borderTopWidth: 1, borderTopColor: p.border, padding: 8, paddingBottom: 14 },
    composerBox: {
      flexDirection: 'row', alignItems: 'flex-end', gap: 8,
      backgroundColor: p.panel2, borderWidth: 1, borderColor: p.border,
      borderRadius: 22, paddingLeft: 16, paddingRight: 6, paddingVertical: 6,
    },
    composerInput: { flex: 1, color: p.text, fontSize: 15, maxHeight: 132, paddingVertical: 6 },
    sendBtn: {
      width: 38, height: 38, borderRadius: 19, backgroundColor: p.primary,
      alignItems: 'center', justifyContent: 'center',
    },

    card: {
      backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14,
      padding: 16, marginBottom: 12,
    },
    cardTitle: { fontSize: 15, fontWeight: '800', color: p.text, marginBottom: 6 },
    cardSub: { fontSize: 13, color: p.muted, lineHeight: 20, marginTop: 6 },
    groupRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: p.border,
    },
    permTag: {
      fontSize: 10, fontWeight: '700', color: p.primary,
      backgroundColor: `${p.primary}20`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
      overflow: 'hidden',
    },
  });
}
