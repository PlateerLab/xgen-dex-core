/**
 * 세션 복원 판정 — 토큰을 지울지(invalid) 지킬지(network)를 가른다.
 *
 * 게이트웨이는 만료·위조 토큰에 401 `{valid:false}` 로 답한다(dev-xgen 실측 2026-10-15).
 * 이것을 네트워크 오류로 치면 앱이 오프라인으로 보고 자동 로그인을 건너뛴다.
 * 응답이 없거나 5xx 면 일시 장애라 토큰을 지켜야 한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XgenClient } from '@dex/protocol';

type Reply = { status: number; body: unknown } | 'down';

function clientWith(routes: Record<string, Reply>) {
  return new XgenClient({
    baseUrl: 'https://xgen.example.com',
    fetch: async (url: string) => {
      const path = new URL(String(url)).pathname;
      const r = routes[path];
      if (!r || r === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  });
}

const REJECTED = { status: 401, body: { valid: false } };
const REFRESH_REJECTED = { status: 401, body: { success: false, message: 'Invalid or expired refresh token' } };

test('만료 토큰에 401 로 답하면 invalid 다 — 오프라인이 아니다', async () => {
  const c = clientWith({ '/api/auth/validate-token': REJECTED, '/api/auth/refresh': REFRESH_REJECTED });
  assert.equal(await c.restoreDetailed('old', 'old-refresh'), 'invalid');
  assert.equal(await clientWith({ '/api/auth/validate-token': REJECTED }).restoreDetailed('old'), 'invalid');
});

test('서버가 응답하지 않으면 network 다 — 토큰을 지킨다', async () => {
  assert.equal(await clientWith({}).restoreDetailed('tok', 'refresh'), 'network');
  const down = { status: 503, body: { detail: 'unavailable' } };
  assert.equal(await clientWith({ '/api/auth/validate-token': down, '/api/auth/refresh': down }).restoreDetailed('tok', 'r'), 'network');
});

test('검증은 거부됐어도 refresh 가 닿지 않으면 network 다', async () => {
  const c = clientWith({ '/api/auth/validate-token': REJECTED, '/api/auth/refresh': 'down' });
  assert.equal(await c.restoreDetailed('old', 'refresh'), 'network');
});

test('검증이 401 이어도 refresh 로 새 토큰을 받으면 valid 다', async () => {
  let validated = 0;
  const c = new XgenClient({
    baseUrl: 'https://xgen.example.com',
    fetch: async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/auth/refresh') {
        return new Response(JSON.stringify({ success: true, access_token: 'fresh' }), { status: 200 });
      }
      validated += 1;
      const { token } = JSON.parse(String(init?.body));
      return token === 'fresh'
        ? new Response(JSON.stringify({ valid: true, user_id: 7, username: 'me' }), { status: 200 })
        : new Response(JSON.stringify({ valid: false }), { status: 401 });
    },
  });
  assert.equal(await c.restoreDetailed('old', 'refresh'), 'valid');
  assert.equal(c.getAccessTokenAfterRotation(), 'fresh');
  assert.equal(validated, 2);
});
