/**
 * 채팅 목록·시작 화면의 규칙 (2026-10-09).
 *
 * 폰의 첫 화면이 에이전트 목록에서 채팅 목록으로 바뀌었다. 한 줄의 말(에이전트 이름·꼬리표·제목)은 @dex/protocol
 * 정본을 그대로 쓰는가, 쪽을 이어 받고 첫 쪽을 다시 읽을 때 받아 둔 것을 지키는가, 시작 화면의 입력창은
 * 보낼 수 있을 때만 풀리는가, 첫 메시지는 한 번만 나가는가를 본다.
 *
 * (2026-10-10) 몸통이 [최근 채팅] + [에이전트] 가 됐다: [더 보기]·[접기], 세 목록을 함께 고치는 규칙,
 * 채팅 기록 관리의 선택 삭제(4개씩), 시작 화면에 넘겨받은 에이전트를 본다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DELETED_AGENT_LABEL,
  RECENT_CONVERSATION_STEP,
  type AgentCreateSetting,
  type Conversation,
  type ConversationAgent,
  type ConversationPage,
} from '@dex/protocol';
import {
  DELETE_CONCURRENCY,
  START_TEXT,
  applyChatListChanges,
  applyConversationPage,
  conversationRow,
  deleteResultNotice,
  dropConversation,
  keepPresetAgent,
  moreRecent,
  nameCheckState,
  orderedSettings,
  purgeLabel,
  recentWindow,
  removeInBatches,
  renameInState,
  searchResultRow,
  settingsPayload,
  startComposerLock,
  type ChatLists,
  type ConversationListState,
} from '../src/conversations/conversation-model';
import { createInitialMessageGate, newInitialMessage } from '../src/chat/initial-message';

function conv(over: Partial<Conversation> & { interactionId: string }): Conversation {
  return {
    id: 1,
    workflowId: 'wf-a',
    workflowName: '리서치',
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
    ...over,
  };
}

function page(conversations: Conversation[], nextCursor: string | null, agentDeletedCount?: number): ConversationPage {
  return { conversations, nextCursor, ...(agentDeletedCount != null ? { agentDeletedCount } : {}) };
}

// ── 한 줄 ──

test('한 줄: 에이전트 이름(작게) + 제목, 제목이 비면 "새 대화"', () => {
  const row = conversationRow(conv({ interactionId: 'i1', title: '보고서 요약' }));
  assert.equal(row.agent, '리서치');
  assert.equal(row.title, '보고서 요약');
  assert.equal(row.tag, null);
  assert.equal(row.agentDeleted, false);
  assert.equal(conversationRow(conv({ interactionId: 'i2', title: '   ' })).title, '새 대화');
});

test('한 줄: 에이전트가 사라졌으면 [지워짐], 꼬리표는 한국어 이름', () => {
  const row = conversationRow(conv({ interactionId: 'i1', agentDeleted: true, tag: 'schedule', title: 'x' }));
  assert.equal(row.agent, DELETED_AGENT_LABEL);
  assert.equal(DELETED_AGENT_LABEL, '지워짐');
  assert.equal(row.agentDeleted, true);
  assert.equal(row.tag, '스케줄');
  assert.equal(conversationRow(conv({ interactionId: 'i2', tag: 'teams' })).tag, 'Teams');
});

test('한 줄의 열쇠는 에이전트 + 대화 id (같은 대화 id 가 다른 에이전트에 있어도 따로)', () => {
  const a = conversationRow(conv({ interactionId: 'same', workflowId: 'wf-a' }));
  const b = conversationRow(conv({ interactionId: 'same', workflowId: 'wf-b' }));
  assert.notEqual(a.key, b.key);
});

test('[에이전트가 사라진 채팅 제거 (N)]: 수를 붙인다(0 이면 누르면 "정리할 채팅이 없습니다.")', () => {
  assert.equal(purgeLabel(3), '에이전트가 사라진 채팅 제거 (3)');
  assert.equal(purgeLabel(0), '에이전트가 사라진 채팅 제거 (0)');
});

// ── 목록 상태 ──

test('첫 쪽: 받은 순서 그대로, 커서·사라진 채팅 수를 싣는다', () => {
  const s = applyConversationPage(null, page([conv({ interactionId: 'a' }), conv({ interactionId: 'b' })], 'c1', 2), 'reset');
  assert.deepEqual(s.items.map((c) => c.interactionId), ['a', 'b']);
  assert.equal(s.cursor, 'c1');
  assert.equal(s.pages, 1);
  assert.equal(s.deletedCount, 2);
});

test('다음 쪽: 뒤에 잇고 이미 있는 대화는 건너뛴다, 사라진 채팅 수는 첫 쪽 값을 지킨다', () => {
  const first = applyConversationPage(null, page([conv({ interactionId: 'a' }), conv({ interactionId: 'b' })], 'c1', 1), 'reset');
  const next = applyConversationPage(first, page([conv({ interactionId: 'b' }), conv({ interactionId: 'c' })], null), 'append');
  assert.deepEqual(next.items.map((c) => c.interactionId), ['a', 'b', 'c']);
  assert.equal(next.cursor, null);
  assert.equal(next.pages, 2);
  assert.equal(next.deletedCount, 1);
});

test('첫 쪽 다시 읽기: 방금 말한 대화가 위로, 받아 둔 뒤쪽과 그 커서는 지킨다', () => {
  const s1 = applyConversationPage(
    null,
    page(
      [
        conv({ id: 3, interactionId: 'a', updatedAt: '2026-10-03T00:00:00Z' }),
        conv({ id: 2, interactionId: 'b', updatedAt: '2026-10-02T00:00:00Z' }),
      ],
      'c1',
    ),
    'reset',
  );
  const s2 = applyConversationPage(s1, page([conv({ id: 1, interactionId: 'z', updatedAt: '2026-10-01T00:00:00Z' })], 'c2'), 'append');
  // 뒤쪽에 있던 z 에서 방금 말했다.
  const head = applyConversationPage(
    s2,
    page(
      [
        conv({ id: 1, interactionId: 'z', updatedAt: '2026-10-09T00:00:00Z', title: '새 소식' }),
        conv({ id: 3, interactionId: 'a', updatedAt: '2026-10-03T00:00:00Z' }),
      ],
      'c-new',
      0,
    ),
    'head',
  );
  assert.deepEqual(head.items.map((c) => c.interactionId), ['z', 'a', 'b']);
  assert.equal(head.items[0].title, '새 소식');
  assert.equal(head.cursor, 'c2', '두 쪽 이상 받았으면 다음 쪽 커서를 지킨다');
  assert.equal(head.pages, 2);
  assert.equal(head.deletedCount, 0);
});

test('첫 쪽 다시 읽기: 한 쪽만 받았으면 새 커서를 쓴다, 사라진 채팅 수가 안 오면 앞 값을 지킨다', () => {
  const s1 = applyConversationPage(null, page([conv({ interactionId: 'a' })], null, 4), 'reset');
  const head = applyConversationPage(s1, page([conv({ interactionId: 'a' })], 'c9'), 'head');
  assert.equal(head.cursor, 'c9');
  assert.equal(head.deletedCount, 4);
});

test('처음부터 다시(reset): 받아 둔 것을 버린다', () => {
  const s1 = applyConversationPage(null, page([conv({ interactionId: 'a' }), conv({ interactionId: 'b' })], 'c1', 1), 'reset');
  const s2 = applyConversationPage(s1, page([conv({ interactionId: 'c' })], null), 'append');
  const reset = applyConversationPage(s2, page([conv({ interactionId: 'a' })], null, 0), 'reset');
  assert.deepEqual(reset.items.map((c) => c.interactionId), ['a']);
  assert.equal(reset.pages, 1);
  assert.equal(reset.deletedCount, 0);
});

test('지우기: 그 대화만 빠지고, 에이전트가 사라진 대화였으면 그 수도 준다', () => {
  const gone = conv({ interactionId: 'g', agentDeleted: true });
  const s: ConversationListState = {
    items: [conv({ interactionId: 'a' }), gone],
    cursor: null,
    pages: 1,
    deletedCount: 1,
  };
  const afterNormal = dropConversation(s, conv({ interactionId: 'a' }));
  assert.deepEqual(afterNormal.items.map((c) => c.interactionId), ['g']);
  assert.equal(afterNormal.deletedCount, 1);
  const afterGone = dropConversation(afterNormal, gone);
  assert.equal(afterGone.items.length, 0);
  assert.equal(afterGone.deletedCount, 0);
  // 목록에 없는 대화를 지웠다고 수를 줄이지 않는다.
  assert.equal(dropConversation(afterNormal, conv({ interactionId: 'x', agentDeleted: true })).deletedCount, 1);
});

test('이름 바꾸기: 제목만 바뀌고 순서는 그대로', () => {
  const s: ConversationListState = {
    items: [conv({ interactionId: 'a', title: '첫 질문' }), conv({ interactionId: 'b', title: '둘째' })],
    cursor: 'c',
    pages: 1,
    deletedCount: 0,
  };
  const next = renameInState(s, { workflowId: 'wf-a', interactionId: 'b' }, '붙인 이름', true);
  assert.deepEqual(next.items.map((c) => c.interactionId), ['a', 'b']);
  assert.equal(next.items[1].title, '붙인 이름');
  assert.equal(next.items[1].customTitle, true);
  assert.equal(next.cursor, 'c');
});

// ── 시작 화면 ──

test('이름 검사 상태: 이름별로 기억한 답을 본다(앞뒤 공백은 같은 이름)', () => {
  assert.equal(nameCheckState('  ', {}), 'empty');
  assert.equal(nameCheckState('리서치', {}), 'checking');
  assert.equal(nameCheckState(' 리서치 ', { 리서치: false }), 'ok');
  assert.equal(nameCheckState('리서치', { 리서치: true }), 'taken');
  // 늦게 온 앞 이름의 답은 지금 이름을 덮지 않는다.
  assert.equal(nameCheckState('리서치2', { 리서치: false }), 'checking');
});

test('잠금: 새 에이전트는 이름 → 같은 이름 → 모델 목록 → 확인 순으로 이유를 댄다', () => {
  const base = { newAgent: true, optionsReady: true, agentSelected: false, busy: false } as const;
  assert.deepEqual(startComposerLock({ ...base, nameCheck: 'empty' }), { locked: true, reason: START_TEXT.nameRequired });
  assert.deepEqual(startComposerLock({ ...base, nameCheck: 'taken' }), { locked: true, reason: START_TEXT.nameTaken });
  assert.deepEqual(startComposerLock({ ...base, nameCheck: 'ok', optionsReady: false }), {
    locked: true,
    reason: START_TEXT.optionsLoading,
  });
  assert.deepEqual(startComposerLock({ ...base, nameCheck: 'checking' }), { locked: true, reason: START_TEXT.checking });
  assert.deepEqual(startComposerLock({ ...base, nameCheck: 'ok' }), { locked: false, reason: '' });
  assert.equal(START_TEXT.nameRequired, '에이전트 이름을 먼저 입력해 주세요.');
  assert.equal(START_TEXT.nameTaken, '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.');
});

test('잠금: 기존 에이전트는 고르기만 하면 풀린다(이름·모델 목록과 상관없다), 만드는 중이면 잠근다', () => {
  assert.deepEqual(
    startComposerLock({ newAgent: false, nameCheck: 'empty', optionsReady: false, agentSelected: true, busy: false }),
    { locked: false, reason: '' },
  );
  assert.equal(
    startComposerLock({ newAgent: false, nameCheck: 'empty', optionsReady: true, agentSelected: false, busy: false }).locked,
    true,
  );
  assert.equal(
    startComposerLock({ newAgent: true, nameCheck: 'ok', optionsReady: true, agentSelected: false, busy: true }).locked,
    true,
  );
});

const SETTINGS: AgentCreateSetting[] = [
  { id: 'enable_memory', label: '기억', type: 'BOOL', default: true },
  { id: 'max_iterations', label: '반복 한도', type: 'INT', default: 30 },
  { id: 'temperature', label: '온도', type: 'FLOAT', default: 0.7 },
  { id: 'system_prompt', label: '시스템 프롬프트', type: 'STR', default: '' },
  { id: 'tool_exposure', label: '도구 노출', type: 'STR', default: 'auto', options: [{ value: 'auto', label: '자동' }] },
];

test('세부 설정: 손댄 것만 보낸다, 숫자 칸은 숫자로(비었거나 숫자가 아니면 뺀다)', () => {
  assert.equal(settingsPayload(SETTINGS, {}), undefined);
  assert.deepEqual(
    settingsPayload(SETTINGS, {
      enable_memory: false,
      max_iterations: '12.9',
      temperature: ' 0.2 ',
      system_prompt: '간결하게',
      tool_exposure: 'auto',
      unknown_key: 'x',
    }),
    { enable_memory: false, max_iterations: 12, temperature: 0.2, system_prompt: '간결하게', tool_exposure: 'auto' },
  );
  assert.equal(settingsPayload(SETTINGS, { max_iterations: '', temperature: 'abc' }), undefined);
});

test('세부 설정 차례: 자주 손대는 것부터, 모르는 것은 뒤에', () => {
  const ids = orderedSettings([
    { id: 'zzz', label: 'z', type: 'STR', default: '' },
    ...SETTINGS,
  ]).map((s) => s.id);
  assert.deepEqual(ids, ['system_prompt', 'temperature', 'max_iterations', 'tool_exposure', 'enable_memory', 'zzz']);
});

// ── 첫 메시지 ──

test('첫 메시지: 그 대화에 한 번만 나간다(다시 붙어도, 화면이 다시 그려져도)', () => {
  const gate = createInitialMessageGate();
  const msg = newInitialMessage('wf-a', 'mob-wf-a-1', '안녕');
  assert.equal(gate.take(msg, 'wf-a', 'mob-wf-a-1')?.text, '안녕');
  assert.equal(gate.used(msg.id), true);
  assert.equal(gate.take(msg, 'wf-a', 'mob-wf-a-1'), null, '다시 붙어도 다시 보내지 않는다');
});

test('첫 메시지: 다른 대화에는 가지 않고, 그때는 꺼내지도 않는다', () => {
  const gate = createInitialMessageGate();
  const msg = newInitialMessage('wf-a', 'mob-wf-a-1', '안녕');
  assert.equal(gate.take(msg, 'wf-a', 'mob-wf-a-2'), null);
  assert.equal(gate.take(msg, 'wf-b', 'mob-wf-a-1'), null);
  assert.equal(gate.used(msg.id), false);
  assert.equal(gate.take(msg, 'wf-a', 'mob-wf-a-1')?.id, msg.id);
});

test('첫 메시지: 빈 글이나 없는 메시지는 꺼내지 않는다, 표식은 매번 다르다', () => {
  const gate = createInitialMessageGate();
  assert.equal(gate.take(null, 'wf-a', 'i'), null);
  assert.equal(gate.take(newInitialMessage('wf-a', 'i', '   '), 'wf-a', 'i'), null);
  const a = newInitialMessage('wf-a', 'i', 'x', 1000);
  const b = newInitialMessage('wf-a', 'i', 'x', 1000);
  assert.notEqual(a.id, b.id);
});

test('채팅 검색 줄: 최근 채팅은 칠하지 않고, 결과는 서버 조각 그대로, 사라진 에이전트는 이름이 맞을 때만 이름', () => {
  const now = new Date(2026, 9, 10, 15, 0);
  const c = conv({ interactionId: 'a', title: '궁금', workflowName: 'HR Helper', updatedAt: new Date(2026, 9, 9, 10, 0).toISOString() });
  const recent = searchResultRow(c, undefined, now);
  assert.deepEqual(recent.title, [{ text: '궁금', hit: false }]);
  assert.deepEqual(recent.agent, [{ text: 'HR Helper', hit: false }]);
  assert.equal(recent.snippet, null);
  assert.equal(recent.day, '어제');

  const hit = searchResultRow(
    c,
    {
      title: [{ text: '궁금', hit: false }],
      agent: [{ text: 'HR Helper', hit: false }],
      snippet: [{ text: '…', hit: false }, { text: 'INTJ', hit: true }],
      snippetFrom: 'output',
      matchedAt: null,
    },
    now,
  );
  assert.deepEqual(hit.snippet?.filter((p) => p.hit).map((p) => p.text), ['INTJ']);

  const gone = conv({ interactionId: 'g', title: '', workflowName: 'Old', agentDeleted: true });
  assert.deepEqual(searchResultRow(gone, undefined, now).title, [{ text: '새 대화', hit: false }]);
  assert.deepEqual(searchResultRow(gone, undefined, now).agent, []);
  const byName = searchResultRow(
    gone,
    { title: [], agent: [{ text: 'Old', hit: true }], snippet: null, snippetFrom: null, matchedAt: null },
    now,
  );
  assert.deepEqual(byName.agent, [{ text: 'Old', hit: true }]);
  assert.equal(byName.agentDeleted, true);
});

// ── 목록 몸통·관리 화면 (2026-10-10) ──

const many = (n: number): Conversation[] => Array.from({ length: n }, (_, i) => conv({ id: n - i, interactionId: `i${i}` }));

test('최근 채팅: 5개부터, [더 보기] 는 5개씩 늘리고 받아 둔 것이 모자랄 때만 다음 쪽을 받는다, [접기] 는 5개보다 많을 때만', () => {
  const first = recentWindow(many(12), RECENT_CONVERSATION_STEP, null);
  assert.deepEqual([first.rows.length, first.more, first.less], [5, true, false]);
  const all = recentWindow(many(12), 15, null);
  assert.deepEqual([all.rows.length, all.more, all.less], [12, false, true]);
  assert.equal(recentWindow(many(5), 5, 'c1').more, true, '받아 둔 것은 다 보였어도 서버에 다음 쪽이 있다');
  assert.deepEqual(moreRecent(5, 40, 'c1'), { shown: 10, fetch: false });
  assert.deepEqual(moreRecent(40, 40, 'c1'), { shown: 45, fetch: true });
  assert.deepEqual(moreRecent(40, 40, null), { shown: 45, fetch: false });
});

function threeLists(): ChatLists {
  const group = (workflowId: string, conversationCount: number, lastInteractionId: string, lastTitle: string): ConversationAgent => ({
    workflowId,
    workflowName: workflowId,
    conversationCount,
    lastActivity: '2026-10-01T00:00:00Z',
    lastTitle,
    lastInteractionId,
    agentDeleted: false,
    agentOwnerId: 7,
  });
  const a1 = conv({ id: 3, interactionId: 'a1', workflowId: 'wf-a', title: '첫' });
  const b1 = conv({ id: 2, interactionId: 'b1', workflowId: 'wf-b', title: '둘' });
  const a2 = conv({ id: 1, interactionId: 'a2', workflowId: 'wf-a', title: '셋' });
  return {
    recent: { items: [a1, b1, a2], cursor: null, pages: 1, deletedCount: 0 },
    agents: [group('wf-a', 2, 'a1', '첫'), group('wf-b', 1, 'b1', '둘')],
    drill: { agent: group('wf-a', 2, 'a1', '첫'), list: { items: [a1, a2], cursor: null, pages: 1, deletedCount: 0 } },
  };
}

test('이름 바꾸기: 최근 채팅·에이전트의 마지막 대화 제목·들어간 화면이 함께 바뀌고 다시 읽지 않는다', () => {
  const up = applyChatListChanges(threeLists(), [
    { type: 'renamed', workflowId: 'wf-a', interactionId: 'a1', title: '새 이름', customTitle: true },
  ]);
  assert.equal(up.lists.recent?.items[0].title, '새 이름');
  assert.equal(up.lists.agents?.[0].lastTitle, '새 이름');
  assert.equal(up.lists.drill?.list?.items[0].title, '새 이름');
  assert.deepEqual([up.reloadRecent, up.reloadAgents, up.reloadDrill], [false, false, false]);
});

test('지우기: 세 목록에서 빠지고 에이전트 수가 준다(0 이면 줄이 빠진다), 마지막 대화였으면 묶음을 다시 읽는다', () => {
  const up = applyChatListChanges(threeLists(), [
    { type: 'removed', workflowId: 'wf-a', interactionId: 'a2' },
    { type: 'removed', workflowId: 'wf-b', interactionId: 'b1' },
  ]);
  assert.deepEqual(up.lists.recent?.items.map((c) => c.interactionId), ['a1']);
  assert.deepEqual(up.lists.agents?.map((a) => [a.workflowId, a.conversationCount]), [['wf-a', 1]]);
  assert.deepEqual(up.lists.drill?.list?.items.map((c) => c.interactionId), ['a1']);
  assert.equal(up.reloadAgents, false);
  const last = applyChatListChanges(threeLists(), [{ type: 'removed', workflowId: 'wf-a', interactionId: 'a1' }]);
  assert.equal(last.reloadAgents, true, '새 마지막 대화는 서버만 안다');
});

test('선택 삭제: 4개씩 함께 보내고 실패한 것은 따로 모은다, 안내는 실패 수가 먼저', async () => {
  let inFlight = 0;
  let peak = 0;
  const res = await removeInBatches(Array.from({ length: 10 }, (_, i) => i), async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    if (n === 2 || n === 7) throw new Error('fail');
  });
  assert.equal(peak, DELETE_CONCURRENCY);
  assert.deepEqual(res.failed, [2, 7]);
  assert.equal(res.done.length, 8);
  assert.equal(deleteResultNotice(res.done.length, res.failed.length), '채팅 2개는 삭제하지 못했습니다.');
  assert.equal(deleteResultNotice(3, 0), '채팅 3개를 삭제했습니다.');
});

test('시작 화면에 넘겨받은 에이전트: 고를 수 있는 목록에 없으면 평소처럼 시작한다', () => {
  const list = [{ workflowId: 'wf-a' }, { workflowId: 'wf-b' }];
  assert.equal(keepPresetAgent('wf-a', list), true);
  assert.equal(keepPresetAgent('wf-gone', list), false);
});
