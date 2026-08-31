/** IPC channel names shared by main and preload. */
export const CHANNELS = {
  configGet: 'config:get',
  configSet: 'config:set',
  configChanged: 'config:changed',
  /** 서버 주소 확정 — 스킴이 없으면 https → http 순으로 실제 연결해 정한다. */
  configProbeServer: 'config:probeServer',

  authLogin: 'auth:login',
  authSsoLogin: 'auth:ssoLogin',
  authSsoComplete: 'auth:ssoComplete',
  authRestore: 'auth:restore',
  authAutoLogin: 'auth:autoLogin', // launch: sign in with saved credentials
  authLoginPrefill: 'auth:loginPrefill', // login form: remembered email + autoLogin flag
  authLogout: 'auth:logout',
  authStatus: 'auth:status',
  authFailed: 'auth:failed',

  userAvatarConfig: 'user:avatarConfig', // renderer → main → GET /api/admin/user preferences.avatar
  userSaveAvatarConfig: 'user:saveAvatarConfig', // overlay adjusts scale/position → PUT
  userSaveAvatarTransform: 'user:saveAvatarTransform', // per-avatar transform patch (read-modify-write)
  // 아바타 설정 뷰 (등록/이름/선택/삭제 + 스토어) — 전부 main 의 XgenClient 경유
  avatarUploadAsset: 'avatar:uploadAsset',
  avatarDeleteAsset: 'avatar:deleteAsset',
  avatarSetEnabled: 'avatar:setEnabled',
  avatarSelect: 'avatar:select',
  avatarRename: 'avatar:rename',
  avatarAdd: 'avatar:add',
  avatarRemove: 'avatar:remove',
  avatarStoreList: 'avatar:store:list',
  avatarStorePublish: 'avatar:store:publish',
  avatarStoreDownload: 'avatar:store:download',
  avatarStoreRate: 'avatar:store:rate',
  avatarStoreUnpublish: 'avatar:store:unpublish',
  avatarRefresh: 'avatar:refresh', // main → overlay (auth ready / config changed → refetch now)

  agentsList: 'agents:list',
  agentsCreateOptions: 'agents:create-options',
  agentsCreate: 'agents:create',

  // Voice (STT/TTS) — renderer captures audio, main proxies to the backend
  // (secrets stay server-side). Audio crosses IPC as Uint8Array + mime.
  voiceConfig: 'voice:config', // GET /api/admin/user → preferences.stt/tts (hints)
  voiceTranscribe: 'voice:transcribe', // audio bytes → POST /api/audio/stt/transcribe → text
  voiceSpeak: 'voice:speak', // text → POST /api/audio/tts/speak → audio bytes

  // SSH — 개인별 서버 목록. **서버가 유일한 저장소**이고 이 채널들은 그대로
  // 통과시키기만 한다. 로컬 사본을 두면 웹 마이페이지와 어긋나고, 어긋난 둘을
  // 맞추는 규칙은 반드시 사용자가 지운 서버를 되살린다.
  sshConfig: 'ssh:config',
  sshSetEnabled: 'ssh:setEnabled',
  sshCreateServer: 'ssh:createServer',
  sshUpdateServer: 'ssh:updateServer',
  sshDeleteServer: 'ssh:deleteServer',
  sshTestServer: 'ssh:testServer',

  // Teams — 사람 사이의 대화. REST 는 요청/응답, 실시간은 teamsEvent push.
  teamsRooms: 'teams:rooms',
  teamsCreateRoom: 'teams:createRoom',
  teamsOpenDm: 'teams:openDm',
  /**
   * teams 로컬 설정의 **부분** 갱신. `config:set` 은 최상위 얕은 병합이라
   * `{teams:{lastReadAt}}` 를 보내면 `mutedRooms` 가 통째로 날아간다.
   */
  teamsSavePrefs: 'teams:savePrefs',
  teamsUpdateRoom: 'teams:updateRoom',
  teamsLeaveRoom: 'teams:leaveRoom',
  /** 새 메시지 OS 알림 — 렌더러가 "지금 보고 있지 않고 음소거도 아니다" 를 판정해 요청한다. */
  teamsNotify: 'teams:notify',
  /** 알림을 눌렀다 → 그 방을 열라고 렌더러에 알린다. */
  teamsNotificationClick: 'teams:notificationClick',
  teamsMembers: 'teams:members',
  teamsAddMember: 'teams:addMember',
  teamsSearchUsers: 'teams:searchUsers',
  teamsMessages: 'teams:messages',
  teamsSend: 'teams:send',
  teamsEdit: 'teams:edit',
  teamsReact: 'teams:react',
  teamsWatch: 'teams:watch', // 방 탭 열림 → 방 WS 연결
  teamsUnwatch: 'teams:unwatch', // 방 탭 닫힘 → 방 WS 해제
  teamsTyping: 'teams:typing',
  teamsEvent: 'teams:event', // main → renderer (정규화된 실시간 이벤트)
  // 모든 기능이 공유하는 계정별 OS 알림 정책/표시/클릭 deep-link.
  notificationPreferences: 'notification:preferences',
  notificationUpdate: 'notification:update',
  notificationTest: 'notification:test',
  notificationStatus: 'notification:status',
  notificationContext: 'notification:context',
  notificationNavigate: 'notification:navigate',
  notificationConsumeTarget: 'notification:consumeTarget',
  // 첨부 — 업로드는 바이트를 받아 서버에 multipart 로 올리고, 저장/열기는
  // 내려받은 바이트를 디스크에 쓴다. 렌더러는 파일 경로를 만지지 않는다.
  /** 임의 텍스트를 **main 의 clipboard 로** 복사. 렌더러의 navigator.clipboard 는
   *  Electron 에서 권한/보안 컨텍스트 때문에 조용히 실패할 수 있다. */
  clipboardWrite: 'clipboard:write',
  teamsUploadAttachment: 'teams:uploadAttachment',
  teamsSaveAttachment: 'teams:saveAttachment',
  teamsOpenAttachment: 'teams:openAttachment',
  /** 첨부 원본 바이트 — 그림 미리보기용. 디스크를 거치지 않는다. */
  teamsReadAttachment: 'teams:readAttachment',
  /** 워크스페이스(가상 드라이브)의 파일을 그대로 방에 올린다 — 에이전트 산출물 공유. */
  teamsShareWorkspaceFile: 'teams:shareWorkspaceFile',

  historyTurns: 'history:turns',
  historyConversations: 'history:conversations',

  // Agent Viewer — 한 에이전트의 읽기 전용 관측 데이터 (메모리/작업/도구/스토리지/전체로그).
  // 전부 core 의 AgentDataApi(GET only) 에 위임한다.
  agentTraceList: 'agent:traceList',
  agentTraceDetail: 'agent:traceDetail',
  agentMemoryList: 'agent:memoryList',
  agentMemoryRead: 'agent:memoryRead',
  agentTasksList: 'agent:tasksList',
  agentTaskRuns: 'agent:taskRuns',
  agentTaskOutput: 'agent:taskOutput',
  agentBasicInfo: 'agent:basicInfo',
  agentToolsList: 'agent:toolsList',
  agentToolGet: 'agent:toolGet',
  agentWsTree: 'agent:wsTree',
  agentWsFile: 'agent:wsFile',
  agentWsBinary: 'agent:wsBinary',
  agentWsUpload: 'agent:wsUpload',

  chatStart: 'chat:start',
  chatCancel: 'chat:cancel',
  chatEvent: 'chat:event',
  //: '진행 중 대화' 삭제 시 서버 세션 RAM 을 완전 정리(evict). 이력은 보존.
  chatEndSession: 'chat:end-session',

  // Sandboxed browser pages + stable main-process runtime.
  browserState: 'browser:state',
  browserStateEvent: 'browser:stateEvent',
  browserConnectionEvent: 'browser:connectionEvent',
  browserRevealEvent: 'browser:revealEvent',
  browserCreate: 'browser:create',
  browserEnsureShared: 'browser:ensureShared',
  browserBindShared: 'browser:bindShared',
  browserNavigate: 'browser:navigate',
  browserActivate: 'browser:activate',
  browserSelectionBegin: 'browser:selectionBegin',
  browserSelectionInspect: 'browser:selectionInspect',
  browserSelectionComplete: 'browser:selectionComplete',
  browserSelectionCancel: 'browser:selectionCancel',
  browserPopupResolve: 'browser:popupResolve',
  browserHistorySuggestions: 'browser:historySuggestions',
  browserHistoryList: 'browser:historyList',
  browserHistoryRemove: 'browser:historyRemove',
  browserHistoryClear: 'browser:historyClear',
  browserClose: 'browser:close',
  browserCloseWorkflow: 'browser:closeWorkflow',

  updaterCheck: 'updater:check',
  updaterGetEnabled: 'updater:getEnabled',
  updaterSetEnabled: 'updater:setEnabled',
  updaterMessage: 'updater:message',
  appVersion: 'app:version',
  systemMetrics: 'system:metrics',

  // Floating avatar overlay (Geny-style)
  overlayGetEnabled: 'overlay:getEnabled',
  overlaySetEnabled: 'overlay:setEnabled',
  overlayPushState: 'overlay:pushState', // main-window → main → overlay
  overlayState: 'overlay:state', // main → overlay (broadcast)
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse', // overlay → main (click-through)
  overlayMoveBy: 'overlay:moveBy', // overlay → main (drag; DPI-safe setPosition)
  overlayResizeBy: 'overlay:resizeBy', // overlay → main (edge resize)
  overlayCommitBounds: 'overlay:commitBounds', // overlay → main (drag/resize END → persist now)
  overlayFocusMain: 'overlay:focusMain', // overlay → main (raise chat window)
  overlayOpenSettings: 'overlay:openSettings', // overlay → main (raise + open settings modal)
  overlayHide: 'overlay:hide', // overlay → main (close the space)
  // 잠금은 **main 이 소유한다** — 아바타 창과 컨트롤 창이 서로 다르게 알고
  // 있으면 안 된다. 두 창 모두 여기서 상태를 받고, 토글도 여기로 보낸다.
  overlaySetLocked: 'overlay:setLocked', // chip/overlay → main (잠금 토글)
  overlayGetLocked: 'overlay:getLocked', // 창 → main (첫 렌더용 초기값)
  overlayLocked: 'overlay:locked', // main → 두 창 (broadcast)
  overlayChipSize: 'overlay:chipSize', // chip → main (실측 크기)
  overlayChipInset: 'overlay:chipInset', // main → overlay (자막을 들어 올릴 높이)

  // 화면 캡처 — 채팅을 보낼 때 지금 화면을 함께 보낸다.
  captureListSources: 'capture:listSources', // 설정 화면의 대상 선택
  captureScreen: 'capture:screen', // 한 장 찍기
  captureAccessStatus: 'capture:accessStatus', // macOS 화면 기록 권한 상태

  // Window / app management (tray, autostart, reset, restart)
  openSettingsModal: 'app:openSettingsModal', // main → main-window (open settings modal)
  /** 네이티브 폴더 선택 다이얼로그 — 고른 절대 경로 또는 null(취소). */
  pickFolder: 'app:pickFolder',
  autostartGet: 'app:autostartGet',
  autostartSet: 'app:autostartSet',
  resetPositions: 'app:resetPositions',
  resetSettings: 'app:resetSettings',
  appRestart: 'app:restart',
  appQuit: 'app:quit',

  // Hotkeys
  quickChatSetHotkey: 'quickchat:setHotkey',
  hotkeyPause: 'hotkey:pause', // suspend global shortcuts while recording
  hotkeyResume: 'hotkey:resume',

  // Local MCP (connector-hosted MCP servers bridged to the user's agents)
  mcpGetEnabled: 'mcp:getEnabled',
  mcpSetEnabled: 'mcp:setEnabled',
  mcpListServers: 'mcp:listServers',
  mcpSaveServers: 'mcp:saveServers',
  mcpTestServer: 'mcp:testServer',
  mcpTestProgressEvent: 'mcp:testProgress',
  mcpRefresh: 'mcp:refresh',
  mcpRuntimeLogs: 'mcp:runtimeLogs',
  mcpClearRuntimeLogs: 'mcp:clearRuntimeLogs',
  mcpRuntimeLogEvent: 'mcp:runtimeLogEvent',
  mcpAuthorize: 'mcp:authorize',
  mcpOauthStatus: 'mcp:oauthStatus',
  mcpClearOauth: 'mcp:clearOauth',
  mcpRenameSecrets: 'mcp:renameSecrets',
  diagText: 'diag:text',
  diagCopy: 'diag:copy',
  workspaceStatus: 'workspace:status',
  workspaceStatusEvent: 'workspace:statusEvent',
  workspaceAttach: 'workspace:attach',
  workspaceDetach: 'workspace:detach',
  workspaceOpen: 'workspace:open',
  workspaceRoot: 'workspace:root',
  workspaceSetRoot: 'workspace:setRoot',
  workspaceSetEnabled: 'workspace:setEnabled',
  workspaceRemount: 'workspace:remount',
  workspaceRefresh: 'workspace:refresh',
  /** 연결된 에이전트 목록만 서버에서 다시 읽는다 (파일 캐시는 건드리지 않는다). */
  workspaceRefreshAgents: 'workspace:refresh-agents',
  /** 가상 드라이브 한 폴더의 직계 자식 목록 — 인앱 탐색기 사이드바용. */
  workspaceList: 'workspace:list',
  /** 드라이브 안 경로 하나를 OS 기본 앱/파일 관리자로 연다. */
  workspaceOpenPath: 'workspace:openPath',
  mcpStatus: 'mcp:status',
  mcpStatusEvent: 'mcp:statusEvent',

  // Quick-chat (Spotlight-style input bar, global hotkey)
  quickChatGetEnabled: 'quickchat:getEnabled',
  quickChatSetEnabled: 'quickchat:setEnabled',
  quickChatGetHotkey: 'quickchat:getHotkey',
  quickChatSubmit: 'quickchat:submit', // quickchat window → main
  quickChatClose: 'quickchat:close', // quickchat window → main
  quickChatOpened: 'quickchat:opened', // main → quickchat (paint card)
  quickChatDismissed: 'quickchat:dismissed', // main → quickchat (hide card)
  quickSend: 'connector:quickSend', // main → main-window Chat (deliver message)

  openExternal: 'shell:openExternal',

  // 로컬 동기화 — 에이전트 workspace 저장소 ↔ 로컬 도구 기본 작업 폴더
  syncStatus: 'sync:status',
  syncStatusEvent: 'sync:statusEvent',
  syncNow: 'sync:now',
  /** 동기화된 에이전트 폴더의 직계 자식 (인앱 탐색기용, 로컬 fs). */
  syncList: 'sync:list',
  /** 동기화된 에이전트 폴더 안 경로를 OS 로 연다. */
  syncOpenPath: 'sync:openPath',

  // 로그인 시크릿 저장 상태 (키체인/암호화 저장 불가 표면화)
  secureStorageStatus: 'secure:storageStatus',

  // 로컬 실행 환경(설치 폴더의 Python 런타임 + CLI) — 상태 조회 / 설치 / 진행 push /
  // 서버 버전으로 수렴(sync). 커넥터-세션 턴은 chatStart 가 자동으로 이 환경(사이드카
  // 데몬)에서 돌린다 — 별도 렌더러 IPC 없음.
  // CLI 바이너리(codex / Claude Code) 프로비저닝 — 공식 배포처에서 로컬 설치.
  /** 설치 폴더 등 로컬 폴더를 OS 파일 관리자로 연다. */
  appOpenFolder: 'app:openFolder',
} as const;
