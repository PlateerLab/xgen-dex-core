// Mock bridge for visual verification — exposes window.xgen with canned data
// (no network). Mirrors src/preload/index.ts's API surface.
const { contextBridge } = require('electron');

const user = { userId: '1', username: 'admin', isSuperuser: true, roles: [], permissions: [] };
const agents = [
  { workflowId: 'wf1', workflowName: '한국마사회 RAG 상담', nodeCount: 7, isShared: false, isDeployed: true, workflowType: 'canvas', description: '' },
  { workflowId: 'wf2', workflowName: '경마 데이터 분석가', nodeCount: 12, isShared: true, isDeployed: false, workflowType: 'canvas', description: '' },
  { workflowId: 'wf3', workflowName: 'Agentflow (4)', nodeCount: 4, isShared: false, isDeployed: false, workflowType: 'canvas', description: '' },
  { workflowId: 'wf4', workflowName: '사내 문서 도우미', nodeCount: 9, isShared: true, isDeployed: true, workflowType: 'harness', description: '' },
  { workflowId: 'wf5', workflowName: '릴리즈 노트 작성기', nodeCount: 5, isShared: false, isDeployed: false, workflowType: 'canvas', description: '' },
];

const cfgListeners = new Set();
const state = { theme: process.env.VERIFY_THEME || 'system' };
const config = { serverUrl: 'https://xgen.plateer.com', theme: state.theme, autoUpdate: true, lang: 'ko' };

const restoreUser = process.env.VERIFY_STAGE === 'login' ? null : user;
const speakCalls = [];

const avatarCfg = {
  enabled: true,
  defaultAvatarId: 'a2',
  avatars: [
    { id: 'a1', name: '회사 프로필', runtime: 'image', source: 'upload', modelUrl: '/api/storage/avatar/1/a1/p.png' },
    { id: 'a2', name: '엘렌 모델', runtime: 'image', source: 'upload', modelUrl: '/api/storage/avatar/1/a2/p.png', scale: 0.9 },
  ],
};
const storeItems = [
  { storeId: 's1', name: '사내 마스코트', description: '플래티어 공식 마스코트 아바타입니다.', runtime: 'image',
    publisherUserId: 1, publisherName: 'admin', descriptor: { id: 'sd1', name: '사내 마스코트', runtime: 'image', source: 'upload', modelUrl: '/api/storage/avatar/2/sd1/p.png' },
    createdAt: 0, downloads: 12, ratingAvg: 4.5, ratingCount: 4, myRating: 5 },
  { storeId: 's2', name: '엘렌 (공유)', description: '무료 Live2D 모델 공유본.', runtime: 'image',
    publisherUserId: 7, publisherName: 'shlee', descriptor: { id: 'sd2', name: '엘렌', runtime: 'image', source: 'upload', modelUrl: '/api/storage/avatar/7/sd2/p.png' },
    createdAt: 0, downloads: 3, ratingAvg: 0, ratingCount: 0, myRating: null },
];

const api = {
  config: {
    get: async () => ({ ...config, theme: state.theme }),
    set: async (patch) => {
      Object.assign(config, patch);
      if (patch.theme) state.theme = patch.theme;
      const next = { ...config, theme: state.theme };
      cfgListeners.forEach((cb) => cb(next));
      return next;
    },
    onChange: (cb) => { cfgListeners.add(cb); return () => cfgListeners.delete(cb); },
  },
  auth: {
    login: async () => ({ user }),
    restore: async () => ({ user: restoreUser }),
    logout: async () => true,
    status: async () => ({ user }),
    onAuthFailed: () => () => {},
  },
  user: {
    // 'avatar' stage: canned config with two photo avatars; otherwise empty so
    // the overlay stage keeps its placeholder rendering.
    avatarConfig: async () =>
      process.env.VERIFY_STAGE === 'avatar' ? { ...avatarCfg } : { enabled: false, defaultAvatarId: null, avatars: [] },
    saveAvatarConfig: async () => {},
    saveAvatarTransform: async () => {},
    onAvatarRefresh: () => () => {},
  },
  avatars: {
    uploadAsset: async (_bytes, filename) => ({
      id: 'up1', name: (filename || 'avatar').replace(/\.[^.]+$/, ''), runtime: 'image', source: 'upload',
      modelUrl: '/api/storage/avatar/1/up1/photo.png',
    }),
    deleteAsset: async () => {},
    setEnabled: async (enabled) => { avatarCfg.enabled = enabled; return { ...avatarCfg }; },
    select: async (id) => { avatarCfg.defaultAvatarId = id; return { ...avatarCfg }; },
    rename: async (id, name) => { avatarCfg.avatars = avatarCfg.avatars.map((a) => (a.id === id ? { ...a, name } : a)); return { ...avatarCfg }; },
    add: async (d, name) => { avatarCfg.avatars = [...avatarCfg.avatars, { ...d, name: name || d.name }]; return { ...avatarCfg }; },
    remove: async (id) => { avatarCfg.avatars = avatarCfg.avatars.filter((a) => a.id !== id); return { ...avatarCfg }; },
    storeList: async () => storeItems.slice(),
    storePublish: async () => storeItems[0],
    storeDownload: async () => ({ id: 'dl1', name: '사내 마스코트', runtime: 'image', source: 'upload', modelUrl: '/api/storage/avatar/2/dl1/p.png' }),
    storeRate: async (storeId, stars) => ({ ...storeItems.find((i) => i.storeId === storeId), myRating: stars }),
    storeUnpublish: async () => {},
  },
  voice: {
    // 'voice' 힌트: STT/TTS 서버 활성 상태로 목킹 → 채팅에 마이크/스피커 버튼 노출
    getConfig: async () => ({
      stt: { enabled: true, provider: 'openai', model_id: 'whisper-1', language: 'ko' },
      tts: {
        enabled: true,
        active_profile_id: 'p1',
        profiles: [{ id: 'p1', name: '기본 목소리', voice_id: 'alloy', language: 'ko' }],
      },
    }),
    transcribe: async () => '안녕하세요',
    speak: async (text) => {
      speakCalls.push(String(text || ''));
      // 실제 디코드 가능한 최소 WAV(24kHz mono PCM16, 60ms 무음) — 렌더러가
      // decodeAudioData 로 재생하므로 가짜 바이트면 오류 경로로 빠진다.
      const sr = 24000;
      const n = Math.floor(sr * 0.06);
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
      w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, n * 2, true);
      return new Blob([buf], { type: 'audio/wav' });
    },
    /* 검증용 계측 — 자동 TTS 가 문장 단위로 호출됐는지 하네스가 조회 */
    _speakCalls: () => speakCalls.slice(),
  },
  agents: {
    list: async (q) => {
      let items = agents.slice();
      if (q && q.owner === 'personal') items = items.filter((a) => !a.isShared);
      if (q && q.owner === 'shared') items = items.filter((a) => a.isShared);
      if (q && q.search) items = items.filter((a) => a.workflowName.includes(q.search));
      return { items, pagination: { page: 1, pageSize: 24, totalCount: items.length, totalPages: 1 } };
    },
  },
  history: {
    conversations: async () => [
      { id: 1, interactionId: 'c-1', workflowId: 'wf1', workflowName: '한국마사회 RAG 상담', interactionCount: 6, metadata: {}, createdAt: '', updatedAt: new Date(Date.now() - 12 * 60000).toISOString() },
      { id: 2, interactionId: 'c-2', workflowId: 'wf2', workflowName: '경마 데이터 분석가', interactionCount: 3, metadata: {}, createdAt: '', updatedAt: new Date(Date.now() - 3 * 3600000).toISOString() },
      { id: 3, interactionId: 'c-3', workflowId: 'wf4', workflowName: '사내 문서 도우미', interactionCount: 11, metadata: {}, createdAt: '', updatedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
    ],
    turns: async (workflowId, interactionId) => [
      { logId: 1, ioId: 1, interactionId, workflowId, workflowName: '한국마사회 RAG 상담', input: '지난 분기 실적 요약해줘', output: '2023년 4분기 매출은 전년 대비 8.2% 증가했습니다. 주요 요인은 온라인 발매 확대와 신규 지사 오픈입니다.', updatedAt: '' },
      { logId: 2, ioId: 2, interactionId, workflowId, workflowName: '한국마사회 RAG 상담', input: '온라인 발매 비중은?', output: '전체 발매액의 약 34%가 온라인 채널을 통해 이루어졌습니다.', updatedAt: '' },
    ],
  },
  chat: {
    stream: (req, onEvent) => {
      const script = [
        { d: 120, ev: { kind: 'text', content: '안녕하세요! 😊\n\n' } },
        { d: 260, ev: { kind: 'text', content: '무엇을 도와드릴까요? 한국마사회 관련 자료나 ' } },
        { d: 220, ev: { kind: 'tool', event: { eventType: 'tool_start', toolName: 'knowledge_search', toolInput: {}, citations: [] } } },
        { d: 260, ev: { kind: 'text', content: '경마에 대해 궁금하신 점이 있으시면 ' } },
        { d: 240, ev: { kind: 'tool', event: { eventType: 'tool_result', toolName: 'knowledge_search', result: 'ok', citations: [
          { fileName: '2023년도_보고서.pdf', pageNumber: 12 },
          { fileName: '2020년도_불임2.docx', pageNumber: 3 },
          { fileName: '경마시행규정.pdf' },
        ] } } },
        { d: 220, ev: { kind: 'text', content: '언제든지 질문해 주세요!' } },
        { d: 160, ev: { kind: 'end' } },
      ];
      let i = 0;
      let cancelled = false;
      const tick = () => {
        if (cancelled || i >= script.length) return;
        const step = script[i++];
        setTimeout(() => { if (!cancelled) { onEvent(step.ev); tick(); } }, step.d);
      };
      tick();
      return { cancel: () => { cancelled = true; } };
    },
  },
  quickChat: {
    getEnabled: async () => true,
    setEnabled: async () => true,
    getHotkey: async () => 'CommandOrControl+Shift+Enter',
    setHotkey: async () => true,
    submit: async () => ({ ok: true }),
    close: () => {},
    onOpened: (cb) => { setTimeout(cb, 120); return () => {}; },
    onDismissed: () => () => {},
    onQuickSend: () => () => {},
  },
  appctl: {
    onOpenSettings: () => () => {},
    getAutostart: async () => false,
    setAutostart: async () => false,
    resetPositions: () => {},
    restart: () => {},
    quit: () => {},
  },
  hotkeys: { pause: () => {}, resume: () => {} },
  mcp: {
    getEnabled: async () => true,
    setEnabled: async () => true,
    listServers: async () => [
      { name: 'filesystem', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-filesystem /Users/me/docs', enabled: true },
      { name: 'github', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: false },
    ],
    saveServers: async (s) => s,
    testServer: async () => ({ ok: true, tools: [{ name: 'read_file' }, { name: 'list_dir' }] }),
    status: async () => ({ enabled: true, connected: true, servers: [{ name: 'filesystem', connected: true, tools: [{ name: 'read_file' }, { name: 'list_dir' }, { name: 'write_file' }] }] }),
    onStatus: () => () => {},
  },
  overlay: {
    getEnabled: async () => true,
    setEnabled: async () => true,
    pushState: () => {},
    setClickThrough: () => {},
    moveBy: () => {},
    resizeBy: () => {},
    focusMain: () => {},
    openSettings: () => {},
    hide: () => {},
    onState: (cb) => {
      const full =
        '안녕하세요! 😊 무엇을 도와드릴까요? 한국마사회 관련 자료나 경마에 대해 궁금하신 점이 있으시면 언제든지 질문해 주세요!';
      // Simulate a FAST burst: the whole reply arrives at once (as when the model
      // emits many tokens per chunk). The overlay's typewriter must throttle it.
      setTimeout(() => cb({ workflowId: 'wf1', workflowName: '한국마사회 RAG 상담', streamingText: full, speaking: true }), 150);
      setTimeout(() => cb({ workflowId: 'wf1', workflowName: '한국마사회 RAG 상담', streamingText: full, speaking: false }), 400);
      return () => {};
    },
  },
  updater: {
    check: async () => ({}),
    getEnabled: async () => true,
    setEnabled: async () => true,
    onMessage: () => () => {},
    getVersion: async () => '0.1.8',
  },
  openExternal: async () => {},
};

contextBridge.exposeInMainWorld('xgen', api);
