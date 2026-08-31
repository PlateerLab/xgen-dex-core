/**
 * 클라우드 스토리지 on/off — 커넥터가 서버의 판정을 따르는지.
 *
 * on/off 는 **두 곳**에 있다: 관리자 전역 설정(IS_AVAILABLE_CLOUD_STORAGE)과
 * 사용자 개인 설정(preferences.cloud_storage). 커넥터는 어느 쪽이 껐는지 알
 * 필요가 없다 — 서버가 403 으로 거절하면 그게 꺼진 것이다. 게이트 판정을
 * 커넥터가 흉내내면 서버와 어긋나는 순간 "웹에선 꺼졌는데 드라이브엔 남아
 * 있다"가 된다.
 *
 * 여기서 고정하는 것:
 *   1. 403 → 루트를 붙이지 않고 **사유를 사용자에게 보여준다** (조용히 빈
 *      폴더가 되면 사용자는 파일이 사라진 줄 안다)
 *   2. 네트워크 실패는 **꺼짐이 아니다** — 잠깐 끊겼다고 루트를 떼면 안 된다
 *   3. 꺼져 있어도 **에이전트 workspace 는 그대로** 동작한다
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { WorkspaceManager, type WorkspaceManagerDeps } from '../src/main/workspace-manager'
import type { WorkspaceApi } from '../src/main/workspace-backend'

/** changes() 가 지정한 방식으로 실패하는(또는 성공하는) 최소 API. */
function api(fail?: { status?: number; message: string }): WorkspaceApi {
  return {
    async changes() {
      if (fail) {
        throw Object.assign(new Error(fail.message), fail.status ? { status: fail.status } : {})
      }
      return { changes: [] }
    },
    async download() {},
    async put() {
      return { sha256: '' }
    },
    async del() {},
    async mkdir() {},
  }
}

function manager(userApi: WorkspaceApi | null, agents: string[] = []): WorkspaceManager {
  const deps: WorkspaceManagerDeps = {
    config: () => ({
      root: '/tmp/xgen-gate-test',
      agents: agents.map((id) => ({ workflowId: id, label: id, folder: id })),
    }) as never,
    apiFor: () => api(),
    loggedIn: () => true,
    userApi: () => userApi,
  }
  return new WorkspaceManager(deps)
}

// probeUserStorage 는 내부 계약이지만 **이 동작이 사용자에게 보이는 전부**다.
type Probe = (a: WorkspaceApi | null) => Promise<WorkspaceApi | null>
const probeOf = (m: WorkspaceManager): Probe =>
  (m as unknown as { probeUserStorage: Probe }).probeUserStorage.bind(m)

test('403 이면 루트를 붙이지 않고 서버가 준 사유를 보여준다', async () => {
  const m = manager(null)
  const denied = api({ status: 403, message: '내 클라우드 스토리지가 켜져 있지 않습니다' })
  assert.equal(await probeOf(m)(denied), null, '꺼졌는데 루트를 붙였다')
  assert.match(m.status().storageOff ?? '', /켜져 있지 않습니다/)
  // 오류가 아니다 — "실패"로 보이면 사용자가 고치려 든다.
  assert.equal(m.status().error, undefined)
})

test('관리자가 끈 경우도 같은 경로로 처리된다 (누가 껐는지 몰라도 된다)', async () => {
  const m = manager(null)
  const denied = api({ status: 403, message: '클라우드 스토리지 기능이 비활성화되어 있습니다' })
  assert.equal(await probeOf(m)(denied), null)
  assert.match(m.status().storageOff ?? '', /비활성화/)
})

test('네트워크 실패는 꺼짐이 아니다 (파일이 사라진 것처럼 보이면 안 된다)', async () => {
  const m = manager(null)
  const flaky = api({ message: 'fetch failed' })
  assert.notEqual(await probeOf(m)(flaky), null, '잠깐 끊겼다고 루트를 뗐다')
  assert.equal(m.status().storageOff, undefined)
})

test('500 도 꺼짐이 아니다 — 서버 장애와 정책은 다르다', async () => {
  const m = manager(null)
  const broken = api({ status: 500, message: 'changes HTTP 500' })
  assert.notEqual(await probeOf(m)(broken), null)
  assert.equal(m.status().storageOff, undefined)
})

test('다시 켜면 사유가 사라진다 (한 번 꺼지면 영영 꺼진 것처럼 남으면 안 된다)', async () => {
  const m = manager(null)
  await probeOf(m)(api({ status: 403, message: '꺼져 있습니다' }))
  assert.ok(m.status().storageOff)
  assert.notEqual(await probeOf(m)(api()), null)
  assert.equal(m.status().storageOff, undefined, '다시 켰는데 꺼짐 표시가 남아 있다')
})

test('스토리지를 안 쓰는 사용자는 사유도 없다', async () => {
  const m = manager(null)
  assert.equal(await probeOf(m)(null), null)
  assert.equal(m.status().storageOff, undefined)
})

test('꺼져 있고 에이전트도 없으면 마운트하지 않는다', async () => {
  const m = manager(api({ status: 403, message: '꺼져 있습니다' }))
  await m.reconcile()
  const s = m.status()
  assert.equal(s.mounted, false)
  assert.match(s.storageOff ?? '', /꺼져 있습니다/)
})

/**
 * preload 의 WorkspaceStatusLike 는 main 의 WorkspaceStatus 를 **손으로 베낀
 * 미러**다. 미러가 어긋나면 main 이 보낸 필드가 렌더러에서 조용히 사라진다
 * (타입만 없을 뿐 런타임 값은 오므로 컴파일러도 안 잡아준다).
 *
 * 실제로 이 종류의 조용한 실패를 여러 번 겪었다 — 주석 대신 테스트로 못 박는다.
 */
test('preload 상태 미러가 main 의 필드를 하나도 빠뜨리지 않는다', () => {
  const fields = (file: string, iface: string): Set<string> => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8')
    const m = new RegExp(`interface ${iface}\\s*{([\\s\\S]*?)\\n}`).exec(src)
    assert.ok(m, `${iface} 를 ${file} 에서 못 찾았다`)
    return new Set(
      [...m![1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]),
    )
  }
  const main = fields('src/main/workspace-manager.ts', 'WorkspaceStatus')
  const mirror = fields('src/preload/index.ts', 'WorkspaceStatusLike')
  assert.ok(main.size > 5, `main 필드 파싱 실패 (${[...main]})`)
  const missing = [...main].filter((f) => !mirror.has(f))
  assert.deepEqual(missing, [], `preload 미러에 빠진 필드: ${missing.join(', ')}`)
})

// ── 접속 표시(presence) ────────────────────────────────────────────
//
// 사용자 신고: 커넥터로 드라이브를 붙이고 파일을 넣어도 웹에 "연결된 PC"가
// 안 뜨고 파일도 안 보였다. 원인 절반은 서버(WS 가 사용자 스코프를 몰랐다),
// 절반은 여기 — **가상 드라이브가 WS 를 아예 열지 않았다**. 기기 등록은
// WS hello 로만 되므로 칩이 영영 안 뜬다.

class FakePresence {
  started = false
  stopped = false
  constructor(readonly owner: string, readonly onChanged: () => void) {}
  async start(): Promise<void> {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
}

function withPresence(userApi: WorkspaceApi | null, agents: string[] = []) {
  const made: FakePresence[] = []
  const deps: WorkspaceManagerDeps = {
    config: () => ({
      root: '/tmp/xgen-presence-test',
      agents: agents.map((id) => ({ workflowId: id, label: id, folder: id })),
    }) as never,
    apiFor: () => api(),
    loggedIn: () => true,
    userApi: () => userApi,
    userOwner: () => 'user:7',
    presenceFor: (owner, onChanged) => {
      const p = new FakePresence(owner, onChanged)
      made.push(p)
      return p
    },
  }
  return { m: new WorkspaceManager(deps), made }
}

type Sync = (u: WorkspaceApi | null) => void
const syncOf = (m: WorkspaceManager): Sync =>
  (m as unknown as { syncPresence: Sync }).syncPresence.bind(m)

test('드라이브는 사용자 스토리지 접속 표시만 연다 (에이전트는 local-sync 소유)', async () => {
  // 드라이브가 에이전트를 서빙하던 시절에는 여기서 에이전트 WS 도 열었다.
  // 이제 에이전트 워크스페이스는 local-sync 가 실제 폴더로 다루고 접속 표시도
  // 그쪽이 연다 — 드라이브가 겹쳐 열면 PC 가 두 대로 보인다.
  const { m, made } = withPresence(api(), ['wf-1'])
  syncOf(m)(api())
  const owners = made.map((p) => p.owner)
  assert.deepEqual(owners, ['user:7'], `열린 저장소: ${owners}`)
  assert.ok(made.every((p) => p.started), '시작되지 않은 접속 표시가 있다')
})

test('변경 알림이 오면 사용자 스토리지 캐시를 버린다', () => {
  const { m, made } = withPresence(api())
  syncOf(m)(api())
  const dropped: string[] = []
  const backend = (m as unknown as { backend: { invalidateSpace: (k: string) => void } }).backend
  backend.invalidateSpace = (k: string) => dropped.push(k)
  made.find((p) => p.owner === 'user:7')!.onChanged()
  assert.deepEqual(dropped, ['']) // 사용자 스토리지의 캐시 키는 빈 문자열
})

test('클라우드가 걷히면 사용자 접속 표시를 닫는다', () => {
  const { m, made } = withPresence(api())
  syncOf(m)(api())
  syncOf(m)(null)
  const user = made.find((p) => p.owner === 'user:7')!
  assert.equal(user.stopped, true, '드라이브가 없는데 접속 표시가 남아 있다')
})

test('같은 저장소로 두 번 열지 않는다 (PC 가 두 대로 보인다)', () => {
  const { m, made } = withPresence(api())
  syncOf(m)(api())
  syncOf(m)(api())
  assert.equal(made.length, 1, `중복 등록: ${made.map((p) => p.owner)}`)
})

test('클라우드 스토리지가 꺼져 있으면 접속 표시를 아예 열지 않는다', () => {
  const { m, made } = withPresence(null, ['wf-1'])
  syncOf(m)(null)
  assert.deepEqual(made.map((p) => p.owner), [])
})

// ── "연결 안 됨인데 이유도 없음" 은 존재해선 안 된다 ────────────────
//
// 이 상태가 실제 사고였다: 마운트가 안 붙었는데 화면에 아무 설명이 없어서
// 사용자는 (마운트가 아닌) 빈 폴더에 파일을 넣었고, 그 파일은 아무 데도 가지
// 않았다.

test('연결되지 않았으면 반드시 이유가 있다', () => {
  const m = manager(api(), ['wf-1'])
  const s = m.status()
  assert.equal(s.mounted, false)
  assert.ok(s.error || s.storageOff || !s.supported, '이유 없이 연결 안 됨 상태다')
})

test('쓰려는 저장소가 하나도 없으면 이유를 만들지 않는다', () => {
  const m = manager(null, [])
  const s = m.status()
  assert.equal(s.error, undefined, '붙일 게 없는데 오류를 지어냈다')
})

// ── 사용자가 스스로 되살릴 수 있어야 한다 ──────────────────────────
//
// 마운트가 실패했을 때 할 수 있는 일이 "앱을 껐다 켜기"뿐이면 그건 해결책이
// 아니다. [다시 연결]은 걷고 처음부터 붙이고, [동기화]는 서버 상태를 지금
// 다시 읽는다.

test('다시 연결은 남아 있던 오류를 지우고 시작한다', async () => {
  const m = manager(null, [])
  ;(m as unknown as { lastError?: string }).lastError = '옛 실패'
  await m.remount()
  // 붙일 게 없으면 오류도 없어야 한다 — 성공했는데 옛 오류가 남으면 안 된다.
  assert.equal(m.status().error, undefined, `옛 오류가 남았다: ${m.status().error}`)
})

test('동기화는 모든 저장소 캐시를 버린다 (한 곳만 남으면 낡은 목록이 보인다)', async () => {
  const m = manager(null, [])
  let cleared = false
  const backend = (m as unknown as { backend: { invalidateAll: () => void } }).backend
  backend.invalidateAll = () => {
    cleared = true
  }
  await m.refreshNow()
  assert.equal(cleared, true, '캐시를 버리지 않았다')
})

test('동기화는 보관 폴더를 다시 올리지 않는다 (지운 파일이 되살아난다)', async () => {
  // 예전에는 여기서 재업로드했다. 그래서 사용자가 지운 파일이 로컬 보관본에서
  // 그대로 다시 올라가 "지워도 되살아나는" 사고가 났다. 동기화는 서버 상태를
  // 다시 읽는 것이지 로컬을 다시 밀어 넣는 것이 아니다.
  const m = manager(null, [])
  ;(m as unknown as { rescued?: string }).rescued = '/tmp/보관'
  let retried = ''
  ;(m as unknown as { uploadRescued: (p: string) => Promise<void> }).uploadRescued = async (p) => {
    retried = p
  }
  await m.refreshNow()
  assert.equal(retried, '', '동기화가 보관 폴더를 재업로드했다')
})

// ── 기동 직후 ─────────────────────────────────────────────────────
//
// 실기 신고: 커넥터를 재시작하면 "드라이브를 연결하지 못했습니다" 가 뜨고,
// [다시 연결] 을 눌러야만 붙었다. 원인 둘 다 여기서 고정한다.

test('아직 시도 중이면 실패라고 말하지 않는다', async () => {
  // 기동 직후에는 로그인·마운트가 진행 중이라 "안 붙은" 상태가 정상이다.
  // (실제 마운트를 걸지 않으려고 in-flight 플래그만 세운다 — 검증 대상은
  //  "시도 중에는 실패라고 하지 않는다" 이 한 가지다.)
  const m = manager(api(), [])
  const inner = m as unknown as { inFlight: boolean }
  inner.inFlight = true
  assert.equal(m.status().error, undefined, '시도 중인데 실패라고 했다')
  inner.inFlight = false
  assert.match(m.status().error ?? '', /원인 미상/, '시도가 끝났는데도 침묵한다')
})

test('상태 조회는 상태를 바꾸지 않는다', async () => {
  // 예전엔 status() 가 lastError 를 직접 써 넣어, 화면을 한 번 본 것만으로
  // 오류가 눌러앉았다.
  const m = manager(api({ status: 403, message: '꺼져 있습니다' }), [])
  await m.reconcile()
  const first = m.status().error
  m.status()
  m.status()
  assert.equal(m.status().error, first, '조회할 때마다 상태가 달라진다')
})

test('꺼져 있는 것은 실패로 보고하지 않는다', async () => {
  const m = manager(api({ status: 403, message: '내 클라우드 스토리지가 켜져 있지 않습니다' }), [])
  await m.reconcile()
  const s = m.status()
  assert.ok(s.storageOff, '꺼짐 사유가 없다')
  assert.equal(s.error, undefined, '꺼진 것을 오류로 표시했다')
})

// ── RAG 시스템 통제 — 승인 게이트 403 은 '꺼짐'이 아니라 '대기/거절'이다 ──
//
// 서버 게이트(_device_link_blocked_reason)의 403 사유 문구를 그대로 분류한다.
// 대기를 storageOff 로 흘리면 "권한을 확인하라"는 엉뚱한 안내가 되고,
// 사용자가 할 일(승인을 기다림)이 화면에서 사라진다.

test('승인 대기 403 은 cloudApproval=pending 으로 분류되고 storageOff 가 아니다', async () => {
  const m = manager(null)
  const denied = api({
    status: 403,
    message: 'changes HTTP 403: 클라우드 로컬 연결이 관리자 승인 대기 중입니다.',
  })
  assert.equal(await probeOf(m)(denied), null)
  assert.equal(m.status().cloudApproval, 'pending')
  assert.equal(m.status().storageOff, undefined)
  // 표시용 사유에서 "HTTP 403:" 노이즈는 걷혀 있다.
  assert.match(m.status().cloudApprovalDetail ?? '', /^클라우드 로컬 연결이 관리자 승인 대기 중/)
})

test('거절 403 은 cloudApproval=rejected 로 분류된다', async () => {
  const m = manager(null)
  const denied = api({
    status: 403,
    message: 'changes HTTP 403: 클라우드 로컬 연결이 관리자에 의해 거절되었습니다.',
  })
  assert.equal(await probeOf(m)(denied), null)
  assert.equal(m.status().cloudApproval, 'rejected')
  assert.equal(m.status().storageOff, undefined)
})

test('승인이 떨어지면(성공 응답) 대기 상태가 걷힌다', async () => {
  const m = manager(null)
  const denied = api({
    status: 403,
    message: '클라우드 로컬 연결이 관리자 승인 대기 중입니다.',
  })
  await probeOf(m)(denied)
  assert.equal(m.status().cloudApproval, 'pending')
  await probeOf(m)(api())
  assert.equal(m.status().cloudApproval, undefined)
})

test('승인 게이트가 아닌 403(스토리지 꺼짐)은 기존대로 storageOff 다', async () => {
  const m = manager(null)
  const denied = api({ status: 403, message: '클라우드 스토리지 기능이 비활성화되어 있습니다' })
  await probeOf(m)(denied)
  assert.equal(m.status().cloudApproval, undefined)
  assert.match(m.status().storageOff ?? '', /비활성화/)
})

