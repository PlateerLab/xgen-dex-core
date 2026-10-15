/**
 * 앱 모음(agent-app-store) — 데스크톱 [앱] 탭이 웹 [Agent APP] 과 **같은 엔드포인트**를
 * 같은 규칙으로 부르는지.
 *
 * 두 화면이 다른 경로·다른 쿼리를 쓰면 같은 계정에서 서로 다른 목록을 보게 된다. 빠진
 * 칸을 채우는 것도 여기서 지킨다: 옛 서버나 부분 응답에서 화면이 넘어지지 않아야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { AgentDataApi, APP_STORE_PAGE_SIZE } from '@dex/protocol/agent-data'

function fakeHttp(reply: unknown) {
  const paths: string[] = []
  const http = {
    get<T>(path: string): Promise<T> {
      paths.push(path)
      return Promise.resolve(reply as T)
    },
  }
  return { api: new AgentDataApi(http as never), paths }
}

test('[내 앱] 은 /agent-app-store/mine 하나로 읽는다', async () => {
  const app = { slug: 'a', title: 'A', shared: true, workflow_id: 'wf', workflow_name: 'W' }
  const { api, paths } = fakeHttp({ apps: [app], agents: [], total: 1, shared: 1, failed: ['X'] })
  const res = await api.appStoreMine()
  assert.deepEqual(paths, ['/api/agentflow/agent-app-store/mine'])
  assert.equal(res.apps.length, 1)
  assert.deepEqual(res.failed, ['X'])
})

test('[내 앱] 의 빠진 칸은 비운 값으로 채운다', async () => {
  const { api } = fakeHttp({ apps: [{ slug: 'a', shared: true }, { slug: 'b', shared: false }] })
  const res = await api.appStoreMine()
  assert.deepEqual(res.agents, [])
  assert.deepEqual(res.failed, [])
  assert.equal(res.total, 2)
  assert.equal(res.shared, 1)
})

test('[앱 스토어] 는 웹과 같은 쿼리를 보낸다', async () => {
  const { api, paths } = fakeHttp({ items: [], total: 0, page: 2, page_size: 24 })
  await api.appStoreList({ search: '  매출 ', scope: 'mine', page: 2 })
  const url = new URL(paths[0], 'http://x')
  assert.equal(url.pathname, '/api/agentflow/agent-app-store/list')
  assert.equal(url.searchParams.get('search'), '매출')
  assert.equal(url.searchParams.get('scope'), 'mine')
  assert.equal(url.searchParams.get('page'), '2')
  assert.equal(url.searchParams.get('page_size'), String(APP_STORE_PAGE_SIZE))
})

test('[앱 스토어] 는 빈 검색어를 보내지 않고 잘못된 쪽 번호를 1로 본다', async () => {
  const { api, paths } = fakeHttp({})
  const res = await api.appStoreList({ search: '   ', page: Number.NaN })
  const url = new URL(paths[0], 'http://x')
  assert.equal(url.searchParams.has('search'), false)
  assert.equal(url.searchParams.get('scope'), 'all')
  assert.equal(url.searchParams.get('page'), '1')
  assert.deepEqual(res, { items: [], total: 0, page: 1, page_size: APP_STORE_PAGE_SIZE })
})
