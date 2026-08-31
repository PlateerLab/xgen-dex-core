/**
 * Mock bridge for the Agent ↔ Teams 다리 smoke (`teams-smoke.cjs`).
 *
 * `verify/preload.cjs` 와 따로 두는 이유: 저쪽은 스크린샷용 화면 목이고, 여기는
 * **경계를 건너간 값을 기록**하는 것이 목적이다. 이 검증이 실제로 잡으려는 것은
 * 화면 모양이 아니라 "무엇이 서버로 나갔는가" 다 —
 *   · 에이전트에게 보낸 input 안에 Teams 봉투가 실렸는가 (그리고 안 붙어야 할 때
 *     안 붙는가)
 *   · 방으로 보낸 메시지에 출처 표식·답장 대상·첨부가 제대로 실렸는가
 * 그래서 모든 호출을 `window.__verify.calls` 에 남기고, 스모크가 그걸 읽는다.
 */
const { contextBridge } = require('electron');

const user = { userId: '1', username: 'admin', isSuperuser: true, roles: [], permissions: [] };
const agents = [
  {
    workflowId: 'wf1',
    workflowName: '사내문서 QA',
    nodeCount: 7,
    isShared: false,
    isDeployed: true,
    workflowType: 'canvas',
    description: '',
  },
];

const calls = [];
const record = (name, args) => {
  calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
};

// ── 시나리오 데이터 ────────────────────────────────────────────────
const ROOM = {
  id: 'room-1',
  name: '3팀 개발방',
  routerMode: 'chat',
  isDirect: false,
  createdAt: '2026-08-24T09:00:00',
  createdBy: 2,
  lastMessageAt: '2026-08-24T10:05:00',
};
const OTHER_ROOM = { ...ROOM, id: 'room-2', name: '공지방', lastMessageAt: '2026-08-24T09:10:00' };

const MESSAGES = [
  {
    id: 'm1',
    roomId: 'room-1',
    senderType: 'user',
    senderId: '2',
    senderName: '김철수',
    content: '결제 모듈 타임아웃 또 났는데 원인 아시는 분?',
    createdAt: '2026-08-24T10:02:00',
  },
  {
    id: 'm2',
    roomId: 'room-1',
    senderType: 'user',
    senderId: '3',
    senderName: '이영희',
    content: '지난주에도 비슷한 게 있었어요',
    createdAt: '2026-08-24T10:05:00',
  },
];

const UPLOADED = {
  id: 'att-1',
  filename: '로그분석.xlsx',
  mime: 'application/vnd.ms-excel',
  size: 20480,
  storageKey: 'att-1.xlsx',
  extractedText: '시트1: 커넥션 풀 고갈 추정',
  truncated: false,
};

const MEMBERS = [
  { userId: 1, username: 'admin', fullName: '관리자', role: 'owner', isOnline: true, joinedAt: '' },
  {
    userId: 2,
    username: '김철수',
    fullName: '김철수',
    role: 'member',
    isOnline: true,
    joinedAt: '',
  },
];
let rooms = [ROOM, OTHER_ROOM];
let teamsEventListener = null;

let sent = 0;
const noop = () => {};
const off = () => () => {};
let notificationProfile = {
  enabled: true,
  events: {},
  privacy: 'full',
  mutedAgents: {},
  mutedChats: {},
  mutedTeamsRooms: {},
  mutedTeamsSenders: {},
};

const api = {
  config: {
    get: async () => ({ serverUrl: 'https://xgen.example.com', theme: 'light', lang: 'ko' }),
    set: async (patch) => {
      record('config.set', patch);
      return { serverUrl: 'https://xgen.example.com', theme: 'light', lang: 'ko', ...patch };
    },
    onChange: off,
  },
  auth: {
    login: async () => ({ user }),
    restore: async () => ({ user }),
    logout: async () => true,
    status: async () => ({ user }),
    onAuthFailed: off,
  },
  agents: {
    list: async () => ({
      items: agents,
      pagination: { page: 1, pageSize: 20, totalCount: 1, totalPages: 1 },
    }),
  },
  user: {
    avatarConfig: async () => ({ enabled: false, avatars: [] }),
    saveAvatarConfig: noop,
    saveAvatarTransform: noop,
    onAvatarRefresh: off,
  },
  avatars: { storeList: async () => [] },
  history: { turns: async () => [], conversations: async () => [] },

  chat: {
    /** 에이전트로 나간 요청을 통째로 기록한다 — 봉투 검증의 핵심. */
    stream: (req, onEvent) => {
      record('chat.stream', req);
      setTimeout(() => onEvent({ kind: 'text', content: '원인은 커넥션 풀 고갈로 보입니다.' }), 30);
      setTimeout(() => onEvent({ kind: 'end' }), 80);
      return { cancel: noop };
    },
  },

  teams: {
    rooms: async () => rooms,
    createRoom: async () => ROOM,
    openDm: async () => ROOM,
    leaveRoom: async (roomId) => {
      record('teams.leaveRoom', { roomId });
      return true;
    },
    members: async () => MEMBERS,
    addMember: async (roomId, userId) => {
      record('teams.addMember', { roomId, userId });
      if (!MEMBERS.some((member) => member.userId === userId)) {
        MEMBERS.push({
          userId,
          username: '이영희',
          fullName: '이영희',
          role: 'member',
          isOnline: false,
          joinedAt: '',
        });
      }
      return true;
    },
    searchUsers: async () => [
      { id: 3, username: '이영희', fullName: '이영희', email: 'younghee@example.com' },
    ],
    messages: async (roomId, before) => {
      record('teams.messages', { roomId, before });
      // 커서가 오면 "더 없음" — ensureMessages 가 무한히 돌지 않는지도 함께 본다.
      return before ? [] : MESSAGES;
    },
    /**
     * 서버와 같게: 답장이면 원본의 sender/content 를 **스냅샷 컬럼**으로 떠서
     * 함께 돌려준다 (`message_service.create_message`). 목이 이걸 빼면 화면에
     * 인용이 안 그려져, 실제로는 잘 도는 기능을 깨진 것으로 오판한다.
     */
    send: async (roomId, content, replyToId, attachments) => {
      record('teams.send', { roomId, content, replyToId, attachments });
      sent += 1;
      const origin = replyToId ? MESSAGES.find((m) => m.id === replyToId) : null;
      return {
        id: `sent-${sent}`,
        roomId,
        senderType: 'user',
        senderId: '1',
        senderName: 'admin',
        content,
        createdAt: `2026-08-24T10:1${sent}:00`,
        replyToId,
        replyToSenderName: origin ? origin.senderName : undefined,
        replyToContent: origin ? origin.content : undefined,
        attachments,
      };
    },
    /**
     * 실제 서버 응답을 그대로 흉내낸다: PATCH 는 `find_records_by_condition` 원본
     * 행을 돌려주므로 **답장 스냅샷(replyTo*)이 없다**. 목에서 친절하게 채워 주면
     * "편집하면 인용이 사라지는" 회귀를 이 검증이 못 잡는다.
     */
    edit: async (roomId, messageId, content) => {
      record('teams.edit', { roomId, messageId, content });
      return {
        id: messageId,
        roomId,
        senderType: 'user',
        senderId: '1',
        senderName: 'admin',
        content,
        createdAt: '2026-08-24T10:02:00',
        isEdited: true,
      };
    },
    react: async () => [],
    watch: async () => true,
    unwatch: async () => true,
    typing: async () => true,
    pickAndUpload: async (roomId) => {
      record('teams.pickAndUpload', { roomId });
      return [UPLOADED];
    },
    shareWorkspaceFile: async (roomId, drivePath) => {
      record('teams.shareWorkspaceFile', { roomId, drivePath });
      return UPLOADED;
    },
    savePrefs: async (patch) => {
      record('teams.savePrefs', patch);
      return true;
    },
    updateRoom: async (roomId, patch) => {
      record('teams.updateRoom', { roomId, patch });
      return { ...ROOM, ...patch };
    },
    notify: async (payload) => {
      record('teams.notify', payload);
      return true;
    },
    onNotificationClick: off,
    saveAttachment: async () => null,
    openAttachment: async () => '',
    readAttachment: async () => new Uint8Array([1, 2, 3]),
    onEvent: (listener) => {
      teamsEventListener = listener;
      return () => {
        if (teamsEventListener === listener) teamsEventListener = null;
      };
    },
  },

  notifications: {
    preferences: async () => notificationProfile,
    update: async (update) => {
      record('notifications.update', update);
      if (update.kind === 'scope') {
        const field =
          update.scope === 'teamsRoom'
            ? 'mutedTeamsRooms'
            : update.scope === 'teamsSender'
              ? 'mutedTeamsSenders'
              : update.scope === 'chat'
                ? 'mutedChats'
                : 'mutedAgents';
        const next = { ...notificationProfile[field] };
        if (update.muted)
          next[update.id] = { muted: true, updatedAt: Date.now(), label: update.label };
        else delete next[update.id];
        notificationProfile = { ...notificationProfile, [field]: next };
      }
      return notificationProfile;
    },
    test: async () => ({ shown: true }),
    status: async () => ({ supported: true, platform: process.platform, developmentMode: true }),
    setContext: noop,
    consumeTarget: async () => null,
    onNavigate: off,
  },

  clipboard: {
    write: async (text) => {
      record('clipboard.write', { text });
      return true;
    },
  },

  // ── 나머지는 화면이 뜨기만 하면 되는 최소 구현 ───────────────────
  browser: {
    onState: off,
    onConnection: off,
    onReveal: off,
    state: async () => ({ enabled: false, pages: [], activeByWorkflow: {} }),
    ensureShared: async () => ({}),
    closeWorkflow: async () => true,
    activate: async () => true,
    close: async () => true,
    navigate: async () => true,
  },
  workspace: {
    status: async () => ({ supported: true, enabled: false, mounted: false, agents: [] }),
    onStatus: off,
    list: async () => [],
    root: async () => '',
    open: async () => ({ ok: true }),
    openPath: async () => ({ ok: true }),
    refresh: async () => true,
    refreshAgents: async () => true,
    remount: async () => ({}),
    setEnabled: async () => ({}),
    setRoot: async () => ({}),
    attach: async () => ({}),
    detach: async () => ({}),
    diagText: async () => '',
    diagCopy: async () => ({ ok: true, chars: 0 }),
  },
  /**
   * main 이 나중에 추가한 표면들. 없으면 마운트 시점에 컴포넌트가 죽어 **아무것도
   * 렌더되지 않는다** — 목이 뒤처지면 제품 버그처럼 보이므로 함께 채운다.
   */
  sync: {
    status: async () => ({ enabled: false, root: '', agents: [] }),
    now: async () => ({ enabled: false, root: '', agents: [] }),
    list: async () => [],
    openPath: async () => ({ ok: true }),
    onStatus: off,
  },
  localRuntime: {
    status: async () => ({ installed: false, agents: [] }),
    install: async () => ({ ok: true }),
    cliInstall: async () => ({ ok: true }),
    sync: async () => ({ ok: true }),
    openLog: async () => ({ ok: true }),
    onProgress: off,
  },
  system: { metrics: off },
  capture: { screen: async () => ({ ok: false }), listSources: async () => [] },
  voice: {
    config: async () => ({ stt: null, tts: null }),
    speak: async () => new Blob(),
    transcribe: async () => '',
  },
  quickChat: {
    setEnabled: async () => true,
    getHotkey: async () => '',
    setHotkey: async () => true,
    submit: async () => ({ ok: true }),
    close: noop,
    onOpened: off,
    onDismissed: off,
    onQuickSend: off,
  },
  appctl: {
    onOpenSettings: off,
    getAutostart: async () => false,
    setAutostart: async () => false,
    resetPositions: noop,
    restart: noop,
    quit: noop,
  },
  hotkeys: { pause: noop, resume: noop },
  mcp: {
    getEnabled: async () => false,
    status: async () => ({ enabled: false, connected: false, servers: [] }),
    onStatus: off,
    runtimeLogs: async () => [],
    onRuntimeLog: off,
  },
  overlay: {
    getEnabled: async () => false,
    setEnabled: async () => false,
    pushState: noop,
    onState: off,
  },
  updater: {
    check: async () => ({}),
    getEnabled: async () => false,
    setEnabled: async () => false,
    onMessage: off,
    getVersion: async () => '0.0.0',
  },
  openExternal: async () => {},
};

contextBridge.exposeInMainWorld('xgen', api);
contextBridge.exposeInMainWorld('__verify', {
  calls: () => JSON.parse(JSON.stringify(calls)),
  clear: () => {
    calls.length = 0;
  },
  removeRoom: (roomId) => {
    rooms = rooms.filter((room) => room.id !== roomId);
    teamsEventListener?.({ kind: 'rooms_changed', roomId, reason: 'removed' });
  },
});
