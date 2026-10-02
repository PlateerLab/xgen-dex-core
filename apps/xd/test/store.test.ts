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

test('대화 제목은 첫 줄, 길면 줄인다', () => {
  assert.equal(titleFrom('  안녕\n두 번째'), '안녕');
  assert.equal(titleFrom('x'.repeat(80)).length, 60);
});
