/**
 * 대화 목록·시작 화면의 규칙(2026-10-10): 줄 모양, [최근 채팅] · [에이전트] · 에이전트 화면, 채팅 검색 창의 줄,
 * 옛 엔진 목록 맞추기, 보낸 뒤 맨 위로, 첫 쪽 다시 받기, 시작 화면 입력창 잠금, 새 에이전트 기본값과 세부 설정 값.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentCreateOptions, AgentCreateSetting, Conversation, ConversationAgent } from '@dex/protocol';
import {
  START_TEXT,
  agentDrillView,
  agentSection,
  applyFirstPage,
  conversationAgentRows,
  conversationRows,
  conversationStub,
  createdAgent,
  historyPickItem,
  nextRecentCount,
  normalizeConversations,
  prepareCreateOptions,
  purgeDeletedLabel,
  recentNeedsPage,
  recentSection,
  sanitizeCreateSettings,
  searchFailedText,
  searchResultRow,
  searchResultView,
  startAgentChoices,
  startComposerLock,
  startSendBlocked,
  touchAfterSend,
  type StartLockInput,
} from '../src/conversation-view';

const conv = (interactionId: string, rest: Partial<Conversation> = {}): Conversation => ({
  id: 1,
  interactionId,
  workflowId: 'wf',
  workflowName: 'gitlab',
  interactionCount: 2,
  metadata: {},
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  title: '',
  customTitle: false,
  tag: null,
  agentDeleted: false,
  agentOwnerId: null,
  compare: [],
  ...rest,
});

const key = (c: { workflowId: string; interactionId: string }): string => `${c.workflowId}\u0000${c.interactionId}`;

test('줄 = 작은 에이전트 이름(사라졌으면 [지워짐]) + 꼬리표 + 제목(없으면 "새 대화")', () => {
  const rows = conversationRows(
    [
      conv('a', { title: '배포 상태 알려줘' }),
      conv('b', { title: '', tag: 'schedule' }),
      conv('c', { title: '옛 대화', agentDeleted: true, workflowName: 'removed' }),
    ],
    key({ workflowId: 'wf', interactionId: 'b' }),
  );
  assert.deepEqual(
    rows.map((r) => [r.agentLabel, r.tagLabel ?? null, r.title, r.active, r.agentDeleted]),
    [
      ['gitlab', null, '배포 상태 알려줘', false, false],
      ['gitlab', '스케줄', '새 대화', true, false],
      ['지워짐', null, '옛 대화', false, true],
    ],
  );
  assert.equal(purgeDeletedLabel(3), '에이전트가 사라진 채팅 제거 (3)');
});

test('꼬리표 이름은 protocol 과 같다(배포 · Teams · 스케줄 · 비교 · API · 테스트 · 캔버스)', () => {
  const tags = ['deploy', 'teams', 'schedule', 'compare', 'api', 'test', 'canvas'] as const;
  const rows = conversationRows(tags.map((tag) => conv(tag, { tag })));
  assert.deepEqual(rows.map((r) => r.tagLabel), ['배포', 'Teams', '스케줄', '비교', 'API', '테스트', '캔버스']);
});

test('옛 dex-cli 의 목록(제목 없음)은 같은 규칙으로 제목·꼬리표를 만들고 비교 파생을 접는다', () => {
  const legacy = [
    { id: 3, interactionId: 'p1', workflowId: 'wf', workflowName: 'gitlab', interactionCount: 1, metadata: { first_message: '  안녕\n하세요  ' }, createdAt: '', updatedAt: '' },
    { id: 4, interactionId: 'p1__cmp_other', workflowId: 'wf2', workflowName: 'other', interactionCount: 1, metadata: {}, createdAt: '', updatedAt: '' },
    { id: 5, interactionId: 'teams-room-1', workflowId: 'wf', workflowName: 'gitlab', interactionCount: 1, metadata: { title: '붙인 이름' }, createdAt: '', updatedAt: '' },
    { workflowId: '', interactionId: 'broken' },
  ];
  const list = normalizeConversations(legacy);
  assert.deepEqual(list.map((c) => [c.interactionId, c.title, c.customTitle, c.tag]), [
    ['p1', '안녕 하세요', false, 'compare'],
    ['teams-room-1', '붙인 이름', true, 'teams'],
  ]);
  assert.equal(list[0].compare.length, 1, '비교 파생 스레드는 부모 한 줄로');
  assert.equal(list[0].agentDeleted, false);
});

test('새 엔진의 목록은 그대로 둔다(빠진 칸만 채운다)', () => {
  const fresh = conv('x', { title: '그대로', tag: 'api', agentDeleted: true });
  const [only] = normalizeConversations([fresh]);
  assert.deepEqual(only, fresh);
  assert.deepEqual(normalizeConversations('nope'), []);
});

test('보낸 대화는 맨 위로, 목록에 없던 새 대화는 첫 말을 제목으로 한 줄을 만든다', () => {
  const list = [conv('a'), conv('b')];
  const known = touchAfterSend(list, { workflowId: 'wf', workflowName: 'gitlab', interactionId: 'b', text: '다시', now: '2026-10-10T00:00:00Z' });
  assert.equal(known.created, false);
  assert.deepEqual(known.list.map((c) => c.interactionId), ['b', 'a']);
  assert.equal(known.list[0].updatedAt, '2026-10-10T00:00:00Z');
  assert.equal(known.list[0].interactionCount, 3);

  const fresh = touchAfterSend(list, { workflowId: 'wf9', workflowName: 'new', interactionId: 'n', text: '첫 질문\n둘째 줄', now: '2026-10-10T00:00:00Z' });
  assert.equal(fresh.created, true);
  assert.deepEqual(fresh.list.map((c) => c.interactionId), ['n', 'a', 'b']);
  assert.equal(fresh.list[0].title, '첫 질문 둘째 줄');
  assert.equal(fresh.list[0].workflowName, 'new');
});

test('첫 쪽을 다시 받으면: 첫 쪽만 받아 둔 상태는 바꾸되 이 창에서 방금 시작한 대화는 지킨다', () => {
  const local = conversationStub({ workflowId: 'wf', workflowName: 'gitlab', interactionId: 'local', title: '방금' });
  const current = [local, conv('a'), conv('gone')];
  const page = [conv('a', { title: '새 제목' }), conv('b')];
  const next = applyFirstPage(current, page, { pagesLoaded: 1, localKeys: new Set([key(local)]) });
  assert.deepEqual(next.map((c) => c.interactionId), ['local', 'a', 'b'], '서버에서 사라진 대화는 빠지고, 방금 시작한 대화는 남는다');
  assert.equal(next[1].title, '새 제목');

  // 서버 목록에 나타나면 그 줄이 쓰인다(중복 없음).
  const seen = applyFirstPage(next, [conv('local', { title: '서버 제목' }), conv('a')], { pagesLoaded: 1, localKeys: new Set([key(local)]) });
  assert.deepEqual(seen.map((c) => [c.interactionId, c.title]), [['local', '서버 제목'], ['a', '']]);
});

test('뒤쪽까지 받아 둔 상태에서 첫 쪽을 다시 받으면 뒤쪽을 지킨다', () => {
  const current = [conv('a', { updatedAt: '2026-10-03T00:00:00Z' }), conv('old', { updatedAt: '2026-09-01T00:00:00Z' })];
  const page = [conv('new', { updatedAt: '2026-10-05T00:00:00Z' }), conv('a', { updatedAt: '2026-10-03T00:00:00Z' })];
  const next = applyFirstPage(current, page, { pagesLoaded: 2, localKeys: new Set() });
  assert.deepEqual(next.map((c) => c.interactionId), ['new', 'a', 'old']);
});

test('대화 기록 빠른 선택: 제목, 옆에 에이전트 · 꼬리표 · 시각', () => {
  const item = historyPickItem(conv('a', { title: '릴리스 노트', tag: 'deploy', updatedAt: '2026-10-09T01:02:03Z' }), () => '어제');
  assert.deepEqual(item, { label: '릴리스 노트', description: 'gitlab · 배포 · 어제' });
  const bare = historyPickItem(conv('b', { updatedAt: '', agentDeleted: true }), () => '불림');
  assert.deepEqual(bare, { label: '새 대화', description: '지워짐' }, '시각을 모르면 비운다');
});

const lockInput = (rest: Partial<StartLockInput> = {}): StartLockInput => ({
  canCreate: true,
  agentId: '',
  agentExists: false,
  name: '',
  optionsReady: true,
  busy: false,
  ...rest,
});

test('새 에이전트: 이름이 없으면 잠기고, 보내려 하면 이름을 먼저 적으라고 한다', () => {
  const lock = startComposerLock(lockInput({ name: '   ' }));
  assert.deepEqual(lock, { canSend: false, reason: 'name', message: START_TEXT.nameRequired });
  assert.equal(lock.message, '에이전트 이름을 먼저 입력해 주세요.');
  assert.equal(startSendBlocked(lock), true);
});

test('새 에이전트: 겹치는 이름이면 잠기고 같은 이름 안내가 나온다', () => {
  const lock = startComposerLock(lockInput({ name: ' 리서치 ', nameCheck: { name: '리서치', taken: true } }));
  assert.equal(lock.reason, 'taken');
  assert.equal(lock.message, '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.');
  assert.equal(startSendBlocked(lock), true);
});

test('새 에이전트: 이름 검사의 답을 기다리는 동안은 잠겨 보이지만 보내기는 막지 않는다(보내며 다시 묻는다)', () => {
  const pending = startComposerLock(lockInput({ name: '리서치', nameCheck: { name: '리서', taken: false } }));
  assert.equal(pending.canSend, false);
  assert.equal(pending.reason, 'checking');
  assert.equal(startSendBlocked(pending), false);

  const free = startComposerLock(lockInput({ name: '리서치', nameCheck: { name: '리서치', taken: false } }));
  assert.deepEqual(free, { canSend: true });
});

test('새 에이전트: 제공사·모델 목록을 받기 전에는 잠긴다', () => {
  const loading = startComposerLock(lockInput({ name: '리서치', optionsReady: false }));
  assert.equal(loading.reason, 'options');
  assert.equal(loading.message, START_TEXT.optionsLoading);
  const failed = startComposerLock(lockInput({ name: '리서치', optionsReady: false, optionsFailed: true }));
  assert.equal(failed.message, START_TEXT.optionsFailed);
  assert.equal(startSendBlocked(failed), true);
});

test('있는 에이전트는 고르기만 하면 보낼 수 있다. 만들 수 없는 엔진은 고르기 전까지 잠긴다', () => {
  assert.deepEqual(startComposerLock(lockInput({ agentId: 'wf', agentExists: true })), { canSend: true });
  assert.equal(startComposerLock(lockInput({ agentId: 'wf', agentExists: false })).reason, 'agent');
  const old = startComposerLock(lockInput({ canCreate: false, name: '무엇이든' }));
  assert.deepEqual(old, { canSend: false, reason: 'agent', message: START_TEXT.agentRequired });
  assert.equal(startComposerLock(lockInput({ busy: true, agentId: 'wf', agentExists: true })).reason, 'busy');
});

test('에이전트 선택 상자: 첫 값은 "새 에이전트로 시작"(만들 수 없으면 고르라는 자리), 그다음 에이전트', () => {
  const agents = [{ workflowId: 'w1', workflowName: '리서치' }, { workflowId: 'w2', workflowName: '' }];
  assert.deepEqual(startAgentChoices(agents, true), [
    { value: '', label: '새 에이전트로 시작' },
    { value: 'w1', label: '리서치' },
    { value: 'w2', label: 'w2' },
  ]);
  assert.equal(startAgentChoices(agents, false)[0].label, '에이전트 선택');
});

test('새 에이전트 기본값: 서버의 기본 제공사·기본 모델, 없으면 첫 값. 목록에 없는 기본 모델은 앞에 넣는다', () => {
  const options: AgentCreateOptions = {
    providers: [
      { value: 'openai', label: 'OpenAI', models: [{ value: 'gpt-a', label: 'A' }, { value: 'gpt-b', label: 'B' }], defaultModel: 'gpt-b' },
      { value: 'anthropic', label: 'Anthropic', models: [{ value: 'c-1', label: 'C1' }] },
      { value: 'custom', label: '', models: [], defaultModel: 'my-model' },
    ],
    defaultProvider: 'anthropic',
    settings: [
      { id: 'streaming', label: '스트리밍', type: 'BOOL', default: true },
      { id: 'system_prompt', label: '시스템 프롬프트', type: 'STR', default: '' },
    ],
    defaults: {},
  };
  const prepared = prepareCreateOptions(options);
  assert.equal(prepared.defaultProvider, 'anthropic');
  assert.deepEqual(prepared.providers.map((p) => [p.value, p.label, p.defaultModel]), [
    ['openai', 'OpenAI', 'gpt-b'],
    ['anthropic', 'Anthropic', 'c-1'],
    ['custom', 'custom', 'my-model'],
  ]);
  assert.deepEqual(prepared.providers[2].models, [{ value: 'my-model', label: 'my-model' }]);
  assert.deepEqual(prepared.settings.map((s) => s.id), ['system_prompt', 'streaming'], '자주 손대는 것부터');

  assert.equal(prepareCreateOptions({ ...options, defaultProvider: 'gone' }).defaultProvider, 'openai');
  assert.equal(prepareCreateOptions({ ...options, providers: [] }).defaultProvider, '');
});

test('세부 설정 값: 목록에 있는 칸만, 칸의 타입대로. 빈 칸은 보내지 않는다', () => {
  const settings: AgentCreateSetting[] = [
    { id: 'enable_memory', label: '기억', type: 'BOOL', default: true },
    { id: 'max_iterations', label: '반복', type: 'INT', default: 30 },
    { id: 'temperature', label: '온도', type: 'FLOAT', default: 0.7 },
    { id: 'tool_exposure', label: '도구', type: 'STR', default: 'auto', options: [{ value: 'auto', label: '자동' }, { value: 'all', label: '전부' }] },
    { id: 'system_prompt', label: '프롬프트', type: 'STR', default: '' },
  ];
  assert.deepEqual(
    sanitizeCreateSettings(settings, {
      enable_memory: false,
      max_iterations: '12.9',
      temperature: '0.25',
      tool_exposure: 'all',
      system_prompt: '  ',
      api_key: 'secret',
    }),
    { enable_memory: false, max_iterations: 12, temperature: 0.25, tool_exposure: 'all' },
  );
  assert.equal(sanitizeCreateSettings(settings, { tool_exposure: 'nope', max_iterations: 'abc', temperature: '' }), undefined);
  assert.equal(sanitizeCreateSettings(settings, undefined), undefined);
  assert.equal(sanitizeCreateSettings(settings, ['x']), undefined);
});

test('방금 만든 에이전트는 이름과 번호로 바로 대화할 수 있는 모양이다', () => {
  const agent = createdAgent({ workflowId: 'w9', workflowName: '리서치' }, '2026-10-10T00:00:00Z');
  assert.equal(agent.workflowId, 'w9');
  assert.equal(agent.workflowName, '리서치');
  assert.equal(agent.isShared, false);
  assert.equal(agent.createdAt, '2026-10-10T00:00:00Z');
});

// ── [최근 채팅] · [에이전트] ──────────────────────────────────────────

/** 날 글이 시간대와 상관없이 정해지도록 이 PC 의 시각으로 만든다. */
const local = (y: number, m: number, d: number, h = 12, min = 0): string => new Date(y, m - 1, d, h, min).toISOString();
const NOW = new Date(2026, 9, 10, 15, 0);

const group = (workflowId: string, rest: Partial<ConversationAgent> = {}): ConversationAgent => ({
  workflowId,
  workflowName: workflowId.toUpperCase(),
  conversationCount: 3,
  lastActivity: local(2026, 10, 9),
  lastTitle: '마지막 제목',
  lastInteractionId: `${workflowId}-last`,
  agentDeleted: false,
  agentOwnerId: 1,
  ...rest,
});

test('[최근 채팅]: 처음 5개, 더 있으면 [더 보기], 5개보다 많이 보이면 [접기]. 모자라면 다음 쪽', () => {
  const list = Array.from({ length: 12 }, (_, i) => conv(`c${i}`));
  const first = recentSection(list, 5, { hasNextPage: false, running: new Set([key(list[1])]) });
  assert.deepEqual(first.rows.map((r) => [r.interactionId, r.running]), [['c0', false], ['c1', true], ['c2', false], ['c3', false], ['c4', false]]);
  assert.deepEqual([first.more, first.less], [true, false]);
  const opened = recentSection(list, nextRecentCount(5), { hasNextPage: false });
  assert.deepEqual([opened.rows.length, opened.more, opened.less], [10, true, true]);
  const all = recentSection(list, 15, { hasNextPage: false });
  assert.deepEqual([all.rows.length, all.more, all.less], [12, false, true]);
  assert.equal(recentSection(list.slice(0, 5), 5, { hasNextPage: true }).more, true, '다음 쪽이 있으면 [더 보기]');
  assert.equal(recentNeedsPage(8, 10, true), true);
  assert.equal(recentNeedsPage(40, 10, true), false);
  assert.equal(recentNeedsPage(8, 10, false), false);
});

test('[에이전트] 줄: 이름, "마지막 대화 제목 · 날", 대화 수. 처음 5개, [더 보기] 로 5개씩, 5개보다 많으면 [접기]', () => {
  const rows = conversationAgentRows(
    [group('w1'), group('w2', { workflowName: '', agentDeleted: true, lastTitle: '', lastActivity: local(2025, 1, 2) })],
    NOW,
  );
  assert.deepEqual(rows, [
    { workflowId: 'w1', name: 'W1', agentDeleted: false, detail: '마지막 제목 · 어제', count: 3 },
    { workflowId: 'w2', name: '', agentDeleted: true, detail: '새 대화 · 2025. 1. 2.', count: 3 },
  ]);
  const agents = Array.from({ length: 12 }, (_, i) => group(`w${i}`));
  const first = agentSection(agents, 5, NOW);
  assert.deepEqual([first.rows.map((r) => r.workflowId), first.more, first.less], [['w0', 'w1', 'w2', 'w3', 'w4'], true, false]);
  const opened = agentSection(agents, nextRecentCount(5), NOW);
  assert.deepEqual([opened.rows.length, opened.more, opened.less], [10, true, true]);
  const all = agentSection(agents, 15, NOW);
  assert.deepEqual([all.rows.length, all.more, all.less], [12, false, true]);
  assert.deepEqual([agentSection(agents.slice(0, 5), 5).more, agentSection(agents.slice(0, 5), 5).less], [false, false]);
});

test('에이전트 화면: 작은 줄은 날, 없으면 "아직 채팅이 없습니다"', () => {
  const view = agentDrillView({
    workflowId: 'wf',
    workflowName: 'gitlab',
    agentDeleted: false,
    list: [conv('a', { title: '첫 대화', updatedAt: local(2026, 10, 9) })],
    loading: false,
    loadingMore: false,
    hasMore: true,
    now: NOW,
  });
  assert.deepEqual([view.name, view.hasMore], ['gitlab', true]);
  assert.deepEqual(view.rows.map((r) => [r.title, r.when]), [['첫 대화', '어제']]);
  const base = { workflowId: 'gone', workflowName: 'old', agentDeleted: true, list: [], loadingMore: false, hasMore: false };
  const empty = agentDrillView({ ...base, loading: false });
  assert.equal(empty.empty, '아직 채팅이 없습니다');
  assert.equal(agentDrillView({ ...base, loading: true }).empty, '불러오는 중...');
});

test('검색 줄: 조각·날·꼬리표, 제목이 없으면 "새 대화", 사라진 에이전트의 이름은 이름으로 맞았을 때만', () => {
  const c = conv('a', { title: '궁금', workflowName: 'HR Helper', tag: 'teams', updatedAt: local(2025, 1, 2, 3) });
  const snippet = [{ text: '…아래는 ', hit: false }, { text: 'INTJ', hit: true }];
  const row = searchResultRow(
    c,
    { title: [{ text: '궁금', hit: false }], agent: [{ text: 'HR Helper', hit: false }], snippet, snippetFrom: 'output', matchedAt: null },
    NOW,
  );
  assert.deepEqual([row.key, row.agent, row.tagLabel, row.snippet, row.day], [key(c), [{ text: 'HR Helper', hit: false }], 'Teams', snippet, '2025. 1. 2.']);
  const noMatch = { title: [], agent: [{ text: 'Old', hit: false }], snippet: null, snippetFrom: null, matchedAt: null };
  const gone = conv('g', { agentDeleted: true, workflowName: 'Old' });
  assert.deepEqual(searchResultRow(gone, noMatch).title, [{ text: '새 대화', hit: false }]);
  assert.deepEqual(searchResultRow(gone, noMatch).agent, []);
  assert.deepEqual(searchResultRow(gone, { ...noMatch, agent: [{ text: 'Old', hit: true }] }).agent, [{ text: 'Old', hit: true }]);
});

test('검색 결과 안내: 없음, 옛 서버는 제목·이름만, 더 있으면 좁혀 보라고, 실패', () => {
  const page = (hits: number, hasMore = false, contentSearched = true) => ({
    query: 'q',
    terms: ['q'],
    hits: Array.from({ length: hits }, (_, i) => ({
      conversation: conv(`h${i}`),
      match: { title: [{ text: 'q', hit: true }], agent: [], snippet: null, snippetFrom: null, matchedAt: null },
    })),
    hasMore,
    contentSearched,
  });
  assert.deepEqual(searchResultView(page(0)), { rows: [], status: '맞는 채팅이 없습니다.' });
  assert.equal(searchResultView(page(1, false, false)).titleOnly, '이 서버는 제목·에이전트 이름으로만 찾습니다.');
  assert.equal(searchResultView(page(2, true)).more, '맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.');
  assert.equal(searchFailedText('연결 끊김'), '검색하지 못했습니다. 연결 끊김');
});
