/**
 * 인증 자가치유 계약 — 게이트웨이는 토큰 회전/세션 회수 때 **이전 세션 키를
 * 지운다**. 폐기된 토큰을 든 장수명 소비자(소켓, MCP 브릿지)가 refresh 없이
 * 재시도만 반복하면 영구 401/403 이다 — 실기에서 채팅은 되는데 WS 만 죽고,
 * 브릿지가 안 붙어 에이전트에 로컬 도구가 전혀 노출되지 않던 원인. 여기서
 * 그 치유의 중심인 ensureFreshAuth 를 고정한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { XgenClient } from '@dex/protocol'

// ── core: ensureFreshAuth single-flight + 회전 알림 ─────────────────────

test('ensureFreshAuth 는 동시 호출을 한 번의 refresh 로 합치고 회전을 알린다', async () => {
  let refreshCalls = 0
  const rotations: string[] = []
  const fetchFake = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/auth/refresh')) {
      refreshCalls += 1
      return new Response(
        JSON.stringify({ success: true, access_token: `fresh-${refreshCalls}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const c = new XgenClient({
    baseUrl: 'http://server',
    fetch: fetchFake,
    accessToken: 'old',
    refreshToken: 'rt-1',
    onTokensRotated: (access) => rotations.push(access),
  })
  const [a, b, d] = await Promise.all([
    c.ensureFreshAuth(),
    c.ensureFreshAuth(),
    c.ensureFreshAuth(),
  ])
  assert.equal(refreshCalls, 1, '동시 401 들이 refresh 를 여러 번 태웠다 — 서로의 세션을 지운다')
  assert.equal(a, 'fresh-1')
  assert.equal(b, 'fresh-1')
  assert.equal(d, 'fresh-1')
  assert.deepEqual(rotations, ['fresh-1'], '회전 알림(keychain 갱신 신호)이 안 나갔다')
  assert.equal(c.getAccessTokenAfterRotation(), 'fresh-1')
})

test('ensureFreshAuth 는 인메모리 refresh 토큰이 없으면 fallback(keychain)을 쓴다', async () => {
  let sawRefreshToken = ''
  const fetchFake = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/auth/refresh')) {
      sawRefreshToken = (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token
      return new Response(JSON.stringify({ success: true, access_token: 'fresh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const c = new XgenClient({ baseUrl: 'http://server', fetch: fetchFake })
  assert.equal(await c.ensureFreshAuth(), null, 'refresh 토큰이 아예 없으면 null (재로그인 대상)')
  assert.equal(await c.ensureFreshAuth('kc-refresh'), 'fresh')
  assert.equal(sawRefreshToken, 'kc-refresh')
})
