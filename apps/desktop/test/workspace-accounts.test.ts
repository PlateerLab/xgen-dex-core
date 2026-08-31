/**
 * 워크스페이스는 **계정에 속한다.**
 *
 * 예전에는 전역 설정 하나였다. 그래서 계정을 바꿔 로그인해도 이전 계정의
 * 루트·부착 에이전트를 그대로 물었고, 두 계정이 같은 폴더를 클라우드로
 * 가리키면 서로의 파일을 덮어썼다 (마운트는 하나만 걸리므로 나중에 붙은
 * 쪽이 조용히 이긴다 — 사용자에게는 "파일이 사라졌다"로 보인다).
 */
import assert from 'assert'
import { test } from 'node:test'
import { accountKey, describeAccount, rootConflict } from '../src/main/workspace'

const HOME = '/home/tester'

test('계정 키는 서버까지 포함한다 (서로 다른 XGEN 의 같은 id 를 섞지 않는다)', () => {
  const a = accountKey('https://xgen.corp.com', '7')
  const b = accountKey('https://xgen-dev.corp.com', '7')
  assert.notEqual(a, b, '서버가 달라도 같은 계정으로 묶였다')
  // 끝 슬래시 유무로 다른 계정이 되면 안 된다.
  assert.equal(accountKey('https://x.com/', '7'), accountKey('https://x.com', '7'))
})

test('다른 계정이 쓰는 폴더는 충돌로 잡는다', () => {
  const me = accountKey('https://x.com', '7')
  const other = accountKey('https://x.com', '8')
  const all = { [other]: { root: `${HOME}/XGEN-Workspace`, agents: [] } }
  const hit = rootConflict(all, me, `${HOME}/XGEN-Workspace`, HOME)
  assert.equal(hit, other, '남이 쓰는 폴더를 통과시켰다')
})

test('자기 자신은 충돌이 아니다 (같은 계정이 같은 폴더를 유지)', () => {
  const me = accountKey('https://x.com', '7')
  const all = { [me]: { root: `${HOME}/XGEN-Workspace`, agents: [] } }
  assert.equal(rootConflict(all, me, `${HOME}/XGEN-Workspace`, HOME), null)
})

test('다른 폴더면 충돌이 아니다', () => {
  const me = accountKey('https://x.com', '7')
  const other = accountKey('https://x.com', '8')
  const all = { [other]: { root: `${HOME}/A`, agents: [] } }
  assert.equal(rootConflict(all, me, `${HOME}/B`, HOME), null)
})

test('기본 루트를 쓰는 계정끼리도 충돌로 잡힌다 (root 미지정)', () => {
  // root 를 지정 안 하면 둘 다 ~/XGEN-Workspace 를 쓴다 — 가장 흔한 충돌이다.
  const me = accountKey('https://x.com', '7')
  const other = accountKey('https://x.com', '8')
  const all = { [other]: { agents: [] } }
  assert.ok(rootConflict(all, me, `${HOME}/XGEN-Workspace`, HOME), '기본 루트 충돌을 놓쳤다')
})

test('충돌 안내에 상대 계정을 알아볼 수 있게 담는다', () => {
  const d = describeAccount(accountKey('https://xgen.corp.com', '8'))
  assert.match(d, /xgen\.corp\.com/)
  assert.match(d, /8/)
})
