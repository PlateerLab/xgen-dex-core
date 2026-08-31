/**
 * SSH API 계층 — 커넥터가 **서버 저장소를 그대로 통과**시키는지.
 *
 * 여기서 지키는 것은 하나다: 커넥터는 자기 사본을 만들지 않는다. 웹 마이페이지와
 * 같은 엔드포인트를 같은 규칙으로 호출해야, 어느 쪽에서 바꾸든 다른 쪽이 다음
 * 조회에서 그대로 본다. 특히 **손대지 않은 자격증명은 키 자체를 보내지 않아야**
 * 한다 — 빈 문자열을 보내면 서버는 "지워라"로 읽고, 설명만 고치려던 저장이 접속을
 * 끊는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { SshApi } from '../src/core/ssh'

interface Call {
  method: string
  path: string
  body?: unknown
}

function fakeHttp() {
  const calls: Call[] = []
  const http = {
    get<T>(path: string): Promise<T> {
      calls.push({ method: 'GET', path })
      return Promise.resolve({ enabled: false, servers: [], limits: {} } as unknown as T)
    },
    post<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: 'POST', path, body })
      return Promise.resolve({} as T)
    },
    put<T>(path: string, body?: unknown): Promise<T> {
      calls.push({ method: 'PUT', path, body })
      return Promise.resolve({} as T)
    },
    del<T>(path: string): Promise<T> {
      calls.push({ method: 'DELETE', path })
      return Promise.resolve({} as T)
    },
  }
  // SshApi 는 HttpClient 의 네 메서드만 쓴다.
  return { api: new SshApi(http as never), calls }
}

test('웹 마이페이지와 같은 경로를 쓴다', async () => {
  const { api, calls } = fakeHttp()
  await api.getConfig()
  await api.setEnabled(true)
  await api.createServer({ name: 'web' })
  await api.updateServer('web', { host: 'h' })
  await api.deleteServer('web')
  await api.testServer('web')
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /api/agentflow/user-ssh/config',
      'PUT /api/agentflow/user-ssh/config',
      'POST /api/agentflow/user-ssh/servers',
      'PUT /api/agentflow/user-ssh/servers/web',
      'DELETE /api/agentflow/user-ssh/servers/web',
      'POST /api/agentflow/user-ssh/servers/web/test',
    ],
  )
})

test('이름에 특수문자가 있어도 경로가 깨지지 않는다', async () => {
  const { api, calls } = fakeHttp()
  await api.updateServer('a.b-c_d', {})
  assert.equal(calls[0].path, '/api/agentflow/user-ssh/servers/a.b-c_d')
})

test('부분 수정 — 보내지 않은 자격증명 키는 요청 본문에 없다', async () => {
  const { api, calls } = fakeHttp()
  await api.updateServer('web', { description: 'prod' })
  const body = calls[0].body as Record<string, unknown>
  assert.deepEqual(Object.keys(body), ['description'])
  assert.ok(!('password' in body), '손대지 않은 비밀번호가 실려 나가면 서버가 지운다')
})

test('빈 문자열은 명시적 삭제라 그대로 실린다', async () => {
  const { api, calls } = fakeHttp()
  await api.updateServer('web', { password: '' })
  assert.deepEqual(calls[0].body, { password: '' })
})

test('마스터 스위치는 서버 목록을 건드리지 않는다', async () => {
  const { api, calls } = fakeHttp()
  await api.setEnabled(false)
  assert.deepEqual(calls[0].body, { enabled: false })
})

test('점프 경로는 순서 그대로 전달된다 — 순서가 곧 다이얼 순서다', async () => {
  const { api, calls } = fakeHttp()
  await api.createServer({ name: 'db', jump_via: ['edge', 'bastion'] })
  assert.deepEqual((calls[0].body as { jump_via: string[] }).jump_via, ['edge', 'bastion'])
})
