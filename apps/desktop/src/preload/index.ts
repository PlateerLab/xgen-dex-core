/**
 * Preload — the ONLY bridge between the sandboxed renderer and the native shell.
 *
 * Exposes `window.xgen`: config, auth, agents, history, chat (streamed via a
 * callback), and updater. Tokens and network calls stay in the main process;
 * the renderer only ever sees typed results and streamed ChatEvents.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../main/ipc';
import type {
  ChatEvent,
  ChatRequest,
  CurrentUser,
  TeamsAttachment,
  TeamsEvent,
  TeamsMember,
  TeamsMessage,
  TeamsReaction,
  TeamsRoom,
  TeamsUser,
  AgentListQuery,
  AgentListResult,
  HistoryTurn,
  Conversation,
  VoiceConfig,
  TtsSpeakOptions,
  TraceListResult,
  TraceDetail,
  MemoryListResult,
  MemoryDetail,
  TasksResult,
  JobRunsResult,
  TaskOutput,
  AgentBasicInfo,
  ToolsResult,
  ForgedTool,
  WorkspaceListResult,
  WorkspaceFile,
  WorkspaceBinary,
  WorkspaceBinaryPurpose,
  WorkspaceUploadResult,
  NotificationPreferenceUpdate,
  NotificationProfile,
  NotificationRendererContext,
  NotificationTarget,
  NotificationDeliveryResult,
  NotificationSystemStatus,
  AgentCreateOptions,
  CreateAgentInput,
} from '@dex/protocol';
import type { SshConfig, SshServer, SshServerInput, SshTestResult } from '@dex/protocol/ssh';
import type { AvatarConfig, AvatarDescriptor } from '@dex/protocol/preferences';
import type { StoreAvatar } from '@dex/protocol/avatars';
import type { ConnectorConfig, McpServerConfig } from '../main/config';
import type { SystemMetrics } from '@dex/protocol/system-metrics';
import type {
  BrowserConnectionEvent,
  BrowserCreateRequest,
  BrowserHistoryListRequest,
  BrowserHistoryListResult,
  BrowserHistoryRemoveRequest,
  BrowserHistorySuggestion,
  BrowserHistorySuggestionsRequest,
  BrowserNavigateRequest,
  BrowserPageInfo,
  BrowserPopupResolveRequest,
  BrowserSelectionBeginRequest,
  BrowserSelectionCompleteRequest,
  BrowserSelectionInspectRequest,
  BrowserSelectionPreview,
  BrowserSelectionResult,
  BrowserSelectionSession,
  BrowserState,
} from '@dex/protocol/browser';

/** 로컬 실행 환경 상태(설정 화면) — 메인의 localRuntimeStatus 응답. */
export interface LocalExecStatus {
  enabled: boolean;
  installed: boolean;
  pythonPath: string;
  version?: string;
  sidecarOk?: boolean;
  runtimeDir: string;
  daemon: {
    running: boolean;
    pid?: number;
    protocol?: number;
    runtimeVersion?: string;
    activeTurns: number;
    lastError?: string;
  };
  cli: {
    codex: { installed: boolean; path: string; version?: string };
    claude: { installed: boolean; path: string; version?: string };
  };
  /** 서버가 알려준 목표 버전(없으면 서버 v1/미로그인). */
  server: {
    runtime?: string;
    claude?: string | null;
    codex?: string | null;
    claudeEnabled?: boolean;
    codexEnabled?: boolean;
    /** 서버가 커넥터에 줄 수 있는 CLI 인증(서버 일원화): 'api_key' | 'setup_token' | 'credentials' | null(없음→서버 실행) */
    claudeAuth?: { mode?: string; ready?: boolean; source?: string | null } | null;
    codexAuth?: { mode?: string; ready?: boolean; source?: string | null } | null;
    manifestAt?: number;
  } | null;
  converge: { running: boolean; lastRunAt?: number; lastError?: string; summary?: string };
  /** 부팅 배선 단계 실패(있으면). */
  bootErrors?: string[];
  /** 앱 내장 번들 경로(<resources>/python) — 진단 표시용. */
  bundlePath?: string | null;
  isPackaged?: boolean;
  /** 설치 로그 꼬리(인스톨러 + 앱) — 왜 실패했는지 화면에서 바로 본다. */
  logs?: { path: string; lines: string[] }[];
  /** 런타임 자가치유 사다리 상태 — 지금 어떤 런타임을 쓰는지(active) + 후보별 진단. */
  ensure: {
    phase: 'idle' | 'checking' | 'copying' | 'downloading' | 'ready' | 'failed';
    message?: string;
    lastError?: string;
    lastRunAt?: number;
    active?: { source: 'install' | 'bundle' | 'legacy'; python: string; version?: string };
    candidates: {
      source: 'install' | 'bundle' | 'legacy';
      runtimeDir: string;
      python: string;
      exists: boolean;
      healthy?: boolean;
      version?: string;
      error?: string;
    }[];
  };
}

/** 파일 시스템 상태 (main file-system.FileSystemStatus 미러). */
/** 동기화 사이클 진행률 — check(서버 확인)/scan(폴더 검사)/apply(파일 전송). */
export interface SyncProgressLike {
  phase: 'check' | 'scan' | 'apply';
  done: number;
  total: number;
}

export interface FileSystemStatusLike {
  loggedIn: boolean;
  dataRoot: string;
  cloud: {
    enabled: boolean;
    dir: string;
    /** 서버 소유 키 'user:<id>' — 탐색기가 서버 트리를 읽을 때 쓴다. */
    owner: string | null;
    synced: boolean;
    /** 큐 상태 — 대기열에 서 있으면 'queued' + queuePosition(1-기반). */
    state: 'idle' | 'queued' | 'syncing';
    queuePosition?: number;
    progress?: SyncProgressLike;
    syncing: boolean;
    lastSyncAt?: number;
    lastError?: string;
  };
  agents: {
    enabled: boolean;
    root: string;
    list: Array<{
      workflowId: string;
      label: string;
      folder: string;
      dir: string | null;
      synced: boolean;
      state: 'idle' | 'queued' | 'syncing';
      queuePosition?: number;
      progress?: SyncProgressLike;
      syncing: boolean;
      lastSyncAt?: number;
      lastError?: string;
    }>;
  };
}

/** 인앱 탐색기 — 드라이브 폴더의 직계 자식 하나. */
export interface WorkspaceEntryLike {
  name: string;
  isDir: boolean;
  size: number;
  /** epoch ms. */
  mtime: number;
}

/** Local-MCP bridge status pushed to the settings UI. */
export interface McpBridgeStatusLike {
  enabled: boolean;
  connected: boolean;
  catalogSynced: boolean;
  serverToolCount: number;
  error?: string;
  servers: Array<{
    name: string;
    connected: boolean;
    error?: string;
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  }>;
}

/** 앱 실행 중에만 유지되는 로컬 MCP 카탈로그·도구 호출 로그. */
export interface McpRuntimeLogEntryLike {
  id: number;
  timestamp: number;
  kind: 'catalog' | 'call' | 'result';
  message: string;
  requestId?: string;
  server?: string;
  tool?: string;
  ok?: boolean;
  durationMs?: number;
}

/** Live avatar/chat state pushed from the main window to the floating overlay. */
export interface OverlayState {
  workflowId: string;
  workflowName: string;
  /** Assistant text streamed so far this turn. */
  streamingText: string;
  /** True while a turn is actively streaming. */
  speaking: boolean;
}

let streamSeq = 0;

const api = {
  config: {
    get: (): Promise<ConnectorConfig> => ipcRenderer.invoke(CHANNELS.configGet),
    set: (patch: Partial<ConnectorConfig>): Promise<ConnectorConfig> =>
      ipcRenderer.invoke(CHANNELS.configSet, patch),
    /** 서버 주소 확정 — 스킴이 없으면 main 이 https → http 순으로 두드려 정한다. */
    probeServer: (input: string): Promise<{ url: string } | { error: string }> =>
      ipcRenderer.invoke(CHANNELS.configProbeServer, input),
    onChange: (cb: (c: ConnectorConfig) => void): (() => void) => {
      const h = (_e: unknown, c: ConnectorConfig) => cb(c);
      ipcRenderer.on(CHANNELS.configChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.configChanged, h);
    },
  },

  auth: {
    login: (
      email: string,
      password: string,
      remember?: boolean,
    ): Promise<{
      user: CurrentUser | null;
      tokenPersisted?: boolean;
      credsPersisted?: boolean;
      /** 로그인 거절/실패 사유 — 있으면 user 는 null 이고 화면에 이 문장을 보인다. */
      error?: string;
    }> => ipcRenderer.invoke(CHANNELS.authLogin, email, password, remember),
    ssoLogin: (): Promise<{ user: CurrentUser; tokenPersisted: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authSsoLogin),
    restore: (): Promise<{ user: CurrentUser | null; offline?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authRestore),
    /** 시크릿 저장 백엔드 상태 — persistent=false 면 재시작 시 재로그인 필요. */
    secureStorageStatus: (): Promise<{ backend: string; persistent: boolean }> =>
      ipcRenderer.invoke(CHANNELS.secureStorageStatus),
    /** Launch: sign in with saved credentials when 자동 로그인 is enabled. */
    autoLogin: (): Promise<{ user: CurrentUser | null; offline?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.authAutoLogin),
    /** Login form: remembered email + auto-login checkbox state. */
    loginPrefill: (): Promise<{ autoLogin: boolean; email: string }> =>
      ipcRenderer.invoke(CHANNELS.authLoginPrefill),
    logout: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.authLogout),
    status: (): Promise<{ user: CurrentUser | null }> => ipcRenderer.invoke(CHANNELS.authStatus),
    onAuthFailed: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.authFailed, h);
      return () => ipcRenderer.removeListener(CHANNELS.authFailed, h);
    },
  },

  agents: {
    list: (query?: AgentListQuery): Promise<AgentListResult> =>
      ipcRenderer.invoke(CHANNELS.agentsList, query),
    /** 만들기 화면이 그릴 것 — 서버가 Agent XGeny 노드에서 읽어 내려 준다. */
    createOptions: (): Promise<AgentCreateOptions> =>
      ipcRenderer.invoke(CHANNELS.agentsCreateOptions),
    /** 에이전트 하나를 세운다 — 노드 하나짜리 워크플로우. */
    create: (input: CreateAgentInput): Promise<{ workflowId: string; workflowName: string }> =>
      ipcRenderer.invoke(CHANNELS.agentsCreate, input),
  },

  /**
   * 로컬 실행 환경 — 설치 폴더의 Python 런타임(사이드카) + Claude Code / Codex CLI.
   * 커넥터에서 시작한 Agent-XGeny 턴은 자동으로 이 환경에서 돈다(chatStart). 여기는
   * 상태 표시·설치·서버 버전 수렴([설정 → 일반]).
   */

  user: {
    /** The logged-in user's avatar config (preferences.avatar). Global default. */
    avatarConfig: (): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.userAvatarConfig),
    /** Persist an adjusted avatar config (overlay scale/position). */
    saveAvatarConfig: (cfg: AvatarConfig): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.userSaveAvatarConfig, cfg),
    /** Persist ONE avatar's transform — read-modify-write server-side state
     *  so it can never clobber a selection changed on the web in between. */
    saveAvatarTransform: (
      avatarId: string,
      tf: { scale: number; position: { x: number; y: number } },
    ): Promise<void> => ipcRenderer.invoke(CHANNELS.userSaveAvatarTransform, avatarId, tf),
    /** Overlay: fired when auth becomes ready / config changes → refetch now. */
    onAvatarRefresh: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.avatarRefresh, h);
      return () => ipcRenderer.removeListener(CHANNELS.avatarRefresh, h);
    },
  },

  /** 아바타 설정 뷰 — 에셋 업로드/삭제, config 부분수정(read-modify-write), 스토어. */
  avatars: {
    uploadAsset: (bytes: Uint8Array, filename: string): Promise<AvatarDescriptor> =>
      ipcRenderer.invoke(CHANNELS.avatarUploadAsset, bytes, filename),
    deleteAsset: (avatarId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.avatarDeleteAsset, avatarId),
    setEnabled: (enabled: boolean): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarSetEnabled, enabled),
    select: (id: string): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.avatarSelect, id),
    rename: (id: string, name: string): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarRename, id, name),
    add: (descriptor: AvatarDescriptor, name?: string): Promise<AvatarConfig> =>
      ipcRenderer.invoke(CHANNELS.avatarAdd, descriptor, name),
    remove: (id: string): Promise<AvatarConfig> => ipcRenderer.invoke(CHANNELS.avatarRemove, id),
    storeList: (): Promise<StoreAvatar[]> => ipcRenderer.invoke(CHANNELS.avatarStoreList),
    storePublish: (
      descriptor: AvatarDescriptor,
      name: string,
      description: string,
    ): Promise<StoreAvatar> =>
      ipcRenderer.invoke(CHANNELS.avatarStorePublish, descriptor, name, description),
    storeDownload: (storeId: string): Promise<AvatarDescriptor> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreDownload, storeId),
    storeRate: (storeId: string, stars: number): Promise<StoreAvatar> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreRate, storeId, stars),
    storeUnpublish: (storeId: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.avatarStoreUnpublish, storeId),
  },

  history: {
    turns: (workflowId: string, interactionId: string, name?: string): Promise<HistoryTurn[]> =>
      ipcRenderer.invoke(CHANNELS.historyTurns, workflowId, interactionId, name),
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke(CHANNELS.historyConversations),
  },

  // 에이전트 뷰어 — 읽기 전용 관측 데이터. 전부 GET, 변경 경로 없음.
  agentData: {
    traceList: (wf: string): Promise<TraceListResult> =>
      ipcRenderer.invoke(CHANNELS.agentTraceList, wf),
    traceDetail: (traceId: string): Promise<TraceDetail> =>
      ipcRenderer.invoke(CHANNELS.agentTraceDetail, traceId),
    memoryList: (wf: string): Promise<MemoryListResult> =>
      ipcRenderer.invoke(CHANNELS.agentMemoryList, wf),
    memoryRead: (wf: string, path: string): Promise<MemoryDetail> =>
      ipcRenderer.invoke(CHANNELS.agentMemoryRead, wf, path),
    tasksList: (wf: string): Promise<TasksResult> =>
      ipcRenderer.invoke(CHANNELS.agentTasksList, wf),
    taskRuns: (wf: string, sessionId?: string): Promise<JobRunsResult> =>
      ipcRenderer.invoke(CHANNELS.agentTaskRuns, wf, sessionId),
    taskOutput: (wf: string, runId: string): Promise<TaskOutput> =>
      ipcRenderer.invoke(CHANNELS.agentTaskOutput, wf, runId),
    basicInfo: (wf: string): Promise<AgentBasicInfo> =>
      ipcRenderer.invoke(CHANNELS.agentBasicInfo, wf),
    toolsList: (wf: string): Promise<ToolsResult> =>
      ipcRenderer.invoke(CHANNELS.agentToolsList, wf),
    toolGet: (wf: string, functionId: string): Promise<ForgedTool> =>
      ipcRenderer.invoke(CHANNELS.agentToolGet, wf, functionId),
    workspaceTree: (wf: string, path?: string): Promise<WorkspaceListResult> =>
      ipcRenderer.invoke(CHANNELS.agentWsTree, wf, path),
    workspaceFile: (wf: string, path: string): Promise<WorkspaceFile> =>
      ipcRenderer.invoke(CHANNELS.agentWsFile, wf, path),
    workspaceBinary: (
      wf: string,
      path: string,
      purpose?: WorkspaceBinaryPurpose,
    ): Promise<WorkspaceBinary> => ipcRenderer.invoke(CHANNELS.agentWsBinary, wf, path, purpose),
    workspaceUpload: (
      wf: string,
      bytes: Uint8Array,
      filename: string,
      mimeType: string,
      interactionId: string,
      attachmentId: string,
    ): Promise<WorkspaceUploadResult> =>
      ipcRenderer.invoke(
        CHANNELS.agentWsUpload,
        wf,
        bytes,
        filename,
        mimeType,
        interactionId,
        attachmentId,
      ),
  },

  browser: {
    state: (): Promise<BrowserState> => ipcRenderer.invoke(CHANNELS.browserState),
    create: (request: BrowserCreateRequest): Promise<BrowserPageInfo> =>
      ipcRenderer.invoke(CHANNELS.browserCreate, request),
    ensureShared: (workflowId: string, workflowName?: string): Promise<BrowserPageInfo> =>
      ipcRenderer.invoke(CHANNELS.browserEnsureShared, workflowId, workflowName),
    bindShared: (pageId: string, webContentsId: number): Promise<BrowserPageInfo> =>
      ipcRenderer.invoke(CHANNELS.browserBindShared, pageId, webContentsId),
    navigate: (request: BrowserNavigateRequest): Promise<BrowserPageInfo> =>
      ipcRenderer.invoke(CHANNELS.browserNavigate, request),
    activate: (pageId: string): Promise<BrowserPageInfo> =>
      ipcRenderer.invoke(CHANNELS.browserActivate, pageId),
    beginSelection: (request: BrowserSelectionBeginRequest): Promise<BrowserSelectionSession> =>
      ipcRenderer.invoke(CHANNELS.browserSelectionBegin, request),
    inspectSelection: (
      request: BrowserSelectionInspectRequest,
    ): Promise<BrowserSelectionPreview | null> =>
      ipcRenderer.invoke(CHANNELS.browserSelectionInspect, request),
    completeSelection: (
      request: BrowserSelectionCompleteRequest,
    ): Promise<BrowserSelectionResult> =>
      ipcRenderer.invoke(CHANNELS.browserSelectionComplete, request),
    cancelSelection: (token: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.browserSelectionCancel, token),
    resolvePopup: (request: BrowserPopupResolveRequest): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.browserPopupResolve, request),
    historySuggestions: (
      request: BrowserHistorySuggestionsRequest,
    ): Promise<BrowserHistorySuggestion[]> =>
      ipcRenderer.invoke(CHANNELS.browserHistorySuggestions, request),
    historyList: (request: BrowserHistoryListRequest): Promise<BrowserHistoryListResult> =>
      ipcRenderer.invoke(CHANNELS.browserHistoryList, request),
    historyRemove: (request: BrowserHistoryRemoveRequest): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.browserHistoryRemove, request),
    historyClear: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.browserHistoryClear),
    close: (pageId: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.browserClose, pageId),
    closeWorkflow: (workflowId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.browserCloseWorkflow, workflowId),
    onState: (cb: (state: BrowserState) => void): (() => void) => {
      const handler = (_event: unknown, state: BrowserState) => cb(state);
      ipcRenderer.on(CHANNELS.browserStateEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserStateEvent, handler);
    },
    onConnection: (cb: (event: BrowserConnectionEvent) => void): (() => void) => {
      const handler = (_event: unknown, connection: BrowserConnectionEvent) => cb(connection);
      ipcRenderer.on(CHANNELS.browserConnectionEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserConnectionEvent, handler);
    },
    onReveal: (cb: (page: BrowserPageInfo) => void): (() => void) => {
      const handler = (_event: unknown, page: BrowserPageInfo) => cb(page);
      ipcRenderer.on(CHANNELS.browserRevealEvent, handler);
      return () => ipcRenderer.removeListener(CHANNELS.browserRevealEvent, handler);
    },
  },

  chat: {
    /**
     * Start a streamed chat turn. `onEvent` is called for each ChatEvent;
     * returns a handle with `cancel()`. Resolves the terminal `end`/`error`.
     */
    stream: (req: ChatRequest, onEvent: (e: ChatEvent) => void): { cancel: () => void } => {
      const streamId = `s${Date.now()}_${streamSeq++}`;
      const h = (_e: unknown, id: string, ev: ChatEvent) => {
        if (id !== streamId) return;
        onEvent(ev);
        if (ev.kind === 'end' || ev.kind === 'error') {
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        }
      };
      ipcRenderer.on(CHANNELS.chatEvent, h);
      void ipcRenderer.invoke(CHANNELS.chatStart, streamId, req);
      return {
        cancel: () => {
          void ipcRenderer.invoke(CHANNELS.chatCancel, streamId);
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        },
      };
    },
    /** '진행 중 대화' 삭제 시 서버 세션 RAM 을 완전 정리(evict). best-effort. */
    endSession: (workflowId: string, interactionId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.chatEndSession, workflowId, interactionId),
  },

  /** 클립보드 — main 경유. 렌더러 navigator.clipboard 는 조용히 실패할 수 있다. */
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),
  },

  /**
   * Teams — 사람 사이의 대화.
   *
   * 네트워크와 WebSocket 은 전부 메인 프로세스에 있다. 렌더러는 이 표면만 본다:
   * REST 는 invoke, 실시간은 `onEvent` 구독. 방 탭을 열면 `watch`, 닫으면
   * `unwatch` 를 불러 방 소켓 수명을 알린다.
   */
  teams: {
    rooms: (): Promise<TeamsRoom[]> => ipcRenderer.invoke(CHANNELS.teamsRooms),
    createRoom: (name: string, description?: string): Promise<TeamsRoom> =>
      ipcRenderer.invoke(CHANNELS.teamsCreateRoom, name, description),
    openDm: (userId: number, username?: string): Promise<TeamsRoom> =>
      ipcRenderer.invoke(CHANNELS.teamsOpenDm, userId, username),
    leaveRoom: (roomId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.teamsLeaveRoom, roomId),
    /** teams 로컬 설정 부분 갱신 (config:set 은 teams 를 통째로 덮어쓴다). */
    savePrefs: (patch: {
      lastReadAt?: Record<string, string>;
      mutedRooms?: string[];
    }): Promise<boolean> => ipcRenderer.invoke(CHANNELS.teamsSavePrefs, patch),
    /** 방 이름·설명 수정. 서버는 멤버 전원에게 허용한다. */
    updateRoom: (
      roomId: string,
      patch: { name?: string; description?: string | null },
    ): Promise<TeamsRoom | null> => ipcRenderer.invoke(CHANNELS.teamsUpdateRoom, roomId, patch),
    /** 새 메시지 OS 알림 요청. 보고 있지 않고 음소거도 아닐 때만 렌더러가 부른다. */
    notify: (payload: {
      roomId: string;
      roomName: string;
      sender: string;
      body: string;
    }): Promise<boolean> => ipcRenderer.invoke(CHANNELS.teamsNotify, payload),
    /** 알림 클릭 → 그 방을 열라는 신호. */
    onNotificationClick: (cb: (roomId: string) => void): (() => void) => {
      const h = (_e: unknown, roomId: string) => cb(roomId);
      ipcRenderer.on(CHANNELS.teamsNotificationClick, h);
      return () => ipcRenderer.removeListener(CHANNELS.teamsNotificationClick, h);
    },
    members: (roomId: string): Promise<TeamsMember[]> =>
      ipcRenderer.invoke(CHANNELS.teamsMembers, roomId),
    addMember: (roomId: string, userId: number): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.teamsAddMember, roomId, userId),
    searchUsers: (query: string): Promise<TeamsUser[]> =>
      ipcRenderer.invoke(CHANNELS.teamsSearchUsers, query),
    /** `before` 를 주면 그보다 과거 메시지를 더 불러온다 (위로 스크롤). */
    messages: (roomId: string, before?: string): Promise<TeamsMessage[]> =>
      ipcRenderer.invoke(CHANNELS.teamsMessages, roomId, before),
    send: (
      roomId: string,
      content: string,
      replyToId?: string,
      attachments?: TeamsAttachment[],
    ): Promise<TeamsMessage> =>
      ipcRenderer.invoke(CHANNELS.teamsSend, roomId, content, replyToId, attachments),
    edit: (roomId: string, messageId: string, content: string): Promise<TeamsMessage | null> =>
      ipcRenderer.invoke(CHANNELS.teamsEdit, roomId, messageId, content),
    react: (roomId: string, messageId: string, emoji: string): Promise<TeamsReaction[]> =>
      ipcRenderer.invoke(CHANNELS.teamsReact, roomId, messageId, emoji),
    watch: (roomId: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.teamsWatch, roomId),
    unwatch: (roomId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.teamsUnwatch, roomId),
    typing: (roomId: string, typing: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.teamsTyping, roomId, typing),
    /**
     * 첨부 — 파일 경로는 메인에만 있다. 렌더러는 "고르게 해 달라 / 올려 달라 /
     * 저장하게 해 달라" 만 말할 수 있고 어떤 경로인지는 알지도, 정하지도 못한다.
     */
    pickAndUpload: (roomId: string): Promise<TeamsAttachment[]> =>
      ipcRenderer.invoke(CHANNELS.teamsUploadAttachment, roomId),
    /** 가상 드라이브의 파일(에이전트 산출물)을 그대로 방에 올린다. */
    shareWorkspaceFile: (roomId: string, drivePath: string): Promise<TeamsAttachment> =>
      ipcRenderer.invoke(CHANNELS.teamsShareWorkspaceFile, roomId, drivePath),
    /** 다른 이름으로 저장. 사용자가 취소하면 null. */
    saveAttachment: (roomId: string, attachment: TeamsAttachment): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.teamsSaveAttachment, roomId, attachment),
    /** 임시 폴더에 풀어 OS 기본 앱으로 연다. */
    openAttachment: (roomId: string, attachment: TeamsAttachment): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.teamsOpenAttachment, roomId, attachment),
    /** 원본 바이트 — 그림 미리보기용 (blob URL 로 감싸 쓴다). */
    readAttachment: (roomId: string, attachment: TeamsAttachment): Promise<Uint8Array> =>
      ipcRenderer.invoke(CHANNELS.teamsReadAttachment, roomId, attachment),
    onEvent: (cb: (event: TeamsEvent) => void): (() => void) => {
      const h = (_e: unknown, event: TeamsEvent) => cb(event);
      ipcRenderer.on(CHANNELS.teamsEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.teamsEvent, h);
    },
  },

  /** 계정별 공통 OS 알림. 실제 정책 판정과 표시는 main 한 곳에서 한다. */
  notifications: {
    preferences: (): Promise<NotificationProfile> =>
      ipcRenderer.invoke(CHANNELS.notificationPreferences),
    update: (update: NotificationPreferenceUpdate): Promise<NotificationProfile> =>
      ipcRenderer.invoke(CHANNELS.notificationUpdate, update),
    test: (): Promise<NotificationDeliveryResult> => ipcRenderer.invoke(CHANNELS.notificationTest),
    status: (): Promise<NotificationSystemStatus> =>
      ipcRenderer.invoke(CHANNELS.notificationStatus),
    setContext: (context: NotificationRendererContext): void =>
      ipcRenderer.send(CHANNELS.notificationContext, context),
    consumeTarget: (): Promise<NotificationTarget | null> =>
      ipcRenderer.invoke(CHANNELS.notificationConsumeTarget),
    onNavigate: (cb: (target: NotificationTarget) => void): (() => void) => {
      const h = (_e: unknown, target: NotificationTarget) => cb(target);
      ipcRenderer.on(CHANNELS.notificationNavigate, h);
      return () => ipcRenderer.removeListener(CHANNELS.notificationNavigate, h);
    },
  },

  /** Voice — STT (mic→text) and TTS (text→audio). Audio is captured in the
   *  renderer (getUserMedia) and shuttled to main as bytes; secrets stay in main. */
  voice: {
    /** preferences.stt / preferences.tts (UI hints only — no secrets). */
    getConfig: (): Promise<VoiceConfig> => ipcRenderer.invoke(CHANNELS.voiceConfig),
    /** Send a recorded clip → transcript text. */
    transcribe: async (blob: Blob, language?: string): Promise<string> => {
      const buf = await blob.arrayBuffer();
      return ipcRenderer.invoke(CHANNELS.voiceTranscribe, new Uint8Array(buf), blob.type, language);
    },
    /** Synthesize `text` → a playable audio Blob. */
    speak: async (text: string, opts?: TtsSpeakOptions): Promise<Blob> => {
      const r = (await ipcRenderer.invoke(CHANNELS.voiceSpeak, text, opts)) as {
        bytes: Uint8Array;
        mime: string;
      };
      const buf = r.bytes.buffer.slice(
        r.bytes.byteOffset,
        r.bytes.byteOffset + r.bytes.byteLength,
      ) as ArrayBuffer;
      return new Blob([buf], { type: r.mime || 'audio/wav' });
    },
  },

  /**
   * SSH — the per-user server list, shared with the web mypage screen.
   *
   * Pure pass-through: the server owns validation (name rules, jump graph,
   * credential presence) and its rejection message is what the UI shows. If the
   * connector re-checked anything, the two surfaces would drift apart.
   *
   * Credentials never come back — writes are partial, so an omitted password
   * keeps its stored value and `''` clears it.
   */
  ssh: {
    getConfig: (): Promise<SshConfig> => ipcRenderer.invoke(CHANNELS.sshConfig),
    setEnabled: (enabled: boolean): Promise<SshConfig> =>
      ipcRenderer.invoke(CHANNELS.sshSetEnabled, enabled),
    createServer: (input: SshServerInput): Promise<SshServer> =>
      ipcRenderer.invoke(CHANNELS.sshCreateServer, input),
    updateServer: (name: string, input: SshServerInput): Promise<SshServer> =>
      ipcRenderer.invoke(CHANNELS.sshUpdateServer, name, input),
    deleteServer: (name: string): Promise<SshConfig> =>
      ipcRenderer.invoke(CHANNELS.sshDeleteServer, name),
    /** Dialled by the XGEN server (that is where the agent runs), through the jump path. */
    testServer: (name: string): Promise<SshTestResult> =>
      ipcRenderer.invoke(CHANNELS.sshTestServer, name),
  },

  /** Floating avatar overlay (Geny-style). Used by the main window
   * (setEnabled / pushState) and the overlay window (onState / windowControl). */
  overlay: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.overlayGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.overlaySetEnabled, enabled),
    /** Main window → overlay: push the live avatar/chat state. */
    pushState: (state: OverlayState): void => ipcRenderer.send(CHANNELS.overlayPushState, state),
    /** Overlay window: subscribe to state updates. */
    onState: (cb: (s: OverlayState) => void): (() => void) => {
      const h = (_e: unknown, s: OverlayState) => cb(s);
      ipcRenderer.on(CHANNELS.overlayState, h);
      return () => ipcRenderer.removeListener(CHANNELS.overlayState, h);
    },
    /** Overlay window: toggle native click-through (false over interactive UI). */
    setClickThrough: (ignore: boolean): void =>
      ipcRenderer.send(CHANNELS.overlaySetIgnoreMouse, ignore),
    /** Overlay window: drag the OS window by a pixel delta (DPI-safe in main). */
    moveBy: (dx: number, dy: number): void => ipcRenderer.send(CHANNELS.overlayMoveBy, dx, dy),
    /** Overlay window: resize from an edge/corner (edge = combo of n/s/e/w). */
    resizeBy: (edge: string, dx: number, dy: number): void =>
      ipcRenderer.send(CHANNELS.overlayResizeBy, edge, dx, dy),
    /** Overlay window: drag/resize gesture ENDED → persist bounds immediately. */
    commitBounds: (): void => ipcRenderer.send(CHANNELS.overlayCommitBounds),
    /** Overlay window: raise/focus the main chat window. */
    focusMain: (): void => ipcRenderer.send(CHANNELS.overlayFocusMain),
    /** Overlay window: raise the main window and open its settings modal. */
    openSettings: (): void => ipcRenderer.send(CHANNELS.overlayOpenSettings),
    /** Overlay window: close the floating space. */
    hide: (): void => ipcRenderer.send(CHANNELS.overlayHide),

    // ── 잠금 ──
    //
    // 상태는 **main 이 소유한다.** 아바타 창과 컨트롤 창이 각자 들고 있으면
    // 둘이 어긋나고, 그때 사용자는 "잠겼다는데 잠기지 않은" 상태를 본다.
    /** 첫 렌더용 초기값. */
    getLocked: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.overlayGetLocked),
    /** 잠금 토글 — 아바타 창의 입력과 컨트롤 창의 가시성이 함께 바뀐다. */
    setLocked: (locked: boolean): void => ipcRenderer.send(CHANNELS.overlaySetLocked, locked),
    /** main → 두 창: 잠금이 바뀌었다. */
    onLocked: (h: (locked: boolean) => void): (() => void) => {
      const fn = (_e: unknown, locked: boolean): void => h(!!locked);
      ipcRenderer.on(CHANNELS.overlayLocked, fn);
      return () => ipcRenderer.removeListener(CHANNELS.overlayLocked, fn);
    },
    /** 컨트롤 창: 실제 내용 크기를 알려 창을 맞춘다 (버튼 수가 가변이다). */
    reportChipSize: (w: number, h: number): void =>
      ipcRenderer.send(CHANNELS.overlayChipSize, w, h),
    /** 아바타 창: 컨트롤 창이 바닥을 덮는 높이 — 자막을 그만큼 들어 올린다. */
    onChipInset: (h: (px: number) => void): (() => void) => {
      const fn = (_e: unknown, px: number): void => h(Number(px) || 0);
      ipcRenderer.on(CHANNELS.overlayChipInset, fn);
      return () => ipcRenderer.removeListener(CHANNELS.overlayChipInset, fn);
    },
  },

  /** 화면 캡처 — 채팅을 보낼 때 지금 화면을 함께 보낸다.
   *
   *  기본 꺼짐이고, main 이 설정을 다시 확인한다 — 렌더러가 실수로 불러도
   *  화면이 나가지 않는다. */
  capture: {
    /** 고를 수 있는 화면/창 목록 (설정 화면). */
    listSources: (): Promise<
      { id: string; name: string; displayId: string; kind: 'screen' | 'window' }[]
    > => ipcRenderer.invoke(CHANNELS.captureListSources),
    /** macOS 화면 기록 권한 상태 (다른 OS 는 항상 granted). */
    accessStatus: (): Promise<string> => ipcRenderer.invoke(CHANNELS.captureAccessStatus),
    /** 한 장 찍는다. 실패는 이유를 담아 돌아온다 — 조용히 넘어가지 않는다. */
    screen: (): Promise<{
      ok: boolean;
      dataUrl?: string;
      width?: number;
      height?: number;
      sourceName?: string;
      error?: string;
    }> => ipcRenderer.invoke(CHANNELS.captureScreen),
  },

  /** App/window management (tray-style controls). */
  appctl: {
    /** Main window: fired when the tray/overlay asks to open the settings modal. */
    onOpenSettings: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.openSettingsModal, h);
      return () => ipcRenderer.removeListener(CHANNELS.openSettingsModal, h);
    },
    /** 네이티브 폴더 선택 다이얼로그 — 절대 경로 또는 null(취소). */
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.pickFolder),
    /** 설치 폴더(생략 시) 또는 지정 폴더를 파일 관리자로 연다. */
    openFolder: (path?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.appOpenFolder, path),
    getAutostart: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.autostartGet),
    setAutostart: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.autostartSet, enabled),
    resetPositions: (): void => ipcRenderer.send(CHANNELS.resetPositions),
    resetSettings: (): void => ipcRenderer.send(CHANNELS.resetSettings),
    restart: (): void => ipcRenderer.send(CHANNELS.appRestart),
    quit: (): void => ipcRenderer.send(CHANNELS.appQuit),
  },

  /** 파일 시스템 — XGen 저장소(클라우드/에이전트 워크스페이스)를 로컬 폴더로. */
  /** 같은 계정에 연결된 커넥터 기기 목록 (Local PC MCP 상태 패널). */
  connectorDevices: (): Promise<{
    devices: Array<{
      deviceId: string;
      name: string;
      platform: string;
      lastActivity?: number;
      toolCount: number;
    }>;
    error?: string;
  }> => ipcRenderer.invoke(CHANNELS.connectorDevices),

  /** 대화 소켓 감시 — 서버가 주입한 턴(트리거 반응)의 실시간 수신. */
  chatWatch: {
    start: (workflowId: string, workflowName: string, interactionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.chatWatchStart, workflowId, workflowName, interactionId),
    stop: (interactionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.chatWatchStop, interactionId),
    onTurn: (
      cb: (turn: {
        interactionId: string;
        ioId: number;
        input: string;
        output: string;
        source: string;
        updatedAt: string;
      }) => void,
    ): (() => void) => {
      const h = (_e: unknown, turn: Parameters<typeof cb>[0]) => cb(turn);
      ipcRenderer.on(CHANNELS.chatWatchTurn, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatWatchTurn, h);
    },
  },

  fileSystem: {
    diagText: (): Promise<string> => ipcRenderer.invoke(CHANNELS.diagText),
    /** 진단 로그를 **main 의 clipboard 로** 복사 (렌더러 clipboard 는 막힐 수 있다). */
    diagCopy: (): Promise<{ ok: boolean; chars: number }> => ipcRenderer.invoke(CHANNELS.diagCopy),

    status: (): Promise<FileSystemStatusLike | null> => ipcRenderer.invoke(CHANNELS.fsStatus),
    setCloudSync: (on: boolean): Promise<FileSystemStatusLike | null> =>
      ipcRenderer.invoke(CHANNELS.fsSetCloud, on),
    setAgentSync: (on: boolean): Promise<FileSystemStatusLike | null> =>
      ipcRenderer.invoke(CHANNELS.fsSetAgents, on),
    /** 지금 동기화 — workflowId 없으면 전부 ('user:<id>' 는 클라우드). */
    syncNow: (workflowId?: string): Promise<FileSystemStatusLike | null> =>
      ipcRenderer.invoke(CHANNELS.fsSyncNow, workflowId),
    /** 서버 에이전트 목록을 다시 읽는다. */
    refreshAgents: (): Promise<FileSystemStatusLike | null> =>
      ipcRenderer.invoke(CHANNELS.fsRefreshAgents),
    /** 동기화 폴더의 직계 자식 (로컬 실파일). */
    list: (workflowId: string, rel?: string): Promise<WorkspaceEntryLike[]> =>
      ipcRenderer.invoke(CHANNELS.fsList, workflowId, rel ?? ''),
    /** [미러 재구성] — 로컬 클라우드 폴더를 비우고 저장소에서 새로 내려받는다
     *  (로컬은 통로 — 손실 없음). 탐색기가 권한/사용 중으로 못 지울 때의 정석. */
    cloudReset: (): Promise<FileSystemStatusLike | null> =>
      ipcRenderer.invoke(CHANNELS.fsCloudReset),
    /** 클라우드(파일 저장소) 서버 트리 — 동기화 OFF/미완료의 읽기 전용 관측.
     *  geny 가 아니라 파일 저장소 스냅숏이다. */
    cloudServerTree: (): Promise<
      Array<{ name: string; path: string; is_dir: boolean; size?: number; modified_at?: string }>
    > => ipcRenderer.invoke(CHANNELS.fsCloudServerTree),
    /** 동기화 파일 바이트 읽기 — 파일 뷰어 (로컬 실파일). */
    readFile: (
      workflowId: string,
      rel: string,
    ): Promise<{ ok: boolean; bytes?: Uint8Array; size?: number; mtime?: number; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.fsReadFile, workflowId, rel),
    /** 파일 저장소 원바이트 — 클라우드 동기화 OFF 일 때의 뷰어 경로. */
    cloudReadRaw: (
      path: string,
    ): Promise<{ ok: boolean; bytes?: Uint8Array; size?: number; contentType?: string; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.fsCloudReadRaw, path),
    /** 오피스 문서 서버 렌더 (파일 저장소 filestore-preview) — 페이지 이미지 목록. */
    cloudOfficePreview: (
      path: string,
    ): Promise<{ ok: boolean; itemId?: number; pages?: string[]; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.fsCloudOfficePreview, path),
    cloudOfficePreviewPage: (
      itemId: number,
      page: string,
    ): Promise<{ ok: boolean; bytes?: Uint8Array; contentType?: string; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.fsCloudOfficePreviewPage, itemId, page),
    /** 동기화 폴더 안 경로를 OS 로 연다. */
    openPath: (workflowId: string, rel?: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.fsOpenPath, workflowId, rel ?? ''),
    /** 루트 폴더 열기 — 'cloud' | 'agents' | 'data'. */
    openRoot: (kind: 'cloud' | 'agents' | 'data'): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.fsOpenRoot, kind),
    onStatus: (cb: (s: FileSystemStatusLike) => void): (() => void) => {
      const h = (_e: unknown, s: FileSystemStatusLike) => cb(s);
      ipcRenderer.on(CHANNELS.fsStatusEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.fsStatusEvent, h);
    },
  },

  /** Local MCP — host MCP servers here and bridge their tools to your agents. */
  mcp: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mcpSetEnabled, enabled),
    listServers: (): Promise<McpServerConfig[]> => ipcRenderer.invoke(CHANNELS.mcpListServers),
    saveServers: (servers: McpServerConfig[]): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke(CHANNELS.mcpSaveServers, servers),
    testServer: (
      cfg: McpServerConfig,
    ): Promise<{
      ok: boolean;
      tools?: Array<{ name: string; description?: string }>;
      error?: string;
      /** 런타임 미설치 등 해결 가능한 실패일 때의 조치 안내. */
      hints?: string[];
    }> => ipcRenderer.invoke(CHANNELS.mcpTestServer, cfg),
    /** 테스트 중인 서버가 뱉는 출력 (첫 실행 다운로드 진행 상황 등). */
    onTestProgress: (cb: (p: { name?: string; lines: string[] }) => void): (() => void) => {
      const h = (_e: unknown, p: { name?: string; lines: string[] }) => cb(p);
      ipcRenderer.on(CHANNELS.mcpTestProgressEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpTestProgressEvent, h);
    },
    status: (): Promise<McpBridgeStatusLike> => ipcRenderer.invoke(CHANNELS.mcpStatus),
    /** 서버들에 다시 붙어 상태를 갱신한다 (설정 화면 진입/테스트 성공 후). */
    refresh: (): Promise<McpBridgeStatusLike> => ipcRenderer.invoke(CHANNELS.mcpRefresh),
    runtimeLogs: (): Promise<McpRuntimeLogEntryLike[]> =>
      ipcRenderer.invoke(CHANNELS.mcpRuntimeLogs),
    clearRuntimeLogs: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mcpClearRuntimeLogs),
    onRuntimeLog: (cb: (entry: McpRuntimeLogEntryLike) => void): (() => void) => {
      const h = (_e: unknown, entry: McpRuntimeLogEntryLike) => cb(entry);
      ipcRenderer.on(CHANNELS.mcpRuntimeLogEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpRuntimeLogEvent, h);
    },
    onStatus: (cb: (s: McpBridgeStatusLike) => void): (() => void) => {
      const h = (_e: unknown, s: McpBridgeStatusLike) => cb(s);
      ipcRenderer.on(CHANNELS.mcpStatusEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.mcpStatusEvent, h);
    },
    /** OAuth 2.1: 서버 인가(브라우저 흐름). 성공 시 재연결된다. */
    authorize: (cfg: McpServerConfig): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.mcpAuthorize, cfg),
    oauthStatus: (name: string): Promise<{ authorized: boolean }> =>
      ipcRenderer.invoke(CHANNELS.mcpOauthStatus, name),
    clearOauth: (name: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.mcpClearOauth, name),
    /** 서버 이름 변경 시 키체인 시크릿/OAuth 를 old→new 로 이관(저장 전에 호출). */
    renameSecrets: (oldName: string, newName: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.mcpRenameSecrets, oldName, newName),
  },

  /** Global hotkeys (recorder support). */
  hotkeys: {
    /** Suspend all global shortcuts while a settings field records a new combo. */
    pause: (): void => ipcRenderer.send(CHANNELS.hotkeyPause),
    resume: (): void => ipcRenderer.send(CHANNELS.hotkeyResume),
  },

  /** Quick-chat — the Spotlight-style floating input bar (global hotkey). */
  quickChat: {
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.quickChatGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.quickChatSetEnabled, enabled),
    getHotkey: (): Promise<string> => ipcRenderer.invoke(CHANNELS.quickChatGetHotkey),
    /** Change the quick-chat accelerator; returns false if registration failed. */
    setHotkey: (acc: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.quickChatSetHotkey, acc),
    /** Quick-chat window → send the typed text to the active agent chat. */
    submit: (text: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.quickChatSubmit, text),
    /** Quick-chat window → dismiss the bar. */
    close: (): void => ipcRenderer.send(CHANNELS.quickChatClose),
    /** Quick-chat window: fired each time the bar is summoned. */
    onOpened: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.quickChatOpened, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickChatOpened, h);
    },
    /** Quick-chat window: fired when main dismisses the bar. */
    onDismissed: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on(CHANNELS.quickChatDismissed, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickChatDismissed, h);
    },
    /** Main window: subscribe to quick-chat relays → send into the active chat. */
    onQuickSend: (cb: (text: string) => void): (() => void) => {
      const h = (_e: unknown, text: string) => cb(text);
      ipcRenderer.on(CHANNELS.quickSend, h);
      return () => ipcRenderer.removeListener(CHANNELS.quickSend, h);
    },
  },

  updater: {
    check: (): Promise<{ opened?: boolean }> => ipcRenderer.invoke(CHANNELS.updaterCheck),
    getEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.updaterGetEnabled),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.updaterSetEnabled, enabled),
    onMessage: (cb: (msg: string) => void): (() => void) => {
      const h = (_e: unknown, msg: string) => cb(msg);
      ipcRenderer.on(CHANNELS.updaterMessage, h);
      return () => ipcRenderer.removeListener(CHANNELS.updaterMessage, h);
    },
    /** The running app version (package.json). */
    getVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),
  },

  system: {
    metrics: (): Promise<SystemMetrics> => ipcRenderer.invoke(CHANNELS.systemMetrics),
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
};

export type XgenBridge = typeof api;
contextBridge.exposeInMainWorld('xgen', api);
