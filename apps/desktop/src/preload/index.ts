/**
 * Preload — the ONLY bridge between the sandboxed renderer and the native shell.
 *
 * Exposes `window.xgen`: config, auth, agents, history, chat (streamed via a
 * callback), and updater. Tokens and network calls stay in the main process;
 * the renderer only ever sees typed results and streamed ChatEvents.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../main/ipc';
import type { ChatDownload } from '@dex/protocol/chat-files';
import type {
  ChatEvent,
  ChatRequest,
  AppApiDeclaration,
  AppDetail,
  AppListResult,
  AppServingState,
  AppShareState,
  ChatShareInput,
  ChatShareLink,
  ChatShareState,
  ShareAudience,
  AppStoreListParams,
  AppStoreListResult,
  MyAppsResult,
  ChatStopResult,
  ConversationSnapshot,
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
  HistoryFlowItem,
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
  WorkspaceDocPreview,
  WorkspaceUploadResult,
  NotificationPreferenceUpdate,
  NotificationProfile,
  NotificationRendererContext,
  NotificationTarget,
  NotificationDeliveryResult,
  NotificationSystemStatus,
  AgentCreateOptions,
  CreateAgentInput,
  IdeFailure,
} from '@dex/protocol';
import type { ChatFeedback } from '@dex/protocol/feedback';
import type { ConversationModelState } from '@dex/protocol/conversation-model';
import type { ContentFilterResult } from '@dex/protocol/chat-guardrails';
import type { SshConfig, SshServer, SshServerInput, SshTestResult } from '@dex/protocol/ssh';
import type { AvatarConfig, AvatarDescriptor } from '@dex/protocol/preferences';
import type { StoreAvatar } from '@dex/protocol/avatars';
import type { ConnectorConfig, McpServerConfig } from '../main/config';
import type { ChatFolderRemote, ChatFolderView } from '../main/chat-folders';
import type { RemoteFolderUse } from '@dex/engine/local-tools';
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

/** 인앱 탐색기 — 파일 저장소 폴더의 직계 자식 하나. */
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
    /** 만들기 화면이 그릴 것 — 서버가 Agent Geny 노드에서 읽어 내려 준다. */
    createOptions: (): Promise<AgentCreateOptions> =>
      ipcRenderer.invoke(CHANNELS.agentsCreateOptions),
    /** 에이전트 하나를 세운다 — 노드 하나짜리 워크플로우. */
    create: (input: CreateAgentInput): Promise<{ workflowId: string; workflowName: string }> =>
      ipcRenderer.invoke(CHANNELS.agentsCreate, input),
  },

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
    /** 지난 턴 + **지금 도는 턴이 있는가** — 기기를 옮겨 들어온 창의 복원용. */
    snapshot: (
      workflowId: string,
      interactionId: string,
      name?: string,
    ): Promise<ConversationSnapshot> =>
      ipcRenderer.invoke(CHANNELS.historySnapshot, workflowId, interactionId, name),
    conversations: (): Promise<Conversation[]> => ipcRenderer.invoke(CHANNELS.historyConversations),
  },

  /** 채팅 공유: 대화를 그 시점까지 얼린 링크. 링크에는 절대 주소(`url`)가 붙어 온다. */
  chatShares: {
    state: (
      workflowId: string, interactionId: string,
    ): Promise<Omit<ChatShareState, 'share' | 'previous'> & {
      share: (ChatShareLink & { url: string }) | null;
      previous: Array<ChatShareLink & { url: string }>;
    }> => ipcRenderer.invoke(CHANNELS.chatShareState, workflowId, interactionId),
    create: (input: ChatShareInput): Promise<{ share: ChatShareLink & { url: string }; reused: boolean }> =>
      ipcRenderer.invoke(CHANNELS.chatShareCreate, input),
    revoke: (token: string): Promise<void> => ipcRenderer.invoke(CHANNELS.chatShareRevoke, token),
  },

  /** 채팅 안전 장치 — 면책 문구 설정과 민감정보 검사. 판정은 서버가 한다(웹과 같은 자리). */
  guardrails: {
    disclaimerEnabled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.guardDisclaimer),
    checkContent: (text: string): Promise<ContentFilterResult> =>
      ipcRenderer.invoke(CHANNELS.guardCheckContent, text),
  },

  /** 답변 평가 — 별점·문제 유형. 웹 채팅과 같은 서버 계약(execution_io 한 건에 하나). */
  feedback: {
    submit: (input: {
      executionIoId: number;
      starRating: number;
      issueType: string;
      comment?: string;
    }): Promise<ChatFeedback> => ipcRenderer.invoke(CHANNELS.feedbackSubmit, input),
    update: (
      id: number,
      input: { starRating?: number; issueType?: string; comment?: string },
    ): Promise<ChatFeedback> => ipcRenderer.invoke(CHANNELS.feedbackUpdate, id, input),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(CHANNELS.feedbackDelete, id),
    mine: (executionIoIds: number[]): Promise<ChatFeedback[]> =>
      ipcRenderer.invoke(CHANNELS.feedbackMine, executionIoIds),
  },

  // 에이전트 뷰어 — 읽기 전용 관측 데이터. 전부 GET, 변경 경로 없음.
  agentData: {
    traceList: (wf: string, page?: number, pageSize?: number): Promise<TraceListResult> =>
      ipcRenderer.invoke(CHANNELS.agentTraceList, wf, page, pageSize),
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
    /** 대화의 모델 — 지금 모델(맨 앞)·고를 수 있는 것·잠금 여부. */
    conversationModel: (iid: string, wf: string): Promise<ConversationModelState> =>
      ipcRenderer.invoke(CHANNELS.conversationModelGet, iid, wf),
    /** 이 대화의 모델을 바꾼다 — 다음 답변부터. */
    setConversationModel: (
      iid: string,
      wf: string,
      choice: { provider: string; model: string },
    ): Promise<ConversationModelState> => ipcRenderer.invoke(CHANNELS.conversationModelSet, iid, wf, choice),
    /** 에이전트의 모델로 되돌린다. */
    resetConversationModel: (iid: string, wf: string): Promise<ConversationModelState> =>
      ipcRenderer.invoke(CHANNELS.conversationModelReset, iid, wf),
    /** 이 대화의 생각(추론) 값을 바꾼다 — 다음 답변부터. */
    setConversationThinking: (iid: string, wf: string, thinking: string): Promise<ConversationModelState> =>
      ipcRenderer.invoke(CHANNELS.conversationThinkingSet, iid, wf, thinking),
    /** 에이전트의 생각 값으로 되돌린다. */
    resetConversationThinking: (iid: string, wf: string): Promise<ConversationModelState> =>
      ipcRenderer.invoke(CHANNELS.conversationThinkingReset, iid, wf),
    /** 다른 화면이 이 대화의 모델을 바꿨다. */
    onConversationModelChanged: (
      cb: (interactionId: string, notice: Record<string, unknown>) => void,
    ): (() => void) => {
      const h = (_e: unknown, interactionId: string, notice: Record<string, unknown>) => cb(interactionId, notice);
      ipcRenderer.on(CHANNELS.conversationModelChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.conversationModelChanged, h);
    },
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
    /** 문서(docx·pptx·xlsx·hwp)의 서버 렌더 페이지 목록 — [파일 저장소] 와 같은 렌더러. */
    workspaceDocPreview: (wf: string, path: string): Promise<WorkspaceDocPreview> =>
      ipcRenderer.invoke(CHANNELS.agentWsDocPreview, wf, path),
    /** 렌더된 페이지 한 장(`workspaceDocPreview` 가 준 경로 그대로). */
    workspacePreviewPage: (wf: string, page: string): Promise<WorkspaceBinary> =>
      ipcRenderer.invoke(CHANNELS.agentWsPreviewPage, wf, page),
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

  /**
   * 채팅의 [IDE] 보기. `call` 은 @dex/protocol 의 IdeApi 메서드를 main 이 대신 부른다 —
   * 실패는 던지지 않고 `{ok:false, …}` 로 온다(저장 충돌의 상세가 살아 있게).
   * 터미널 소켓은 main 이 열고, 프레임은 `onTerminalEvent` 로 밀려온다.
   */
  ide: {
    call: (
      method: string,
      workflowId: string,
      ...args: unknown[]
    ): Promise<{ ok: true; value: unknown } | ({ ok: false } & IdeFailure)> =>
      ipcRenderer.invoke(CHANNELS.ideCall, method, workflowId, ...args),
    download: (workflowId: string, path: string): Promise<string | null> =>
      ipcRenderer.invoke(CHANNELS.ideDownload, workflowId, path),
    terminalOpen: (
      socket: string,
      workflowId: string,
      termId: string,
      opts: { rows: number; cols: number; cwd?: string },
    ): Promise<boolean> => ipcRenderer.invoke(CHANNELS.ideTermOpen, socket, workflowId, termId, opts),
    terminalSend: (socket: string, frame: unknown): void => ipcRenderer.send(CHANNELS.ideTermSend, socket, frame),
    terminalClose: (socket: string): void => ipcRenderer.send(CHANNELS.ideTermClose, socket),
    onTerminalEvent: (
      cb: (
        event:
          | { socket: string; type: 'frame'; frame: Record<string, unknown> }
          | { socket: string; type: 'close'; code: number; reason: string },
      ) => void,
    ): (() => void) => {
      const h = (_e: unknown, event: Parameters<typeof cb>[0]) => cb(event);
      ipcRenderer.on(CHANNELS.ideTermEvent, h);
      return () => ipcRenderer.removeListener(CHANNELS.ideTermEvent, h);
    },
    /** 스토리지 변경 알림 — main 이 workspace 소켓을 열고 바뀔 때마다 `onChanged(key)` 를 부른다. */
    watch: (key: string, workflowId: string): void => ipcRenderer.send(CHANNELS.ideWatch, key, workflowId),
    unwatch: (key: string): void => ipcRenderer.send(CHANNELS.ideUnwatch, key),
    onChanged: (cb: (key: string) => void): (() => void) => {
      const h = (_e: unknown, key: string) => cb(key);
      ipcRenderer.on(CHANNELS.ideChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.ideChanged, h);
    },
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

  /** 답에 딸린 파일(파일 저장소의 결과물·API 응답 임시 파일). `preview` 는 그림을 화면에 그릴 때. */
  chatFiles: {
    download: (item: ChatDownload, opts?: { preview?: boolean }): Promise<WorkspaceBinary> =>
      ipcRenderer.invoke(CHANNELS.chatFileDownload, item, opts),
  },

  chat: {
    /**
     * Start a streamed chat turn. `onEvent` is called for each ChatEvent;
     * returns a handle with `cancel()`. Resolves the terminal `end`/`error`.
     */
    stream: (
      req: ChatRequest,
      onEvent: (e: ChatEvent) => void,
    ): { cancel: () => void; stop: (interactionId: string) => Promise<ChatStopResult> } => {
      const streamId = `s${Date.now()}_${streamSeq++}`;
      const h = (_e: unknown, id: string, ev: ChatEvent) => {
        if (id !== streamId) return;
        onEvent(ev);
        // 분리(detached)도 이 스트림의 마지막 사건이다 — 그 턴의 나머지는 대화 소켓으로 온다.
        if (ev.kind === 'end' || ev.kind === 'error' || ev.kind === 'detached') {
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        }
      };
      ipcRenderer.on(CHANNELS.chatEvent, h);
      void ipcRenderer.invoke(CHANNELS.chatStart, streamId, req);
      return {
        /** 이 스트림을 그만 본다 — **서버 실행은 계속된다**. */
        cancel: () => {
          void ipcRenderer.invoke(CHANNELS.chatCancel, streamId);
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
        },
        /** 사람이 누른 [정지] — 스트림을 놓고 서버 실행도 멈춘다. */
        stop: (interactionId: string): Promise<ChatStopResult> => {
          ipcRenderer.removeListener(CHANNELS.chatEvent, h);
          return ipcRenderer.invoke(CHANNELS.chatStop, interactionId, streamId);
        },
      };
    },
    /**
     * 스트림을 쥐고 있지 않은 대화도 멈춘다 — 다른 기기(웹·CLI·VSCode)에서
     * 시작해 이 창에서는 [진행 중] 으로만 보이던 턴.
     */
    stop: (interactionId: string): Promise<ChatStopResult> =>
      ipcRenderer.invoke(CHANNELS.chatStop, interactionId),
    /** '진행 중 대화' 삭제 시 서버 세션 RAM 을 완전 정리(evict). best-effort. */
    endSession: (workflowId: string, interactionId: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.chatEndSession, workflowId, interactionId),
  },

  /**
   * 대화별 폴더 연결 — 그 대화에서 에이전트가 이 PC 의 파일과 터미널을 쓸 수 있는
   * 범위. 폴더는 네이티브 선택 창으로만 더해진다(경로 문자열을 받지 않는다).
   */
  chatFolders: {
    list: (interactionId: string): Promise<ChatFolderView[]> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersList, interactionId),
    /** 선택 창을 열어 고른 폴더를 더한다. 취소하면 목록이 그대로 돌아온다. */
    add: (interactionId: string): Promise<ChatFolderView[]> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersAdd, interactionId),
    remove: (interactionId: string, folderId: string): Promise<ChatFolderView[]> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersRemove, interactionId, folderId),
    /** 폴더를 파일 관리자로 연다. */
    reveal: (interactionId: string, folderId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersReveal, interactionId, folderId),
    onChanged: (cb: (interactionId: string, folders: ChatFolderView[]) => void): (() => void) => {
      const h = (_e: unknown, interactionId: string, folders: ChatFolderView[]) =>
        cb(interactionId, folders);
      ipcRenderer.on(CHANNELS.chatFoldersChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatFoldersChanged, h);
    },
    /** 이 대화의 서버 사본 — 다른 기기에 있는 폴더·켜짐 여부, 이 PC 의 기기 id, 최근 원격 조작. */
    remote: (interactionId: string): Promise<ChatFolderRemote> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersRemote, interactionId),
    /** 선택 창을 열어 고른 폴더로 이 대화의 폴더를 옮겨 온다(다른 기기의 연결은 해제된다). */
    moveHere: (interactionId: string): Promise<ChatFolderView[]> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersMoveHere, interactionId),
    onRemoteChanged: (cb: (interactionId: string) => void): (() => void) => {
      const h = (_e: unknown, interactionId: string) => cb(interactionId);
      ipcRenderer.on(CHANNELS.chatFoldersRemoteChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatFoldersRemoteChanged, h);
    },
    onRemoteUse: (cb: (use: RemoteFolderUse) => void): (() => void) => {
      const h = (_e: unknown, use: RemoteFolderUse) => cb(use);
      ipcRenderer.on(CHANNELS.chatFoldersRemoteUse, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatFoldersRemoteUse, h);
    },
    /** IDE [연결된 폴더] — 폴더 안 파일 작업(list·read·save·stat·raw·fs·reveal). 실패는 봉투로 온다. */
    fs: (
      interactionId: string,
      rootId: string,
      op: string,
      args: Record<string, unknown>,
    ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string; detail: Record<string, unknown> }> =>
      ipcRenderer.invoke(CHANNELS.chatFoldersFs, interactionId, rootId, op, args),
    /** 에이전트의 폴더 도구가 폴더를 바꿨다(인자는 대화 id). */
    onTouched: (cb: (interactionId: string) => void): (() => void) => {
      const h = (_e: unknown, interactionId: string) => cb(interactionId);
      ipcRenderer.on(CHANNELS.chatFoldersTouched, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatFoldersTouched, h);
    },
  },

  /** 클립보드 — main 경유. 렌더러 navigator.clipboard 는 조용히 실패할 수 있다. */
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),
    /** 글만 읽는다(그림·파일은 빈 글). */
    read: (): Promise<string> => ipcRenderer.invoke(CHANNELS.clipboardRead),
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
    /** 파일 저장소의 파일을 그대로 방에 올린다 (drivePath = 저장소 상대 경로 `/폴더/파일`). */
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

  /** 같은 계정에 연결된 커넥터 기기 목록 (설정 > 일반 > 연결된 기기). */
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

  /**
   * 앱 — 에이전트가 만든 화면.
   *
   * 읽기만 한다. 만드는 것은 에이전트고(workspace 의 약속된 폴더), 파일을 손보는
   * 자리는 스토리지다. `callApi` 는 격리 프레임이 부탁한 alias 를 **사용자
   * 권한으로** 대신 호출하는 통로다 — 프레임 자신에게는 네트워크가 없다.
   */
  apps: {
    list: (workflowId: string): Promise<AppListResult> =>
      ipcRenderer.invoke(CHANNELS.appList, workflowId),
    get: (workflowId: string, slug: string): Promise<AppDetail> =>
      ipcRenderer.invoke(CHANNELS.appGet, workflowId, slug),
    /** [앱] 탭의 [내 앱] — 내 에이전트 전부가 만든 앱(서버가 모아 준다). */
    mine: (): Promise<MyAppsResult> => ipcRenderer.invoke(CHANNELS.appStoreMine),
    /** [앱] 탭의 [앱 스토어] — 공개 링크로 공유된 앱. */
    store: (params: AppStoreListParams): Promise<AppStoreListResult> =>
      ipcRenderer.invoke(CHANNELS.appStoreList, params),
    callApi: (
      apis: AppApiDeclaration[],
      alias: string,
      params?: Record<string, string | number | boolean | undefined> | null,
    ): Promise<unknown> => ipcRenderer.invoke(CHANNELS.appCallApi, apis, alias, params ?? null),
    /** 프레임의 fetch 를 대신 부른다 — 앱 주소 아래와 /api/ 만. */
    http: (
      workflowId: string, slug: string,
      req: { url: string; method: string; headers: Record<string, string>; body: string | null },
    ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string | null; bodyB64?: string }> =>
      ipcRenderer.invoke(CHANNELS.appHttp, workflowId, slug, req),
    setServing: (workflowId: string, slug: string, serving: boolean): Promise<AppServingState> =>
      ipcRenderer.invoke(CHANNELS.appSetServing, workflowId, slug, serving),
    /**
     * 공유를 켜고 끄거나 공개 범위를 바꾼다. 이미 공유 중이면 같은 링크를 두고 범위만 바꾼다.
     * 절대 주소(`url`)까지 붙여 돌아온다(렌더러는 서버 주소를 모른다).
     */
    setShare: (
      workflowId: string, slug: string, shared: boolean,
      opts?: { audience?: ShareAudience; rotate?: boolean },
    ): Promise<AppShareState & { url: string }> =>
      ipcRenderer.invoke(CHANNELS.appSetShare, workflowId, slug, shared, opts ?? {}),
    /** 지금의 공유 상태와 링크(주인만). 공유 창을 다시 열 때 같은 링크를 보여 준다. */
    getShare: (workflowId: string, slug: string): Promise<AppShareState & { url: string }> =>
      ipcRenderer.invoke(CHANNELS.appGetShare, workflowId, slug),
    remove: (workflowId: string, slug: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.appDelete, workflowId, slug),
    /** 웹의 같은 화면을 기본 브라우저로 연다. 만들어진 주소를 돌려준다. */
    openWeb: (workflowId: string, slug: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.appOpenWeb, workflowId, slug),
    /** 공개 링크(서버가 준 경로)를 기본 브라우저로 연다 — 절대 주소는 main 이 붙인다. */
    openPublic: (path: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.appOpenPublic, path),
    /** 카드의 미리보기 그림(서버가 준 `preview_url`) → data URL. 없거나 못 받으면 빈 문자열. */
    previewImage: (previewUrl: string): Promise<string> =>
      ipcRenderer.invoke(CHANNELS.appPreviewImage, previewUrl),
    /** 앱을 띄워 미리보기를 찍어 올린다(사이트, 그리고 지금 도는 앱만). 한 번에 하나씩 main 이 줄 세운다. */
    capturePreview: (target: {
      workflow_id: string; slug: string; kind: string; app_url?: string; force?: boolean;
    }): Promise<{ ok: boolean; preview_url?: string; reason?: string }> =>
      ipcRenderer.invoke(CHANNELS.appCapturePreview, target),
    /** 앱 소식을 받기 시작한다(서버의 목록 소켓). 여러 번 불러도 소켓은 하나다. */
    watch: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CHANNELS.appsWatch),
    /** 어느 에이전트의 앱이 바뀌었다(생김·지움·배포·공유) — 다른 기기·웹·에이전트가 바꾼 것도. */
    onChanged: (cb: (workflowId: string) => void): (() => void) => {
      const h = (_e: unknown, workflowId: string) => cb(String(workflowId ?? ''));
      ipcRenderer.on(CHANNELS.appsChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.appsChanged, h);
    },
  },

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
        /** 이 턴의 작업 과정(도구를 쓴 턴만) — 서버가 실행 기록에서 되살린 것. */
        process?: HistoryFlowItem[];
      }) => void,
    ): (() => void) => {
      const h = (_e: unknown, turn: Parameters<typeof cb>[0]) => cb(turn);
      ipcRenderer.on(CHANNELS.chatWatchTurn, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatWatchTurn, h);
    },
    /** 이 대화에 지금 도는 턴이 있는가 — 구독 확립/재연결 때마다 온다.
     *  돌고 있으면 그 턴의 진행분(live)이 함께 온다. */
    onRunning: (
      cb: (state: {
        interactionId: string;
        running: boolean;
        live?: { text: string; events: unknown[]; startedAt?: number; textTotal?: number } | null;
      }) => void,
    ): (() => void) => {
      const h = (_e: unknown, state: Parameters<typeof cb>[0]) => cb(state);
      ipcRenderer.on(CHANNELS.chatWatchRunning, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatWatchRunning, h);
    },
    /**
     * **다른 화면**(다른 기기·웹 탭)이 돌리는 턴. 시작(질문 본문)·진행(토큰)·
     * 종료(완결 본문)가 온다. 이 창의 턴도 온다(`originId` 가 이 창의 표식) — 스트림이 끊긴 뒤
     * 그 턴의 나머지를 받는 길이라 서버가 거르지 않는다. 메아리는 화면이 거른다.
     */
    onPeer: (
      cb: (event: {
        kind: 'started' | 'exec' | 'ended' | 'gap';
        interactionId: string;
        originId?: string;
        input?: string;
        output?: string;
        ioId?: number | null;
        event?: string;
        data?: unknown;
        attachments?: Array<{ name: string; kind: 'image' | 'file'; mimeType?: string; size?: number; workspacePath?: string }>;
      }) => void,
    ): (() => void) => {
      const h = (_e: unknown, event: Parameters<typeof cb>[0]) => cb(event);
      ipcRenderer.on(CHANNELS.chatWatchPeer, h);
      return () => ipcRenderer.removeListener(CHANNELS.chatWatchPeer, h);
    },
    /**
     * 대화 **목록** 변화 — 다른 기기에서 만든/지운/이름 바꾼 대화.
     * 실행 시작·종료(`conversation_running`)도 오지만, 그것 때문에 목록 전체를
     * 다시 읽으면 대화 하나가 도는 동안 목록이 계속 깜빡인다.
     */
    onConversationsChanged: (
      cb: (event: { kind: string; interactionId: string; workflowId: string; running?: boolean }) => void,
    ): (() => void) => {
      const h = (_e: unknown, event: Parameters<typeof cb>[0]) => cb(event);
      ipcRenderer.on(CHANNELS.conversationsChanged, h);
      return () => ipcRenderer.removeListener(CHANNELS.conversationsChanged, h);
    },
  },

  /** 진단 로그 — 설정 [일반]의 [진단 로그 복사]. */
  diag: {
    text: (): Promise<string> => ipcRenderer.invoke(CHANNELS.diagText),
    /** 진단 로그를 **main 의 clipboard 로** 복사 (렌더러 clipboard 는 막힐 수 있다). */
    copy: (): Promise<{ ok: boolean; chars: number }> => ipcRenderer.invoke(CHANNELS.diagCopy),
  },

  /** 파일 저장소 — 탐색기·파일 뷰어가 서버의 파일 저장소를 읽는다. */
  storage: {
    /** 탐색기의 에이전트 섹션 — 이 계정의 개인 에이전트. */
    agents: (): Promise<Array<{ workflowId: string; label: string }>> =>
      ipcRenderer.invoke(CHANNELS.fsAgents),
    /** 한 폴더의 직계 자식 ('a/b' 는 저장소 상대 경로, '' 는 루트). */
    cloudList: (
      rel?: string,
    ): Promise<{ ok: boolean; entries: WorkspaceEntryLike[]; error?: string }> =>
      ipcRenderer.invoke(CHANNELS.fsCloudList, rel ?? ''),
    /** 파일 원바이트 — 파일 뷰어. */
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
