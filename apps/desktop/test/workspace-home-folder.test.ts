/**
 * 클라우드 안 이 PC 의 폴더 — `{XgenCloud}/{PC 이름}/(파일)`.
 *
 * 예전에는 모든 PC 가 클라우드 루트를 그대로 썼다. 그래서 PC 를 두 대 쓰면
 * 파일이 한 트리에 섞였고, 웹은 기기 id 앞 8자(`b5b5f5cf`)를 PC 이름인 줄
 * 알고 보여줬다.
 *
 * 여기서 고정하는 것:
 *
 *   1. **폴더 이름은 서버가 정한다.** 커넥터가 hostname 으로 흉내 내면
 *      (구분자 제거 규칙까지 다시 구현하면) 서버가 아는 폴더와 어긋난다.
 *   2. **비어 있어도 만들어 둔다.** 폴더가 안 보이면 사용자는 루트에 떨어뜨리고,
 *      그러면 원래 문제로 돌아간다.
 *   3. **이름 없는 기기에는 만들지 않는다** — 재연결로 이름부터 받아야 한다.
 *   4. **모르면 아무 말도 하지 않는다.** 조회에 실패했다고 멀쩡한 연결을
 *      "재연결 필요"로 표시하면 사용자는 되는 것을 다시 맺는다.
 *   5. 실패가 드라이브를 막지 않는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../src/main/workspace-manager'
import type { WorkspaceApi } from '../src/main/workspace-backend'

function api(made: string[], opts: { mkdirFails?: boolean } = {}): WorkspaceApi {
  return {
    async changes() {
      return { changes: [] }
    },
    async download() {},
    async put() {
      return { sha256: '' }
    },
    async del() {},
    async mkdir(p: string) {
      if (opts.mkdirFails) throw new Error('서버 없음')
      made.push(p)
    },
  }
}

type Probe = (a: WorkspaceApi | null) => Promise<WorkspaceApi | null>

function harness(
  cloudProbe: WorkspaceManagerDeps['cloudProbe'],
  userApi: WorkspaceApi,
): { m: WorkspaceManager; probe: Probe } {
  const deps: WorkspaceManagerDeps = {
    config: () => ({ root: '/tmp/xgen-home-test', agents: [] }) as never,
    apiFor: () => userApi,
    loggedIn: () => true,
    userApi: () => userApi,
    cloudProbe,
  }
  const m = new WorkspaceManager(deps)
  return { m, probe: (m as unknown as { probeUserStorage: Probe }).probeUserStorage.bind(m) }
}

test('서버가 정한 이름으로 이 PC 의 폴더를 만들어 둔다', async () => {
  const made: string[] = []
  const a = api(made)
  const { m, probe } = harness(
    async () => ({ needsReconnect: false, homeFolder: 'Jang_LAB' }),
    a,
  )
  await probe(a)
  assert.deepEqual(made, ['Jang_LAB'], '이 PC 의 폴더가 만들어지지 않았다')
  assert.equal(m.status().homeFolder, 'Jang_LAB', '화면이 폴더를 알 수 없다')
  assert.equal(m.status().needsReconnect, false)
})

test('이름 없는 기기는 폴더를 만들지 않고 재연결을 고지한다', async () => {
  const made: string[] = []
  const a = api(made)
  const { m, probe } = harness(
    async () => ({ needsReconnect: true, homeFolder: 'PC-b5b5f5cf' }),
    a,
  )
  await probe(a)
  assert.deepEqual(made, [], 'id 로 만든 임시 폴더가 클라우드에 남는다')
  assert.equal(m.status().needsReconnect, true)
  assert.match(m.status().reconnectReason ?? '', /다시 연결/, '고칠 방법을 말해야 한다')
})

test('조회에 실패하면 아무 말도 하지 않는다', async () => {
  const made: string[] = []
  const a = api(made)
  const { m, probe } = harness(async () => null, a)
  await probe(a)
  assert.equal(m.status().needsReconnect, false, '모르면서 경고하면 멀쩡한 연결을 다시 맺는다')
  assert.equal(m.status().homeFolder, undefined)
  assert.deepEqual(made, [])
})

test('조회가 예외를 던져도 드라이브는 계속 붙어 있다', async () => {
  const a = api([])
  const { m, probe } = harness(async () => {
    throw new Error('네트워크')
  }, a)
  assert.equal(await probe(a), a, '조회 실패가 루트를 떼면 파일이 사라진 것처럼 보인다')
  assert.equal(m.status().needsReconnect, false, '모르면서 경고하면 안 된다')
})

test('폴더 생성 실패가 드라이브를 막지 않는다', async () => {
  const a = api([], { mkdirFails: true })
  const { m, probe } = harness(
    async () => ({ needsReconnect: false, homeFolder: 'Jang_LAB' }),
    a,
  )
  assert.equal(await probe(a), a, '폴더 하나 때문에 드라이브가 안 붙으면 안 된다')
  // 폴더는 못 만들었어도 이름은 안다 — 화면이 어디에 넣어야 하는지 말할 수 있다.
  assert.equal(m.status().homeFolder, 'Jang_LAB')
})

test('프로브가 없으면 이 기능 전체가 조용히 빠진다 (구버전 배선 호환)', async () => {
  const made: string[] = []
  const a = api(made)
  const { m, probe } = harness(undefined, a)
  assert.equal(await probe(a), a)
  assert.deepEqual(made, [])
  assert.equal(m.status().needsReconnect, false)
})
