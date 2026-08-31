/**
 * 같은 PC 에서 계정을 갈아탈 때.
 *
 * XgenCloud 는 **XGEN 계정**으로 갈린다 — A 계정의 클라우드에 닿을 수 있는
 * 것은 A 로 로그인한 커넥터뿐이다. 그러니 로그아웃하거나 다른 계정으로
 * 로그인하면 드라이브의 내용도 정확히 그만큼 갈려야 한다.
 *
 * 여기서 고정하는 것:
 *
 *   1. 워크스페이스 설정은 **계정별**이다. 서버까지 키에 넣는다 — 사내/운영에
 *      같은 user id 가 있을 수 있고, id 만으로 묶으면 두 서버의 스토리지가 한
 *      폴더에 섞인다.
 *   2. **로그아웃은 client 를 비운 뒤에 리컨사일한다.** 순서가 뒤집히면 아직
 *      살아 있는 `client.user` 때문에 리컨사일이 "로그인 중" 으로 판단해 구
 *      계정의 마운트를 그대로 남긴다 — 로그아웃했는데 이전 계정의 파일이
 *      드라이브에 남고, 다음 계정이 그 잔상 위에 얹힌다.
 *   3. 로그인하지 않았으면 마운트하지 않는다.
 *
 * 2번은 소스 **순서**가 곧 동작이라 순서로 고정한다. 두 호출을 다 부르는
 * 것만으로는 부족했다 — 예전 코드도 둘 다 부르고 있었고, 순서만 틀렸다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { accountKey, rootConflict } from '../src/main/workspace'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../src/main/workspace-manager'

const INDEX = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf-8')

/** `from` 이후 첫 번째 `needle` 의 위치. 없으면 -1. */
function at(from: number, needle: string): number {
  return INDEX.indexOf(needle, from)
}

test('워크스페이스 설정은 계정별이고 서버까지 구분한다', () => {
  assert.notEqual(
    accountKey('https://a.xgen', '7'),
    accountKey('https://b.xgen', '7'),
    '서버가 다른데 같은 워크스페이스를 쓰면 두 서버의 파일이 섞인다',
  )
  assert.notEqual(accountKey('https://a.xgen', '7'), accountKey('https://a.xgen', '8'))
  assert.equal(accountKey('https://a.xgen/', '7'), accountKey('https://a.xgen', '7'))
})

test('두 계정이 같은 로컬 폴더를 쓰려 하면 알아챈다', () => {
  const all = { 'https://a|7': { root: '/home/u/XGEN-Workspace', agents: [] } }
  assert.equal(rootConflict(all, 'https://a|8', '/home/u/XGEN-Workspace'), 'https://a|7')
  assert.equal(rootConflict(all, 'https://a|8', '/home/u/다른곳'), null)
  // 자기 자신과는 충돌하지 않는다.
  assert.equal(rootConflict(all, 'https://a|7', '/home/u/XGEN-Workspace'), null)
})

test('로그아웃은 client 를 비운 뒤에 드라이브를 걷는다', () => {
  const handler = INDEX.indexOf('CHANNELS.authLogout')
  assert.ok(handler > 0, 'authLogout 핸들러를 찾지 못했다')
  const logout = at(handler, 'client.logout()')
  const reconcile = at(handler, 'getWorkspaceManager()?.reconcile()')
  assert.ok(logout > 0 && reconcile > 0, '두 호출이 모두 있어야 한다')
  assert.ok(
    logout < reconcile,
    '리컨사일이 먼저다 — 아직 살아 있는 client.user 때문에 구 계정 마운트가 남는다',
  )
})

test('서버를 바꿀 때도 client 를 비운 뒤에 걷는다', () => {
  const branch = INDEX.indexOf('if (serverChanged) {')
  assert.ok(branch > 0, 'serverChanged 분기를 찾지 못했다')
  const cleared = at(branch, 'client = null')
  const reconcile = at(branch, 'getWorkspaceManager()?.reconcile()')
  assert.ok(cleared > 0 && reconcile > 0)
  assert.ok(cleared < reconcile, '구 서버의 마운트가 새 서버 세션까지 살아남는다')
})

test('로그인하지 않았으면 서버에 연결 목록을 묻지도 않는다', async () => {
  let asked = 0
  const deps: WorkspaceManagerDeps = {
    config: () => ({ root: '/tmp/x', enabled: true, agents: [] }),
    apiFor: () => ({}) as never,
    loggedIn: () => false,
    cloudLinks: async () => {
      asked++
      return []
    },
    persist: () => undefined,
  }
  const m = new WorkspaceManager(deps)
  await (m as unknown as { syncCloudLinks: () => Promise<boolean> }).syncCloudLinks.call(m)
  assert.equal(asked, 0, '로그아웃 상태에서 남의 계정 목록을 물으면 안 된다')
})
