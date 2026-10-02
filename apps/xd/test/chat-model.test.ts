import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChatEvent, startLive, turnMessages, usedTools } from '../src/renderer/src/chat-model';
import { LiveStore } from '../src/renderer/src/live-store';
import type { XdTurn } from '../src/main/store';

const baseTurn = (over: Partial<XdTurn> = {}): XdTurn => ({
  id: 't1',
  conversationId: 'c1',
  seq: 1,
  question: '질문',
  attachments: [],
  answer: '답',
  process: [],
  usage: null,
  status: 'done',
  error: null,
  startedAt: 100,
  endedAt: 200,
  ...over,
});

test('저장된 턴 → 질문·답 메시지 (작업 과정·실패·중단)', () => {
  const tool = { eventType: 'tool_call', toolName: 'Read' };
  const [q, a] = turnMessages(baseTurn({ process: [{ kind: 'text', text: '읽어요', at: 110 }, { kind: 'tool', event: tool, at: 120 }] }));
  assert.deepEqual(q, { role: 'user', text: '질문', startedAt: 100 });
  assert.equal(a.text, '답');
  assert.deepEqual(a.tools, [tool]);
  assert.equal(a.streaming, false);
  assert.equal(usedTools(a), true);

  const [, failed] = turnMessages(baseTurn({ status: 'error', answer: '', error: { code: 'no_key', message: 'x' } }));
  assert.equal(failed.error, true);
  assert.equal(failed.errorInfo?.title, '이 제공자의 API 키가 없습니다.');
  const [, interrupted] = turnMessages(baseTurn({ status: 'error', error: { code: 'interrupted', message: 'closed' } }));
  assert.equal(interrupted.errorInfo?.title, '앱이 닫혀 답이 끝나지 않았습니다.');
  const [, cancelled] = turnMessages(baseTurn({ status: 'cancelled' }));
  assert.equal(cancelled.interrupted, true);
  assert.equal(usedTools(turnMessages(baseTurn())[1]), false);
});

test('흐르는 사건 → 답: 글 조각은 이어 붙이고, 도구는 순서대로, 끝·실패는 흐름을 멈춘다', () => {
  let m = startLive(1);
  m = applyChatEvent(m, { kind: 'text', content: '찾아' }, 2);
  m = applyChatEvent(m, { kind: 'text', content: '볼게요' }, 3);
  m = applyChatEvent(m, { kind: 'tool', event: { eventType: 'tool_call', toolName: 'Grep' } }, 4);
  m = applyChatEvent(m, { kind: 'text', content: '끝' }, 5);
  assert.equal(m.text, '찾아볼게요끝');
  assert.deepEqual(m.flow?.map((f) => f.kind), ['text', 'tool', 'text']);
  assert.equal((m.flow?.[0] as { text: string }).text, '찾아볼게요');
  assert.equal(m.lastEventAt, 5);
  assert.equal(m.streaming, true);
  const ended = applyChatEvent(m, { kind: 'end' }, 6);
  assert.equal(ended.streaming, false);
  const failed = applyChatEvent(m, { kind: 'error', detail: 'x', info: { code: 'C', title: 'T', retryable: false } }, 6);
  assert.equal(failed.error, true);
  assert.equal(failed.errorInfo?.title, 'T');
  // 모르는 사건은 그대로
  assert.equal(applyChatEvent(m, { kind: 'queued', reason: 'busy' }, 7), m);
});

test('도는 턴 저장소: 사건을 그 턴에만, 끝나면 대화의 판이 오른다', () => {
  const store = new LiveStore(() => 10);
  let bumps = 0;
  store.subscribe(() => (bumps += 1));
  store.begin('t1', 'c1', '질문');
  store.apply({ type: 'chat', turnId: 't1', conversationId: 'c1', agentId: 'a1', event: { kind: 'text', content: '안녕' } });
  store.apply({ type: 'chat', turnId: 'other', conversationId: 'c1', agentId: 'a1', event: { kind: 'text', content: '섞이면 안 됨' } });
  assert.equal(store.get('c1')?.answer.text, '안녕');
  store.apply({ type: 'approval', turnId: 't1', conversationId: 'c1', agentId: 'a1', request: 'r', command: 'rm -rf x' });
  assert.equal(store.get('c1')?.approval, 'rm -rf x');
  // 확인 창이 둘 떠 있을 때 하나에 대답해도 다른 하나의 안내는 남는다
  store.apply({ type: 'approval', turnId: 't1', conversationId: 'c1', agentId: 'a1', request: 'r2', command: 'rm -rf y' });
  store.apply({ type: 'approval_done', turnId: 't1', conversationId: 'c1', agentId: 'a1', request: 'r2', answer: 'deny' });
  assert.equal(store.get('c1')?.approval, 'rm -rf x');
  store.apply({ type: 'approval_done', turnId: 't1', conversationId: 'c1', agentId: 'a1', request: 'r', answer: 'deny' });
  assert.equal(store.get('c1')?.approval, null);
  assert.deepEqual(store.running(), ['c1']);
  store.apply({ type: 'finished', turnId: 't1', conversationId: 'c1', agentId: 'a1', turn: baseTurn() });
  assert.equal(store.get('c1'), null);
  assert.equal(store.conversationVersion('c1'), 1);
  assert.ok(bumps >= 4);
});

test('도는 턴 저장소: 보내기 대답보다 끝이 먼저 오면 "도는 중" 으로 남지 않는다', () => {
  const store = new LiveStore();
  // 엔진에 가기 전 실패 — main 이 그 자리에서 끝내 finished 가 먼저 온다.
  store.apply({ type: 'finished', turnId: 't9', conversationId: 'c9', agentId: 'a1', turn: baseTurn({ id: 't9', status: 'error' }) });
  store.begin('t9', 'c9', '질문');
  assert.equal(store.get('c9'), null);
  assert.deepEqual(store.running(), []);
});
