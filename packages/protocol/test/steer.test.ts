/**
 * 도는 턴에 넣은 사용자 메시지(steer) — xgen-workflow turn_steer 의 결말 이벤트·히스토리·보내기.
 *
 * 들어간 말은 답의 몇 번째 글자 뒤(offset)에 들어갔는지와 함께 온다. 앱·웹이 같은 규칙으로 그 자리에서
 * 답을 나눠 그린다(splitBySteers). 보내기는 받았는가만 답하고 던지지 않는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TURN_EVENT_NAMES,
  parseHistorySteers,
  parseSteerOutcome,
  splitBySteers,
  turnEventToChatEvent,
} from '@dex/protocol';
import { HttpClient } from '../src/client';
import { ChatApi } from '../src/chat';
import { HistoryApi } from '../src/history';

test('steer 는 정본 이벤트다 — 서버가 내면 모든 표면이 받는다', () => {
  assert.ok((TURN_EVENT_NAMES as readonly string[]).includes('steer'));
});

test('들어간 메시지는 자리와 함께, 돌아온 메시지는 자리 없이 읽힌다', () => {
  assert.deepEqual(
    turnEventToChatEvent('steer', { status: 'delivered', id: 'm1', client_msg_id: 'c1', text: '테스트도', offset: 12.9 }),
    { kind: 'steer', steer: { status: 'delivered', id: 'm1', clientMsgId: 'c1', text: '테스트도', offset: 12 } },
  );
  assert.deepEqual(
    turnEventToChatEvent('steer', { status: 'rejected', client_msg_id: 'c2', text: '늦음', offset: 3 }),
    { kind: 'steer', steer: { status: 'rejected', clientMsgId: 'c2', text: '늦음' } },
  );
  assert.equal(turnEventToChatEvent('steer', { status: 'queued', text: 'x' }), null);
  assert.equal(parseSteerOutcome(null), null);
});

test('히스토리의 steers — 깨진 항목은 버리고 자리는 0 이상 정수', () => {
  assert.deepEqual(
    parseHistorySteers([
      { text: '추가', offset: 4.2, client_msg_id: 'c1' },
      { text: '  ' },
      'garbage',
      { text: '음수', offset: -3 },
    ]),
    [{ text: '추가', offset: 4, clientMsgId: 'c1' }, { text: '음수', offset: 0 }],
  );
  assert.deepEqual(parseHistorySteers(undefined), []);
});

test('splitBySteers — 자리 순서대로, 같은 자리는 넣은 순서, 긴 자리는 끝, 전달 대기는 맨 끝', () => {
  const view = (parts: ReturnType<typeof splitBySteers<{ text: string; offset?: number }>>) =>
    parts.map((p) => (p.kind === 'text' ? `T:${p.text}` : `S:${p.steer.text}`));
  assert.deepEqual(view(splitBySteers('abcdef', [
    { text: '둘', offset: 4 }, { text: '하나', offset: 2 }, { text: '하나-2', offset: 2 }, { text: '대기' }, { text: '끝', offset: 99 },
  ])), ['T:ab', 'S:하나', 'S:하나-2', 'T:cd', 'S:둘', 'T:ef', 'S:끝', 'S:대기']);
  assert.deepEqual(view(splitBySteers('그대로', undefined)), ['T:그대로']);
});

function api(respond: (url: URL, body: unknown) => Response) {
  const seen: Array<{ url: URL; body: unknown }> = [];
  const http = new HttpClient({
    baseUrl: 'https://x.example',
    fetch: async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url: u, body });
      return respond(u, body);
    },
  });
  return { chat: new ChatApi(http), history: new HistoryApi(http), seen };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

test('ChatApi.steer — 경로·본문, 서버의 답을 그대로, 모르는 답·오류는 failed', async () => {
  const ok = api(() => json({ status: 'queued' }));
  assert.equal(await ok.chat.steer('conv / 1', '테스트도 돌려 줘', 'c-1'), 'queued');
  assert.equal(ok.seen[0].url.pathname, '/api/agentflow/execute/steer/conv%20%2F%201');
  assert.deepEqual(ok.seen[0].body, { text: '테스트도 돌려 줘', client_msg_id: 'c-1' });

  for (const status of ['not_running', 'closed', 'unsupported', 'invalid'] as const) {
    assert.equal(await api(() => json({ status })).chat.steer('c', 'x'), status);
  }
  assert.equal(await api(() => json({ status: 'weird' })).chat.steer('c', 'x'), 'failed');
  assert.equal(await api(() => json({ detail: 'nope' }, 404)).chat.steer('c', 'x'), 'failed');
  const none = api(() => json({}));
  assert.equal(await none.chat.steer('c', '   '), 'invalid');
  assert.equal(await none.chat.steer('  ', 'x'), 'invalid');
  assert.equal(none.seen.length, 0);
});

test('히스토리 턴이 steers 를 싣는다 — 없는 턴의 모양은 예전과 같다', async () => {
  const h = api(() => json({
    in_out_logs: [
      { log_id: 1, io_id: 10, interaction_id: 'i', workflow_id: 'w', workflow_name: 'n', input_data: '질문', output_data: '{"result":"답"}', updated_at: 't',
        steers: [{ text: '추가', offset: 1, client_msg_id: 'c1' }] },
      { log_id: 2, io_id: 11, interaction_id: 'i', workflow_id: 'w', workflow_name: 'n', input_data: '두번째', output_data: '{"result":"답2"}', updated_at: 't' },
    ],
  }));
  const turns = await h.history.turns('w', 'i');
  assert.deepEqual(turns[0].steers, [{ text: '추가', offset: 1, clientMsgId: 'c1' }]);
  assert.equal('steers' in turns[1], false);
});
