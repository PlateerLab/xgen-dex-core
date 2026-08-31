/**
 * 드라이브가 **되돌릴 수 없는 상태**에 빠지지 않아야 한다.
 *
 * 실기에서 나온 세 가지 사고를 여기서 못 박는다:
 *
 *   1. 드라이브를 **끌 수 없었다** — 이상해져도 사용자가 할 수 있는 일이 없다
 *   2. 마운트된 폴더의 **하위**를 새 루트로 고르자 마운트 안에 마운트가 생겨,
 *      상위 폴더가 EBUSY 로 잠기고 되돌아갈 수도 지울 수도 없었다
 *   3. 마운트 지점에 파일 하나가 남으면 FUSE 가 **영영** 안 붙는다.
 *      그 파일은 사용자 것이라 지우라고 할 수도 없다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isEnabled, moveRoot, validateNewRoot } from '../src/main/workspace'
import { rescueStrays } from '../src/main/fuse-mount'

const HOME = '/home/tester'

test('드라이브는 기본으로 켜져 있고, 명시적으로만 꺼진다', async () => {
  assert.equal(isEnabled(undefined), true, '설정이 없으면 켜짐이어야 한다')
  assert.equal(isEnabled({ agents: [] }), true, '기존 사용자가 갑자기 꺼지면 안 된다')
  assert.equal(isEnabled({ agents: [], enabled: false }), false)
  assert.equal(isEnabled({ agents: [], enabled: true }), true)
})

test('갇힌 사용자가 상위로 되돌아갈 수 있어야 한다 (복구 경로)', async () => {
  // 실기 사고: 하위 폴더를 잘못 골라 .../XGEN-Workspace/XGEN-Workspace 로 갇혔다.
  // 되돌리는 유일한 길이 "상위로 이동"인데 예전 규칙이 그걸 막았다 —
  // 실수를 되돌릴 방법을 불법으로 만들면 안 된다.
  const stuck = { root: `${HOME}/XGEN-Workspace/XGEN-Workspace`, agents: [] }
  assert.equal(
    validateNewRoot(stuck, `${HOME}/XGEN-Workspace`, HOME),
    null,
    '상위로 되돌아가는 복구 경로를 막았다',
  )
})

test('하위로 옮기는 것도 허용된다 (이동 전에 언마운트하므로 중첩되지 않는다)', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.equal(validateNewRoot(cfg, `${HOME}/XGEN-Workspace/sub`, HOME), null)
})

test('되돌릴 수 없는 것만 막는다 — 홈 전체와 디스크 최상위', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.ok(validateNewRoot(cfg, HOME, HOME), '홈 전체를 허용했다')
  assert.ok(validateNewRoot(cfg, '/', HOME), '디스크 최상위를 허용했다')
  assert.ok(validateNewRoot(cfg, '   ', HOME), '빈 경로를 허용했다')
})

test('무관한 폴더는 정상적으로 허용된다', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.equal(validateNewRoot(cfg, `${HOME}/다른곳/XGEN-Workspace`, HOME), null)
})

test('같은 곳으로 옮기는 것은 변경 없음으로 통과', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.equal(validateNewRoot(cfg, `${HOME}/XGEN-Workspace`, HOME), null)
})

test('moveRoot 는 정말 안 되는 선택만 거부한다 (조용히 하지 않는다)', async () => {
  const cfg = { root: `${HOME}/XGEN-Workspace`, agents: [] }
  assert.throws(() => moveRoot(cfg, HOME, HOME), /홈 폴더/)
})

test('루트를 옮겨도 on/off 설정이 초기화되지 않는다', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-move-'))
  try {
    const cfg = { root: `${HOME}/XGEN-Workspace`, enabled: false, agents: [] }
    const r = moveRoot(cfg, join(tmp, 'XGEN-Workspace'), HOME)
    assert.equal(r.config.enabled, false, '드라이브를 꺼뒀는데 옮기니 켜졌다')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('잔여 파일은 지우지 않고 옆으로 옮긴다 (사용자 파일이다)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-stray-'))
  const mp = join(tmp, 'XGEN-Workspace')
  mkdirSync(mp)
  writeFileSync(join(mp, '보고서.pdf'), 'x')
  mkdirSync(join(mp, '하위'))
  writeFileSync(join(mp, '하위', '메모.txt'), 'y')
  try {
    const backup = await rescueStrays(mp, '20260805-1200')
    assert.ok(backup, '옮기지 않았다')
    // 마운트 지점은 비워져야 붙을 수 있다
    assert.deepEqual(readdirSync(mp), [], '마운트 지점이 아직 비지 않았다')
    // 파일은 하나도 사라지면 안 된다
    assert.ok(existsSync(join(backup!, '보고서.pdf')), '파일이 사라졌다')
    assert.ok(existsSync(join(backup!, '하위', '메모.txt')), '하위 파일이 사라졌다')
    // 보관 폴더는 마운트 지점 **밖**이어야 한다 (안이면 다시 막는다)
    assert.ok(!backup!.startsWith(mp + '/'), `보관 폴더가 마운트 지점 안이다: ${backup}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('비어 있으면 보관 폴더를 만들지 않는다', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'xgen-stray-'))
  const mp = join(tmp, 'XGEN-Workspace')
  mkdirSync(mp)
  try {
    assert.equal(await rescueStrays(mp, '20260805-1200'), null)
    assert.deepEqual(readdirSync(tmp), ['XGEN-Workspace'], '쓸데없는 폴더를 만들었다')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/**
 * 메인 프로세스에서 예외/거부가 새어 나가면 Electron 은 앱을 **그대로 종료**한다.
 * 사용자에게는 "앱이 그냥 꺼졌다"로만 보이고 원인이 어디에도 안 남는다
 * (실기: 워크스페이스 폴더를 바꾸려는 순간 앱이 사라짐).
 */
test('메인 프로세스에 크래시 가드가 있다', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')
  assert.match(src, /process\.on\('uncaughtException'/, 'uncaughtException 가드가 없다')
  assert.match(src, /process\.on\('unhandledRejection'/, 'unhandledRejection 가드가 없다')
})

test('위치 변경 핸들러는 실패를 삼키지도, 던지지도 않는다', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')
  const i = src.indexOf('CHANNELS.workspaceSetRoot')
  const handler = src.slice(i, i + 2000)
  assert.match(handler, /try\s*\{/, '실패를 감싸지 않는다 — 던지면 앱이 죽을 수 있다')
  assert.match(handler, /위치를 바꾸지 못했습니다/, '실패 사유를 화면에 돌려주지 않는다')
  // 이동 전에 반드시 걷어내야 중첩 마운트가 생기지 않는다.
  assert.ok(
    handler.indexOf('detach()') < handler.indexOf('moveRoot('),
    '언마운트보다 루트 변경이 먼저다 — 옛 지점이 마운트된 채 남는다',
  )
})

test('이미 XGEN-Workspace 인 폴더를 고르면 그 안에 또 만들지 않는다', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')
  const i = src.indexOf('CHANNELS.workspaceSetRoot')
  const handler = src.slice(i, i + 2000)
  // 이 중첩이 바로 사용자가 갇힌 원인이다.
  assert.match(handler, /basename\(picked\) === 'XGEN-Workspace'/, '중첩 생성을 막지 않는다')
})

/**
 * 가상 드라이브는 **로그인 상태에서만** 존재한다. 그래서 기동 시점의 리컨사일은
 * 아직 로그인 전이라 아무것도 붙이지 않는다 — 로그인이 끝난 뒤 다시 맞춰야 한다.
 *
 * 이 트리거가 빠져 있어서 재시작할 때마다 연결 실패가 뜨고 [다시 연결] 을
 * 눌러야만 붙었다. 세션 복원 경로는 afterAuthSuccess 를 거치지 않고 같은 일을
 * 손으로 되풀이하고 있었던 것이 원인이다.
 */
test('모든 인증 성공 경로가 드라이브를 다시 맞춘다', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf-8')

  // 1) 로그인/자동로그인/SSO 공통 훅
  const after = src.slice(
    src.indexOf('async function afterAuthSuccess'),
    src.indexOf('const SSO_CALLBACK'),
  )
  assert.match(after, /getWorkspaceManager\(\)\?\.reconcile\(\)/, 'afterAuthSuccess 에 리컨사일이 없다')

  // 2) 세션 복원(재시작 경로) — 여기가 실제로 빠져 있던 곳
  const i = src.indexOf('CHANNELS.authRestore')
  const restore = src.slice(i, i + 1600)
  assert.match(
    restore,
    /getWorkspaceManager\(\)\?\.reconcile\(\)/,
    '세션 복원 후 리컨사일이 없다 — 재시작하면 드라이브가 안 붙는다',
  )
})

/**
 * 구해 낸 파일은 **한 번만** 올린다.
 *
 * 실기 사고: 파일을 지워도 계속 되살아났다. 마운트할 때마다·[동기화] 누를
 * 때마다 보관 폴더를 다시 업로드하고 있었기 때문이다. 사용자가 지운 파일이
 * 로컬 보관본에서 그대로 다시 올라갔다.
 *
 * 동기화는 "서버 상태를 다시 읽는 것"이지 "로컬을 다시 밀어 넣는 것"이 아니다.
 */
test('동기화는 보관 폴더를 다시 올리지 않는다 (지운 파일이 되살아난다)', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/workspace-manager.ts', import.meta.url), 'utf-8')
  const fn = src.slice(src.indexOf('async refreshNow('), src.indexOf('async refreshNow(') + 700)
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(
    !code.includes('uploadRescued'),
    '동기화가 보관 폴더를 재업로드한다 — 사용자가 지운 파일이 되살아난다',
  )
})

test('마운트할 때마다 재업로드하지 않는다', async () => {
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/workspace-manager.ts', import.meta.url), 'utf-8')
  assert.match(src, /rescueUploaded/, '업로드 여부를 기억하지 않는다 — 재마운트마다 다시 올린다')
  const i = src.indexOf('this.rescued && !this.rescueUploaded')
  assert.ok(i > 0, '업로드 전에 이미 했는지 확인하지 않는다')
})

test('업로드 실패해도 자동 재시도하지 않는다', async () => {
  // 재시도 사이에 사용자가 지웠으면 되살린다. 보관 폴더를 남기고 알리는 편이 낫다.
  const { readFileSync } = await import('fs')
  const src = readFileSync(new URL('../src/main/workspace-manager.ts', import.meta.url), 'utf-8')
  const fn = src.slice(src.indexOf('private async uploadRescued'), src.indexOf('private async mountAlive'))
  assert.match(fn, /보관 폴더를 남긴다/, '실패 시 처리가 명시돼 있지 않다')
})

/**
 * 레거시 페어 동기화 엔진은 **가동되지 않아야 한다.**
 *
 * 예전 모델(에이전트 ↔ 임의 폴더)은 가상 드라이브로 대체됐다. 그런데 설정에
 * 남은 syncPairs 로 엔진이 계속 살아나 같은 폴더를 향해 드라이브와 동시에
 * 동작했다. 사용자가 지운 파일을 그 엔진이 자기 인덱스를 근거로 **다시
 * 올렸다** — 서버·드라이브·웹 어디서 지워도 곧바로 되살아난 "무한 부활" 의
 * 원인이다.
 *
 * 동기화 주체는 하나여야 한다.
 */
test('레거시 페어 동기화 엔진의 흔적이 남아 있지 않다', async () => {
  // 멈추는 것으로는 부족했다 — 재가동 경로가 다섯 군데였고 하나만 되살아나도
  // 증상이 돌아온다(지운 파일이 무한 부활). 코드에서 들어냈으므로, 배선이
  // 다시 들어오는 것을 여기서 막는다.
  //
  // ⚠ local-sync(-manager)는 레거시의 부활이 **아니다** — 레거시가 base 없이
  // 자기 인덱스만 보고 되살리던 것과 달리, base 스냅숏을 갖는 3-way 로
  // 부활 자체가 판정 불가능하게 설계됐고 그 계약을 sync-plan/local-sync
  // 테스트("무한 부활 방지")가 고정한다. 여기서 막는 것은 레거시 모듈명과
  // 레거시 설정 키다.
  const { readFileSync, existsSync } = await import('fs')
  for (const gone of ['sync-core.ts', 'sync-fs.ts', 'sync-manager.ts']) {
    assert.ok(!existsSync(new URL(`../src/main/${gone}`, import.meta.url)), `되살아남: ${gone}`)
  }
  for (const f of ['index.ts', 'config.ts', 'ipc.ts']) {
    const src = readFileSync(new URL(`../src/main/${f}`, import.meta.url), 'utf-8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const token of ['syncPairs', 'SyncPairPersistConfig', "from './sync-core'", "from './sync-fs'"]) {
      assert.ok(!code.includes(token), `${f} 에 레거시 배선이 남아 있다: ${token}`)
    }
  }
})
