/**
 * 서버가 준 실패 사유를 **살려서** 사용자에게 보여준다.
 *
 * 실기 사고: 관리자가 조직 전체에서 클라우드 스토리지를 끄면 서버는 403 과
 * 함께 "클라우드 스토리지 기능이 비활성화되어 있습니다" 를 주는데, 커넥터에는
 * `changes HTTP 403` 만 남아 사용자에게는 그냥 "연결 불가" 로 보였다. 어디서
 * 껐는지도, 무엇을 해야 하는지도 알 수 없었다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { createServer, type Server } from 'http'
import { readFileSync } from 'fs'
import { HttpSyncTransport } from '../src/main/sync-transport'

/** 서버의 403 응답을 흉내내는 로컬 HTTP 서버. */
async function withServer(
  status: number,
  body: string,
  fn: (t: HttpSyncTransport) => Promise<void>,
): Promise<void> {
  const srv: Server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  const t = new HttpSyncTransport(
    { baseUrl: `http://127.0.0.1:${port}`, token: async () => 't', workflowId: 'user:7', deviceId: 'd' },
    '/tmp/xgen-test-staging',
  )
  try {
    await fn(t)
  } finally {
    await new Promise<void>((r) => srv.close(() => r()))
  }
}

// 서버(xgen-workflow)가 실제로 주는 두 사유 — 실행으로 확인한 문자열이다.
const ORG_OFF = '클라우드 스토리지 기능이 비활성화되어 있습니다'
const USER_OFF = '내 클라우드 스토리지가 켜져 있지 않습니다'

test('조직 전체가 꺼졌을 때 그 사유가 그대로 올라온다', async () => {
  await withServer(403, JSON.stringify({ detail: ORG_OFF }), async (t) => {
    const e = await t.changes(0).then(
      () => null,
      (err) => err as Error & { status: number },
    )
    assert.ok(e, '실패해야 한다')
    assert.equal(e!.status, 403)
    assert.ok(e!.message.includes(ORG_OFF), `사유가 사라졌다: ${e!.message}`)
  })
})

test('본인 설정이 꺼졌을 때도 사유가 올라온다', async () => {
  await withServer(403, JSON.stringify({ detail: USER_OFF }), async (t) => {
    const e = await t.changes(0).then(
      () => null,
      (err) => err as Error,
    )
    assert.ok(e!.message.includes(USER_OFF), `사유가 사라졌다: ${e!.message}`)
  })
})

test('본문이 비어도 상태코드는 남는다', async () => {
  await withServer(403, '', async (t) => {
    const e = await t.changes(0).then(
      () => null,
      (err) => err as Error & { status: number },
    )
    assert.equal(e!.status, 403)
    assert.match(e!.message, /403/)
  })
})

test('JSON 이 아닌 본문도 버리지 않는다', async () => {
  await withServer(502, 'upstream is down', async (t) => {
    const e = await t.changes(0).then(
      () => null,
      (err) => err as Error,
    )
    assert.ok(e!.message.includes('upstream is down'), e!.message)
  })
})

test('사유를 버리는 지점이 남아 있지 않다', () => {
  // 상태코드만 남기면 원인이 전송 계층에서 소멸한다.
  const src = readFileSync(new URL('../src/main/sync-transport.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const bare = src.match(/new Error\(`\w[\w ]* HTTP \$\{[^}]+\}`\)/g) ?? []
  assert.deepEqual(bare, [], `서버 사유를 버리는 지점이 남았다: ${bare.join(', ')}`)
})

test('안내 문구가 두 경우를 모두 덮는다', () => {
  // 예전에는 조직 전체가 꺼졌을 때도 "마이페이지에서 켜라"고만 해서, 사용자가
  // 이미 켜져 있는 자기 설정만 들여다보게 만들었다.
  const ui = readFileSync(
    new URL('../src/renderer/src/views/SyncSettings.tsx', import.meta.url),
    'utf8',
  )
  assert.ok(ui.includes('마이페이지'), '본인 설정 안내가 없다')
  assert.ok(ui.includes('관리자'), '조직 전체가 꺼진 경우 안내가 없다')
})
