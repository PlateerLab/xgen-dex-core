/**
 * XGEN Dex Mobile — React Native(Expo) 크로스플랫폼 (Android/iOS).
 *
 * 좌상단 [☰] → 드로어로 [새 채팅] / [현재 채팅] / [채팅 목록] / [앱] / [설정].
 * 2026-10-09 부터 첫 화면은 "에이전트를 고르고 그 대화를 본다" 가 아니라 **채팅 목록**이다
 * (웹·데스크톱과 같은 ChatGPT 식, src/conversations/). [+ 새 채팅] 은 시작 화면으로 간다.
 * 섹션은 상시 마운트(숨김 전환)라 채팅 WS/스크롤이 이동 중에도 살아 있다. 순수 로직(chat-ws/tool-bridge/
 * mobile-tools)은 WebView 세대와 같은 파일 — 전송로만 RN 네이티브다
 * (fetch/WS 에 CORS 없음, WS 는 Bearer 헤더 인증).
 *
 * 이 파일은 **껍데기**다: 로그인·드로어·설정. 채팅 화면은 `src/chat/`, 채팅 목록과
 * 시작 화면은 `src/conversations/` 에 따로 있다. 한 파일에 두면 말풍선 하나를 고칠 때마다 로그인과
 * 설정까지 다시 읽어야 하고, 실제로 그 무게 때문에 채팅이 오래 방치됐다.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import { conversationKey, type Agent, type Conversation } from '@dex/protocol';
import { type ChatWsState } from './lib/chat-ws';
import { ChatView } from './chat/chat-view';
import { newInitialMessage, type InitialMessage } from './chat/initial-message';
import { ConversationsSection } from './conversations/conversation-list';
import { StartScreen, type StartPreset } from './conversations/start-screen';
import { AppsSection } from './apps/apps-section';
import { PALETTES, PaletteCtx, useP, type Palette } from './theme';
import { MobileToolBridge, type BridgeStatus } from './lib/tool-bridge';
import {
  advertiseMobileTools,
  callMobileTool,
  FOLDER_TOOLS,
  PRESENCE_TOOLS,
  TOOL_GROUPS,
  type PermissionState,
  type ToolGroup,
} from './lib/mobile-tools';
import { USER_PC_TOOL_NAMES, stopAllUserPc } from './lib/user-pc';
import { mobileWorkspaceTransfer } from './lib/workspace-transfer';
import { rnPort } from './lib/rn-port';
import { folderFs, folderStore, setFolderServer, useFolderAccount } from './lib/folder-store';
import { ensureDeviceId, cachedDeviceId, deviceName, devicePlatform } from './lib/device';
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

type Section = 'chat' | 'conversations' | 'start' | 'apps' | 'settings';

/** 앱을 껐다 켠 뒤 되찾을 대화가 적히는 자리. */
const LAST_CHAT_KEY = 'last-chat';

/** 대화를 열 때 함께 넘기는 것. */
interface OpenChatOptions {
  /** 에이전트가 사라진 대화: 기록만 본다. */
  readOnly?: boolean;
  /** 머리에 보일 제목(목록에서 열 때). */
  title?: string;
  /** 시작 화면에서 적은 첫 메시지. 채팅 소켓이 처음 붙을 때 한 번 보낸다. */
  firstMessage?: string;
}

/**
 * 복원한 대화의 자리표시 에이전트.
 *
 * 저장된 값이 아는 것은 workflowId 와 이름뿐이다 — 에이전트 목록을 기다렸다가
 * 대화를 열면, 목록 조회가 느리거나 실패한 동안 진행 중인 실행이 화면에서
 * 사라진다. 대화를 되찾는 데 필요한 것은 그 둘뿐이므로 나머지는 비워 둔다.
 */
const EMPTY_AGENT = {
  id: 0,
  workflowId: '',
  workflowName: '',
  nodeCount: 0,
  isShared: false,
  isDeployed: true,
  isCompleted: true,
  description: '',
  username: '',
  fullName: '',
  createdAt: '',
  updatedAt: '',
} satisfies Agent;

const SECTION_TITLE: Record<Section, string> = {
  chat: '현재 채팅',
  conversations: '채팅 목록',
  start: '새 채팅',
  apps: '앱',
  settings: '설정',
};

export default function App(): React.ReactElement {
  const scheme = useColorScheme();
  const p = PALETTES[scheme === 'light' ? 'light' : 'dark'];

  const [booting, setBooting] = useState(true);
  // 커넥터 기기 id — 부팅 시 확보(모듈 캐시), 브리지/채팅이 동기 조회한다.
  useEffect(() => {
    void ensureDeviceId();
  }, []);
  const [client, setClient] = useState<XgenMobileClient | null>(null);
  // 대화별 폴더 연결은 계정마다 따로 — 로그인한 계정의 장부를 연다.
  useFolderAccount(client ? `${client.session.serverUrl}|${client.session.userId}` : null);
  // 폴더 연결을 서버에도 올린다 — 웹·PC 에서 이 대화를 열어도 이 휴대폰의 폴더가 보이고 쓰인다.
  useEffect(() => {
    setFolderServer(client ? client.api.conversationFolders : null);
  }, [client]);
  const [section, setSection] = useState<Section>('conversations');
  const [drawer, setDrawer] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ state: 'off', toolCount: 0 });
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [toolGroups, setToolGroups] = useState<Record<ToolGroup, boolean>>({
    notify: true, clipboard: true, device: true,
    camera: true, location: false, actions: true,
  });
  const [permStates, setPermStates] = useState<Partial<Record<ToolGroup, PermissionState>>>({});
  const groupsRef = useRef(toolGroups);
  groupsRef.current = toolGroups;
  const bridgeRef = useRef<MobileToolBridge | null>(null);

  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  // 복원은 비동기라 setState 를 기다린다 — 그 사이 사용자가 대화를 열었는지
  // 알려면 렌더와 무관한 현재값이 필요하다.
  const activeAgentRef = useRef<Agent | null>(null);
  const [activeInteraction, setActiveInteraction] = useState('');
  /** 지금 대화의 에이전트가 사라졌다: 기록만 본다. */
  const [activeReadOnly, setActiveReadOnly] = useState(false);
  const [activeTitle, setActiveTitle] = useState('');
  /** 시작 화면에서 넘어온 첫 메시지. 채팅 화면이 꺼내 가면 비운다. */
  const [initialMessage, setInitialMessage] = useState<InitialMessage | null>(null);
  /** 시작 화면을 여는 표식(열 때마다 처음으로, 또는 넘겨받은 에이전트를 골라 둔다). */
  const [startPreset, setStartPreset] = useState<StartPreset>({ seq: 0 });
  const [chatWsState, setChatWsState] = useState<ChatWsState>('closed');

  const handleLogout = useCallback(async () => {
    bridgeRef.current?.stop();
    await clearSession();
    await saveCredentials(null);
    // 계정을 나가면 되찾을 대화도 없다 — 다음 사람이 남의 대화로 들어가지 않는다.
    await AsyncStorage.removeItem(LAST_CHAT_KEY).catch(() => undefined);
    setClient(null);
    setActiveAgent(null);
    activeAgentRef.current = null;
    setActiveInteraction('');
    setActiveReadOnly(false);
    setActiveTitle('');
    setInitialMessage(null);
    setSection('conversations');
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
        // 알려진 그룹만 받는다 — 옛 저장값의 'files'(이제 대화별 [폴더 연결])는 버린다.
        const saved = JSON.parse(v) as Record<string, unknown>;
        const merged = { ...groupsRef.current };
        for (const g of TOOL_GROUPS) {
          if (typeof saved[g.id] === 'boolean') merged[g.id] = saved[g.id] as boolean;
        }
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
    const bridge = new MobileToolBridge({
      wsBase: wsBaseOf(client.session.serverUrl),
      userId: client.session.userId,
      deviceId: cachedDeviceId() || undefined,
      deviceName: deviceName(),
      devicePlatform: devicePlatform(),
      catalog: () => advertiseMobileTools(groupsRef.current),
      // 파일 도구는 그 대화에 연결된 폴더 안에서만 — 호출마다 장부에서 찾는다.
      call: async (tool, args, context, signal) => {
        const folders = await folderStore.listReady(context.interactionId);
        // 다른 화면에서 보낸 턴이 이 휴대폰의 폴더를 쓴다 — 시트가 "다른 기기에서 온 요청" 을 보여 준다.
        if (
          context.remote &&
          context.interactionId &&
          ((FOLDER_TOOLS.has(tool) && !PRESENCE_TOOLS.has(tool)) || USER_PC_TOOL_NAMES.has(tool)) &&
          folders.length
        ) {
          folderStore.remoteUsed({
            interactionId: context.interactionId,
            toolName: tool,
            originName: context.originName || '다른 기기',
            at: Date.now(),
          });
        }
        return callMobileTool(rnPort, tool, args, groupsRef.current, {
          folders,
          fs: folderFs,
          interactionId: context.interactionId,
          signal,
          ...(context.remote ? { remoteFrom: context.originName ?? '' } : {}),
          // 복사 도구의 길 — 서버가 보증한 이 호출의 에이전트·대화로 묶는다.
          ...(context.workflowId && context.interactionId
            ? { workspace: mobileWorkspaceTransfer(client, context.workflowId, context.interactionId) }
            : {}),
        });
      },
      onStatus: setBridgeStatus,
      wsFactory: client.wsFactory,
      log: diagLog,
    });
    bridge.start();
    bridgeRef.current = bridge;
    return () => {
      bridge.stop();
      // 로그아웃·도구 끔 — 이 폰에서 돌던 사용자 PC 접속 명령도 멈춘다.
      stopAllUserPc();
    };
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

  const openChat = useCallback((agent: Agent, interactionId?: string, opts: OpenChatOptions = {}) => {
    const iid = interactionId ?? newInteractionId(agent.workflowId);
    setActiveAgent(agent);
    activeAgentRef.current = agent;
    setActiveInteraction(iid);
    setActiveReadOnly(!!opts.readOnly);
    setActiveTitle(opts.title ?? '');
    setInitialMessage(opts.firstMessage ? newInitialMessage(agent.workflowId, iid, opts.firstMessage) : null);
    setSection('chat');
    setDrawer(false);
    // 앱을 껐다 켰을 때 되찾을 자리. 되찾는 데 필요한 것은 에이전트·대화 id 뿐이다(기록만 보는 대화인지, 제목은 덤).
    void AsyncStorage.setItem(
      LAST_CHAT_KEY,
      JSON.stringify({
        workflowId: agent.workflowId,
        workflowName: agent.workflowName,
        interactionId: iid,
        ...(opts.readOnly ? { readOnly: true } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      }),
    );
  }, []);

  /** 목록의 대화 한 줄을 연다. 목록이 아는 것은 에이전트 id·이름뿐이라 나머지는 비운 자리표시로 연다. */
  const openConversation = useCallback(
    (c: Conversation) => {
      const agent = { ...EMPTY_AGENT, workflowId: c.workflowId, workflowName: c.workflowName || c.workflowId } as Agent;
      openChat(agent, c.interactionId, { readOnly: c.agentDeleted, title: c.title });
    },
    [openChat],
  );

  /** 시작 화면으로. 에이전트를 주면 그것을 골라 둔다. */
  const startNew = useCallback((agent?: Agent) => {
    setStartPreset((prev) => ({ seq: prev.seq + 1, agent: agent ?? null }));
    setSection('start');
    setDrawer(false);
  }, []);

  /** 열려 있던 대화가 사라졌다(지웠다): 채팅 화면을 비우고 되찾을 자리도 지운다. */
  const clearChat = useCallback(() => {
    setActiveAgent(null);
    activeAgentRef.current = null;
    setActiveInteraction('');
    setActiveReadOnly(false);
    setActiveTitle('');
    setInitialMessage(null);
    void AsyncStorage.removeItem(LAST_CHAT_KEY).catch(() => undefined);
  }, []);

  const activeKey = activeAgent ? conversationKey({ workflowId: activeAgent.workflowId, interactionId: activeInteraction }) : '';
  const isActive = useCallback(
    (c: Conversation) => !!activeAgent && c.workflowId === activeAgent.workflowId && c.interactionId === activeInteraction,
    [activeAgent, activeInteraction],
  );

  /**
   * 앱을 내렸다 다시 켜면 마지막 대화로 돌아온다.
   *
   * 서버 실행은 연결이 아니라 **대화**에 매여 있다 — 앱을 내린 사이에도 턴은
   * 계속 돈다. 그 대화를 열지 않으면 진행 중인 실행이 화면에 없는 것과 같고,
   * [중지]도 없다. 열기만 하면 대화 소켓의 `subscribed.running` 이 진행 상태를
   * 다시 실어 온다 — 여기서 따로 물어볼 것이 없다.
   */
  useEffect(() => {
    if (!client || activeAgentRef.current) return;
    let cancelled = false;
    void AsyncStorage.getItem(LAST_CHAT_KEY).then((raw) => {
      // 그 사이 사용자가 직접 대화를 열었으면 그쪽이 이긴다.
      if (cancelled || !raw || activeAgentRef.current) return;
      try {
        const saved = JSON.parse(raw) as {
          workflowId?: string;
          workflowName?: string;
          interactionId?: string;
          readOnly?: boolean;
          title?: string;
        };
        if (!saved.workflowId || !saved.interactionId) return;
        const agent = {
          ...EMPTY_AGENT,
          workflowId: saved.workflowId,
          workflowName: saved.workflowName || saved.workflowId,
        } as Agent;
        activeAgentRef.current = agent;
        setActiveAgent(agent);
        setActiveInteraction(saved.interactionId);
        setActiveReadOnly(saved.readOnly === true);
        setActiveTitle(typeof saved.title === 'string' ? saved.title : '');
        setSection('chat');
      } catch {
        /* 저장값이 깨졌다 — 목록에서 시작하면 된다 */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

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
            <ChatView
              client={client}
              agent={activeAgent}
              interactionId={activeInteraction}
              title={activeTitle}
              readOnly={activeReadOnly}
              initialMessage={initialMessage}
              onInitialMessageSent={(id) => setInitialMessage((cur) => (cur?.id === id ? null : cur))}
              onWsState={setChatWsState}
              onNewChat={startNew}
              onOpenList={() => go('conversations')}
            />
          </View>
          <View style={[st.section, section !== 'conversations' && st.off]}>
            <ConversationsSection
              client={client}
              visible={section === 'conversations'}
              activeKey={activeKey}
              onOpen={openConversation}
              // [+ 새 채팅] 은 처음 그대로, 에이전트 줄의 [+] 는 그 에이전트를 골라 둔 시작 화면.
              onNewChat={startNew}
              onRemoved={(c) => {
                if (isActive(c)) clearChat();
              }}
              onRenamed={(c, title) => {
                if (isActive(c)) setActiveTitle(title);
              }}
              onPurged={() => {
                // 기록만 보던 대화(에이전트가 사라진 대화)는 방금 함께 지워졌다.
                if (activeReadOnly) clearChat();
              }}
            />
          </View>
          <View style={[st.section, section !== 'start' && st.off]}>
            <StartScreen
              client={client}
              visible={section === 'start'}
              preset={startPreset}
              onStart={(agent, text) => openChat(agent, undefined, { firstMessage: text })}
            />
          </View>
          <View style={[st.section, section !== 'apps' && st.off]}>
            <AppsSection client={client} visible={section === 'apps'} />
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
            <DrawerItem label="새 채팅" active={section === 'start'} onPress={() => startNew()} />
            <DrawerItem
              label="현재 채팅"
              hint={activeAgent ? activeAgent.workflowName || activeAgent.workflowId : '대화 없음'}
              active={section === 'chat'}
              onPress={() => go('chat')}
            />
            <DrawerItem label="채팅 목록" active={section === 'conversations'} onPress={() => go('conversations')} />
            <DrawerItem
              label="앱"
              hint="내가 만든 앱과 앱 스토어"
              active={section === 'apps'}
              onPress={() => go('apps')}
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
          그룹을 켜면 필요한 시스템 권한 승인을 먼저 요청하고, 꺼진 그룹의 도구는 에이전트에게
          보이지 않습니다.
        </Text>
        <Text style={st.cardSub}>
          파일은 대화마다 채팅 위 [폴더 연결]로 고른 폴더 안에서만 에이전트가 다룹니다.
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
    btnDanger: {
      borderWidth: 1, borderColor: p.danger, borderRadius: 12, paddingVertical: 11,
      alignItems: 'center', marginTop: 10,
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
