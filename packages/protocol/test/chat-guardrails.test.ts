/**
 * 채팅 안전 장치 — 서버가 정하는 것을 앱이 제 나름으로 바꾸지 않는가.
 *
 * 여기서 막는 사고: 문자열 "false" 를 참으로 읽어 꺼 둔 문구가 켜지는 것, 조회 실패를
 * "꺼짐" 으로 읽어 있어야 할 안내가 조용히 사라지는 것.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatGuardrailsApi, ChatInputGate, chatInputNotice, coerceConfigBool } from '../src/chat-guardrails';

const http = (impl: Partial<{ get: (p: string) => Promise<unknown>; post: (p: string, b?: unknown) => Promise<unknown> }>) =>
  ({
    get: impl.get ?? (async () => ({})),
    post: impl.post ?? (async () => ({})),
    put: async () => ({}),
    del: async () => ({}),
  }) as never;

test('설정 값의 여러 모양을 같은 뜻으로 읽는다', () => {
  assert.equal(coerceConfigBool('false', true), false);
  assert.equal(coerceConfigBool('ON', false), true);
  assert.equal(coerceConfigBool(0, true), false);
  assert.equal(coerceConfigBool(undefined, true), true, '모르면 기본값');
  assert.equal(coerceConfigBool('알 수 없는 값', false), false);
});

test('면책 문구는 설정을 읽어 정하고, 못 읽으면 보인다', async () => {
  const off = new ChatGuardrailsApi(http({ get: async () => ({ current_value: 'false' }) }));
  assert.equal(await off.disclaimerEnabled(), false);
  const broken = new ChatGuardrailsApi(http({ get: async () => { throw new Error('offline'); } }));
  assert.equal(await broken.disclaimerEnabled(), true, '못 읽었다고 안내를 빼지 않는다');
});

test('입력창 사전 검사는 서버 판정을 그대로 옮기고, 빈 글은 묻지 않는다', async () => {
  const sent: Array<{ path: string; body: unknown }> = [];
  const api = new ChatGuardrailsApi(
    http({
      post: async (path, body) => {
        sent.push({ path, body });
        return {
          blocked: true, kinds: ['pii'], message: '개인정보(전화번호)가 들어 있어 보낼 수 없습니다.',
          masked_kinds: [], notice: '', checked: true,
        };
      },
    }),
  );
  assert.equal((await api.checkInput('   ', 'wf_1')).blocked, false);
  assert.equal(sent.length, 0);
  const res = await api.checkInput('번호 010-1234-5678', 'wf_1');
  assert.equal(res.blocked, true);
  assert.deepEqual(res.kinds, ['pii']);
  assert.deepEqual(sent[0], { path: '/api/chat/input-check', body: { text: '번호 010-1234-5678', workflow_id: 'wf_1' } });
  assert.deepEqual(chatInputNotice(res), { tone: 'block', text: '개인정보(전화번호)가 들어 있어 보낼 수 없습니다.' });
});

test('검사기가 없거나 실패하면 막지 않는다(보낼 때 서버가 다시 본다)', async () => {
  const api = new ChatGuardrailsApi(http({ post: async () => { throw new Error('404'); } }));
  const res = await api.checkInput('아무 말', 'wf_1');
  assert.equal(res.blocked, false);
  assert.equal(res.checked, false);
});

test('문지기는 글마다 판정을 기억하고, 판정하지 못한 결과는 기억하지 않는다', async () => {
  let calls = 0;
  let healthy = false;
  const gate = new ChatInputGate(async (text) => {
    calls += 1;
    if (!healthy) return { blocked: false, kinds: [], message: '', maskedKinds: [], notice: '', checked: false };
    return { blocked: text.includes('바보'), kinds: ['forbidden_word'], message: '금칙어(욕설)가 들어 있어 보낼 수 없습니다.',
      maskedKinds: [], notice: '', checked: true };
  });
  assert.equal(await gate.allows('바보', 'wf'), true, '판정하지 못하면 막지 않는다');
  healthy = true;
  assert.equal(await gate.allows('바보', 'wf'), false, '못 한 판정은 기억하지 않아 다시 묻는다');
  assert.equal(await gate.allows('바보', 'wf'), false);
  assert.equal(calls, 2, '세 번째는 묻지 않고 기억을 쓴다');
});
