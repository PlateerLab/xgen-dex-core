/**
 * 인증 자가치유 계약 — 게이트웨이는 토큰 회전/세션 회수 때 **이전 세션 키를
 * 지운다**. 폐기된 토큰을 든 장수명 소비자(워크스페이스 동기화 HTTP/WS, MCP
 * 브릿지)가 refresh 없이 재시도만 반복하면 영구 401/403 이다 — 실기에서 채팅은
 * 되는데 WS 만 죽고, 브릿지가 안 붙어 에이전트에 로컬 도구가 전혀 노출되지
 * 않던 원인. 여기서 세 계층의 치유 동작을 고정한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { createServer, type IncomingMessage } from 'http'
import { WebSocketServer } from 'ws'
import { HttpSyncTransport, WorkspaceWsClient } from '../src/main/sync-transport'
import { XgenClient } from '@dex/protocol'

// ── 1) HTTP 전송: 401 → refreshAuth → 새 토큰으로 1회 재발송 ────────────────

test('transportFetch 가 401 에서 refresh 후 같은 요청을 새 토큰으로 재발송한다', async () => {
  const seenAuth: string[] = []
  let refreshed = 0
  const fetchFake = (async (input: unknown, init?: RequestInit) => {
    void input
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
    seenAuth.push(auth)
    if (auth !== 'Bearer fresh-token') {
      return new Response(JSON.stringify({ detail: 'expired' }), { status: 401 })
    }
    return new Response(JSON.stringify({ latest_seq: 7, changes: [] }), { status: 200 })
  }) as typeof fetch
  const t = new HttpSyncTransport(
    {
      baseUrl: 'http://server',
      token: () => 'stale-token',
      refreshAuth: async () => {
        refreshed += 1
        return 'fresh-token'
      },
      workflowId: 'wf1',
      deviceId: 'dev1',
      fetch: fetchFake,
    },
    '/tmp',
  )
  const res = await t.changes(0)
  assert.equal(res.latest_seq, 7, '재발송이 성공 응답을 돌려주지 않았다')
  assert.equal(refreshed, 1, 'refresh 가 정확히 한 번 호출되어야 한다')
  assert.deepEqual(seenAuth, ['Bearer stale-token', 'Bearer fresh-token'])
})

test('transportFetch 는 403(권한 거부)을 재시도하지 않는다 — 서버 사유를 살린다', async () => {
  let refreshed = 0
  let calls = 0
  const fetchFake = (async () => {
    calls += 1
    return new Response(JSON.stringify({ detail: '클라우드 스토리지 기능이 비활성화되어 있습니다' }), {
      status: 403,
    })
  }) as typeof fetch
  const t = new HttpSyncTransport(
    {
      baseUrl: 'http://server',
      token: () => 'tok',
      refreshAuth: async () => {
        refreshed += 1
        return 'fresh'
      },
      workflowId: 'wf1',
      deviceId: 'dev1',
      fetch: fetchFake,
    },
    '/tmp',
  )
  await assert.rejects(() => t.changes(0), /비활성화/)
  assert.equal(refreshed, 0, '403 은 토큰을 바꿔도 같다 — refresh 를 태우면 안 된다')
  assert.equal(calls, 1)
})

// ── 2) WS: 핸드셰이크 403 → refreshAuth → 새 토큰으로 재연결 ────────────────

test('WorkspaceWsClient 가 핸드셰이크 403 에서 refresh 후 새 토큰으로 다시 붙는다', async () => {
  // 첫 업그레이드는 403 으로 거절, refresh 뒤의 재시도는 수락하는 실서버.
  const wss = new WebSocketServer({ noServer: true })
  const tokens: string[] = []
  const server = createServer()
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const auth = String(req.headers.authorization ?? '')
    tokens.push(auth)
    if (auth !== 'Bearer fresh-token') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  let refreshed = 0
  let current = 'stale-token'
  const connected = new Promise<void>((resolve) => {
    const client = new WorkspaceWsClient(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        token: () => current,
        refreshAuth: async () => {
          refreshed += 1
          current = 'fresh-token'
          return current
        },
        workflowId: 'user:1',
        deviceId: 'dev1',
      },
      'test-pc',
      () => undefined,
      (up) => {
        if (up) resolve()
      },
    )
    void client.start()
    // 테스트 종료 시 정리
    test.after(() => client.stop())
  })

  await connected
  assert.ok(refreshed >= 1, '403 이 refresh 를 태우지 않았다')
  assert.equal(tokens[0], 'Bearer stale-token')
  assert.equal(tokens[tokens.length - 1], 'Bearer fresh-token', '재연결이 새 토큰을 들지 않았다')
  wss.close()
  server.close()
})

// ── 3) core: ensureFreshAuth single-flight + 회전 알림 ─────────────────────

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
