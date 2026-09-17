/**
 * 채팅 안전 장치 — 서버가 정하는 것을 앱이 제 나름으로 바꾸지 않는가.
 *
 * 여기서 막는 사고: 문자열 "false" 를 참으로 읽어 꺼 둔 문구가 켜지는 것, 조회 실패를
 * "꺼짐" 으로 읽어 있어야 할 안내가 조용히 사라지는 것.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatGuardrailsApi, coerceConfigBool } from '../src/chat-guardrails';

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

test('민감정보 검사는 서버 판정을 그대로 옮기고, 빈 글은 묻지 않는다', async () => {
  let calls = 0;
  const api = new ChatGuardrailsApi(
    http({
      post: async () => {
        calls += 1;
        return { pii: true, forbidden: false, flagged: true };
      },
    }),
  );
  assert.deepEqual(await api.checkContent('   '), { pii: false, forbidden: false, flagged: false });
  assert.equal(calls, 0);
  assert.deepEqual(await api.checkContent('주민등록번호 900101-1234567'), {
    pii: true,
    forbidden: false,
    flagged: true,
  });
});

test('검사기가 없으면 경고하지 않는다 — 보내는 것을 막지 않는다', async () => {
  const api = new ChatGuardrailsApi(http({ post: async () => { throw new Error('404'); } }));
  assert.equal((await api.checkContent('아무 말')).flagged, false);
});
