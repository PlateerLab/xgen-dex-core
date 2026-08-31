/**
 * 새 최상위 클라우드 폴더(=새 저장소) 생성 — RAG 시스템 통제가 켜져 있으면
 * 서버(xgen-workflow geny_workspace.storage_mkdir)는 실제로 아무것도 만들지
 * 않고 HTTP 200 과 함께 `{ok:true, status:"pending_approval", request_id, path}`
 * 를 돌려준다(폴더는 관리자 승인 뒤에야 생긴다).
 *
 * 예전 transport 는 `res.ok` 만 보고 성공으로 처리했다 — 그러면 드라이브에는
 * 폴더가 생긴 것처럼 보이는데 서버·다른 기기·웹 어디에도 없는 유령 폴더가
 * 된다. mkdir() 은 이 신호를 반드시 ApprovalPendingError 로 던져야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { createServer, type Server } from 'http'
import { HttpSyncTransport } from '../src/main/sync-transport'
import { ApprovalPendingError } from '../src/main/sync-protocol'

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

test('승인 대기(HTTP 200 + pending_approval)는 성공이 아니라 ApprovalPendingError 다', async () => {
  await withServer(
    200,
    JSON.stringify({ ok: true, status: 'pending_approval', request_id: 42, path: '새저장소' }),
    async (t) => {
      const e = await t.mkdir('새저장소').then(
        () => null,
        (err) => err,
      )
      assert.ok(e instanceof ApprovalPendingError, `pending_approval 이 성공으로 처리됐다: ${e}`)
      assert.equal((e as ApprovalPendingError).requestId, 42)
      assert.match((e as Error).message, /승인/)
    },
  )
})

test('일반 성공(HTTP 200, status 없음)은 그대로 성공이다', async () => {
  await withServer(200, JSON.stringify({ ok: true, path: '기존폴더/하위' }), async (t) => {
    await t.mkdir('기존폴더/하위') // reject 하면 테스트 자체가 실패한다
  })
})

test('201 Created 도 성공이다 (본문 없음/다른 형태)', async () => {
  await withServer(201, '', async (t) => {
    await t.mkdir('새폴더')
  })
})

test('409(이미 존재)는 여전히 성공 취급이다 — 회귀 방지', async () => {
  await withServer(409, JSON.stringify({ detail: 'exists' }), async (t) => {
    await t.mkdir('기존폴더')
  })
})
