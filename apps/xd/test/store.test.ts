import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, Store, titleFrom } from '../src/main/store';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'xd-store-')), 'xd.db');

function clock(start = 1_000) {
  let t = start;
  return () => (t += 1);
}

test('새 DB 는 최신 판으로 만들어지고, 다시 열어도 그대로다', () => {
  const file = dbFile();
  const a = new Store(file);
  const v = (a.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  assert.equal(v, SCHEMA_VERSION);
  a.close();
  const b = new Store(file);
  assert.deepEqual(b.listAgents(), []);
  b.close();
});

test('앱을 껐다 켜도 대화가 이어진다', () => {
  const file = dbFile();
  const s1 = new Store(file, { now: clock() });
  const agent = s1.createAgent({ name: '리서치', workspace: '리서치', model: 'm', folders: ['/x'], options: { temperature: 0.2 } });
  const conv = s1.createConversation(agent.id);
  const t1 = s1.startTurn(conv.id, '첫 질문\n둘째 줄');
  s1.finishTurn(t1.id, { answer: '첫 답', process: [{ type: 'tool_call', tool_name: 'Read' }], usage: { input_tokens: 3 }, status: 'done' });
  s1.close();

  const s2 = new Store(file, { now: clock(5_000) });
  const [again] = s2.listAgents();
  assert.equal(again.name, '리서치');
  assert.deepEqual(again.folders, ['/x']);
  assert.deepEqual(again.options, { temperature: 0.2 });
  const [c] = s2.listConversations(agent.id);
  assert.equal(c.title, '첫 질문');
  const turns = s2.listTurns(conv.id);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].answer, '첫 답');
  assert.deepEqual(turns[0].process, [{ type: 'tool_call', tool_name: 'Read' }]);
  assert.deepEqual(turns[0].usage, { input_tokens: 3 });
  // 다음 턴은 이어서 번호를 받고, 엔진에 넘길 이력에 앞 턴이 들어간다.
  const t2 = s2.startTurn(conv.id, '두 번째');
  assert.equal(t2.seq, 2);
  assert.deepEqual(s2.history(conv.id), [
    { role: 'user', content: '첫 질문\n둘째 줄' },
    { role: 'assistant', content: '첫 답' },
  ]);
  s2.close();
});

test('턴 도중 앱이 꺼지면 다음 시작 때 그 턴은 interrupted 로 끝난다', () => {
  const file = dbFile();
  const s1 = new Store(file);
  const agent = s1.createAgent({ name: 'A', workspace: 'A' });
  const conv = s1.createConversation(agent.id);
  const t = s1.startTurn(conv.id, 'q');
  s1.close(); // finishTurn 없이

  const s2 = new Store(file);
  const turn = s2.getTurn(t.id);
  assert.equal(turn?.status, 'error');
  assert.equal(turn?.error?.code, 'interrupted');
  assert.ok(turn?.endedAt);
  s2.close();
});

test('이력: 답이 있는 끝난 턴만, 오래된 것부터, 끝에서 limit 개', () => {
  const s = new Store(dbFile(), { now: clock() });
  const agent = s.createAgent({ name: 'A', workspace: 'A' });
  const conv = s.createConversation(agent.id);
  for (let i = 1; i <= 4; i += 1) {
    const t = s.startTurn(conv.id, `q${i}`);
    if (i === 2) s.finishTurn(t.id, { answer: '', process: [], usage: null, status: 'error', error: { code: 'runtime', message: 'x' } });
    else s.finishTurn(t.id, { answer: `a${i}`, process: [], usage: null, status: i === 3 ? 'cancelled' : 'done' });
  }
  s.startTurn(conv.id, 'q5'); // 실행 중 — 넣지 않는다
  assert.deepEqual(
    s.history(conv.id).map((m) => m.content),
    ['q1', 'a1', 'q3', 'a3', 'q4', 'a4'],
  );
  assert.deepEqual(
    s.history(conv.id, 1).map((m) => m.content),
    ['q4', 'a4'],
  );
  s.close();
});

test('에이전트를 지우면 대화·턴이 함께 지워지고, 계정을 지우면 에이전트는 계정 없음으로 남는다', () => {
  const s = new Store(dbFile());
  const acc = s.createAccount({ kind: 'anthropic', label: '내 키' });
  const agent = s.createAgent({ name: 'A', workspace: 'A', accountId: acc.id });
  const conv = s.createConversation(agent.id);
  s.startTurn(conv.id, 'q');
  s.deleteAccount(acc.id);
  assert.equal(s.getAgent(agent.id)?.accountId, null);
  s.deleteAgent(agent.id);
  assert.equal(s.getConversation(conv.id), null);
  assert.equal((s.db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n, 0);
  s.close();
});

test('작업 공간 이름은 하나뿐(대소문자 무시)', () => {
  const s = new Store(dbFile());
  s.createAgent({ name: 'A', workspace: 'Research' });
  assert.equal(s.workspaceTaken('research'), true);
  assert.throws(() => s.createAgent({ name: 'B', workspace: 'Research' }));
  s.close();
});

test('시스템 프롬프트: 없음(null)과 일부러 비움("")을 구분한다', () => {
  const s = new Store(dbFile());
  const a = s.createAgent({ name: 'A', workspace: 'A' });
  const b = s.createAgent({ name: 'B', workspace: 'B', systemPrompt: '' });
  assert.equal(s.getAgent(a.id)?.systemPrompt, null);
  assert.equal(s.getAgent(b.id)?.systemPrompt, '');
  s.close();
});

test('더 새 판 XD 가 쓴 DB 는 열지 않는다', () => {
  const file = dbFile();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(file), /newer XD/);
});

test('설정 값은 JSON 으로 오간다', () => {
  const s = new Store(dbFile());
  assert.deepEqual(s.getSetting('x', { a: 1 }), { a: 1 });
  s.setSetting('x', { b: [1, 2] });
  s.setSetting('x', { b: [3] });
  assert.deepEqual(s.getSetting('x', null), { b: [3] });
  s.close();
});

test('채팅 검색: 제목·에이전트 이름·질문·답, 모든 낱말, 마지막으로 말한 순서, 맞은 자리 조각', () => {
  const s = new Store(dbFile(), { now: clock() });
  const sales = s.createAgent({ name: 'Sales Agent', workspace: 'sales' });
  const hr = s.createAgent({ name: 'HR Helper', workspace: 'hr' });
  const q3 = s.createConversation(sales.id);
  const t1 = s.startTurn(q3.id, '분기 매출 정리해 줘');
  s.finishTurn(t1.id, { answer: '3분기 매출은 12억입니다.', process: [], usage: null, status: 'done' });
  const love = s.createConversation(hr.id);
  const t2 = s.startTurn(love.id, '궁금');
  s.finishTurn(t2.id, { answer: '아래는 INTJ에서 설명하는 독립성입니다.', process: [], usage: null, status: 'done' });
  const t3 = s.startTurn(q3.id, '지역별로도');
  s.finishTurn(t3.id, { answer: '서울이 가장 큽니다. 100% 맞습니다.', process: [], usage: null, status: 'done' });

  const ids = (q: string) => s.searchConversations(q).hits.map((h) => h.conversation.id);
  const hit = (parts: { text: string; hit: boolean }[] | null) => (parts ?? []).filter((p) => p.hit).map((p) => p.text);

  // 답 속 낱말(대소문자 무시), 조각과 어디서 맞았는지
  const intj = s.searchConversations('intj').hits;
  assert.deepEqual(intj.map((h) => h.conversation.id), [love.id]);
  assert.equal(intj[0].match.snippetFrom, 'output');
  assert.deepEqual(hit(intj[0].match.snippet), ['INTJ']);
  assert.equal(intj[0].conversation.agentName, 'HR Helper');
  // 에이전트 이름: 그 에이전트의 대화, 마지막으로 말한 순서
  assert.deepEqual(ids('sales agent'), [q3.id]);
  assert.deepEqual(hit(s.searchConversations('sales agent').hits[0].match.agent), ['Sales', 'Agent']);
  // 낱말이 이름과 턴에 나뉘어 있어도 맞고, 모든 낱말이 있어야 한다
  assert.deepEqual(ids('sales 서울'), [q3.id]);
  assert.deepEqual(ids('매출 독립성'), []);
  // 제목(첫 질문)으로
  assert.deepEqual(hit(s.searchConversations('분기').hits[0].match.title), ['분기']);
  // LIKE 의 특수 글자는 글자 그대로
  assert.deepEqual(ids('100%'), [q3.id]);
  assert.deepEqual(ids('%'), [q3.id]);
  assert.deepEqual(ids('_'), []);
  // 빈 검색어, 수 제한
  assert.deepEqual(s.searchConversations('   ').hits, []);
  const limited = s.searchConversations('니다', 1);
  assert.equal(limited.hits.length, 1);
  assert.equal(limited.hasMore, true);
  // 지운 에이전트의 대화는 함께 사라진다
  s.deleteAgent(hr.id);
  assert.deepEqual(ids('intj'), []);
  s.close();
});

test('대화 목록: 모든 에이전트의 대화를 마지막으로 말한 순서로, 에이전트 이름과 함께', () => {
  const s = new Store(dbFile(), { now: clock() });
  const a = s.createAgent({ name: '리서치', workspace: 'a' });
  const b = s.createAgent({ name: '코딩', workspace: 'b' });
  const c1 = s.createConversation(a.id);
  s.startTurn(c1.id, '첫 질문');
  const c2 = s.createConversation(b.id);
  s.startTurn(c2.id, '둘째 질문');
  const c3 = s.createConversation(a.id); // 아직 말하지 않은 대화
  assert.deepEqual(
    s.listAllConversations().map((c) => [c.id, c.agentName, c.title]),
    [
      [c3.id, '리서치', ''],
      [c2.id, '코딩', '둘째 질문'],
      [c1.id, '리서치', '첫 질문'],
    ],
  );
  // 오래된 대화에서 다시 말하면 맨 위로 오른다
  s.startTurn(c1.id, '다시');
  assert.deepEqual(s.listAllConversations().map((c) => c.id), [c1.id, c3.id, c2.id]);
  assert.deepEqual(s.listAllConversations(2).map((c) => c.id), [c1.id, c3.id]);
  // 에이전트 이름을 바꾸면 목록도 그 이름, 에이전트를 지우면 그 대화도 빠진다(지워짐 상태는 없다)
  s.updateAgent(a.id, { name: '리서치 2' });
  assert.equal(s.listAllConversations()[0].agentName, '리서치 2');
  s.deleteAgent(b.id);
  assert.deepEqual(s.listAllConversations().map((c) => c.id), [c1.id, c3.id]);
  s.close();
});

test('대화 목록: 같은 시각이면 나중에 생긴 대화가 위, 그것도 같으면 id 로 늘 같은 순서', () => {
  const s = new Store(dbFile(), { now: () => 7 });
  const a = s.createAgent({ name: 'A', workspace: 'A' });
  s.createConversation(a.id, '', 'conv-a');
  s.createConversation(a.id, '', 'conv-b');
  assert.deepEqual(s.listAllConversations().map((c) => c.id), ['conv-b', 'conv-a']);
  s.close();
});

test('에이전트 필터: 그 에이전트의 대화만, 목록과 같은 순서', () => {
  const s = new Store(dbFile(), { now: clock() });
  const a = s.createAgent({ name: '리서치', workspace: 'a' });
  const b = s.createAgent({ name: '코딩', workspace: 'b' });
  const a1 = s.createConversation(a.id);
  s.startTurn(a1.id, '첫 질문');
  const b1 = s.createConversation(b.id);
  const a2 = s.createConversation(a.id);
  s.startTurn(a1.id, '다시');
  assert.deepEqual(s.listAllConversations(undefined, a.id).map((c) => [c.id, c.agentName]), [
    [a1.id, '리서치'],
    [a2.id, '리서치'],
  ]);
  assert.deepEqual(s.listAllConversations(1, a.id).map((c) => c.id), [a1.id]);
  assert.deepEqual(s.listAllConversations(undefined, b.id).map((c) => c.id), [b1.id]);
  assert.deepEqual(s.listAllConversations(undefined, 'missing'), []);
  s.close();
});

test('에이전트 묶음: 대화가 있는 에이전트마다 대화 수와 마지막 대화, 마지막으로 말한 순서, 에이전트를 지우면 빠진다', () => {
  const s = new Store(dbFile(), { now: clock() });
  const a = s.createAgent({ name: '리서치', workspace: 'a' });
  const b = s.createAgent({ name: '코딩', workspace: 'b' });
  s.createAgent({ name: '빈 에이전트', workspace: 'c' }); // 대화가 없으면 묶음에 없다([다른 에이전트])
  const rows = () => s.listConversationAgents().map((g) => [g.agentName, g.conversationCount, g.lastTitle, g.lastConversationId]);
  assert.deepEqual(rows(), []);

  const a1 = s.createConversation(a.id);
  s.startTurn(a1.id, '첫 질문');
  const b1 = s.createConversation(b.id);
  s.startTurn(b1.id, '코드 질문');
  const a2 = s.createConversation(a.id); // 아직 말하지 않은 새 대화가 이 에이전트의 마지막
  assert.deepEqual(rows(), [
    ['리서치', 2, '', a2.id],
    ['코딩', 1, '코드 질문', b1.id],
  ]);
  // 마지막으로 말한 시각 = 그 에이전트의 마지막 대화의 updatedAt
  assert.equal(s.listConversationAgents()[0].lastActivity, s.getConversation(a2.id)?.updatedAt);

  // 다른 에이전트에서 말하면 그 에이전트가 맨 위로, 옛 대화에서 다시 말하면 그 대화가 마지막
  s.startTurn(b1.id, '다시');
  assert.deepEqual(rows()[0], ['코딩', 1, '코드 질문', b1.id]);
  s.startTurn(a1.id, '이어서');
  assert.deepEqual(rows(), [
    ['리서치', 2, '첫 질문', a1.id],
    ['코딩', 1, '코드 질문', b1.id],
  ]);

  // 이름 바꾸기는 제목만(순서는 그대로), 에이전트 이름을 바꾸면 묶음도 그 이름
  s.renameConversation(a1.id, '조사 메모');
  s.updateAgent(b.id, { name: '코딩 2' });
  assert.deepEqual(rows(), [
    ['리서치', 2, '조사 메모', a1.id],
    ['코딩 2', 1, '코드 질문', b1.id],
  ]);

  // 마지막 대화를 지우면 수가 줄고 다음 대화가 마지막(그 시각으로 순서도 다시)
  s.deleteConversation(a1.id);
  assert.deepEqual(rows(), [
    ['코딩 2', 1, '코드 질문', b1.id],
    ['리서치', 1, '', a2.id],
  ]);

  // 에이전트를 지우면 그 대화도 지워져(ON DELETE CASCADE) 줄이 빠진다
  s.deleteAgent(b.id);
  assert.deepEqual(rows(), [['리서치', 1, '', a2.id]]);
  s.deleteConversation(a2.id);
  assert.deepEqual(rows(), []);
  s.close();
});

test('에이전트 묶음: 같은 시각이면 이름 순', () => {
  const s = new Store(dbFile(), { now: () => 7 });
  const z = s.createAgent({ name: 'Zeta', workspace: 'z' });
  const al = s.createAgent({ name: 'Alpha', workspace: 'al' });
  s.createConversation(z.id);
  s.createConversation(al.id);
  s.createConversation(al.id);
  assert.deepEqual(
    s.listConversationAgents().map((g) => [g.agentName, g.conversationCount]),
    [
      ['Alpha', 2],
      ['Zeta', 1],
    ],
  );
  s.close();
});

test('이름 바꾸기: 목록 순서는 그대로, 다음 턴이 덮지 않고, 빈 이름이면 첫 질문의 제목으로 돌아간다', () => {
  const s = new Store(dbFile(), { now: clock() });
  const a = s.createAgent({ name: 'A', workspace: 'A' });
  const older = s.createConversation(a.id);
  s.startTurn(older.id, '첫 질문\n둘째 줄');
  s.startTurn(older.id, '두 번째 질문');
  const newer = s.createConversation(a.id);
  s.startTurn(newer.id, '새 질문');
  const before = s.getConversation(older.id)!;

  const renamed = s.renameConversation(older.id, '  내 이름  ');
  assert.equal(renamed?.title, '내 이름');
  assert.equal(renamed?.updatedAt, before.updatedAt);
  assert.deepEqual(s.listAllConversations().map((c) => c.id), [newer.id, older.id]);
  assert.deepEqual(s.listConversations(a.id).map((c) => c.id), [newer.id, older.id]);

  s.startTurn(older.id, '세 번째 질문');
  assert.equal(s.getConversation(older.id)?.title, '내 이름');

  const reverted = s.renameConversation(older.id, '   ');
  assert.equal(reverted?.title, '첫 질문');

  // 아직 질문이 없는 대화는 빈 제목으로 남고, 첫 턴이 정한다
  const empty = s.createConversation(a.id);
  assert.equal(s.renameConversation(empty.id, '')?.title, '');
  s.startTurn(empty.id, '처음 묻는 것');
  assert.equal(s.getConversation(empty.id)?.title, '처음 묻는 것');

  assert.equal(s.renameConversation('missing', 'x'), null);
  s.close();
});

test('대화 제목은 첫 줄, 길면 줄인다', () => {
  assert.equal(titleFrom('  안녕\n두 번째'), '안녕');
  assert.equal(titleFrom('x'.repeat(80)).length, 60);
});
