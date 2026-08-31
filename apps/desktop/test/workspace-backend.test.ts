/**
 * WebDAV 백엔드 — 마운트된 드라이브의 실체.
 *
 * 루트 = **사용자 클라우드 스토리지 그 자체** (XGen-Cloud 1:1). 에이전트
 * 워크스페이스는 드라이브에 없다 — local-sync 가 실제 폴더로 다룬다.
 *
 * 여기서 고정하는 것: 루트=클라우드 직접 매핑, 직계 자식만 나열, 트리 캐시,
 * **조회 실패 시 이전 캐시 유지**(빈 목록을 주면 Finder 에 "전부 사라졌다"로
 * 보인다), base_sha 전달, MOVE=복사+삭제(편집기 저장 패턴), force 삭제.
 */
import assert from 'assert'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { WorkspaceDavBackend, type WorkspaceApi } from '../src/main/workspace-backend'
import { ApprovalPendingError, SyncConflictError } from '../src/main/sync-protocol'

interface Rec {
  path: string
  is_dir: boolean
  size: number
  mtime_ns: number
  sha256: string
  deleted: boolean
}

class FakeApi implements WorkspaceApi {
  files = new Map<string, string>()
  dirs = new Set<string>()
  calls: string[] = []
  failChanges = false
  changeCount = 0

  private rec(path: string, isDir: boolean, body = ''): Rec {
    return {
      path,
      is_dir: isDir,
      size: body.length,
      mtime_ns: 1_700_000_000_000_000_000,
      sha256: isDir ? '' : `sha-${body.length}`,
      deleted: false,
    }
  }

  async changes(): Promise<{ changes: Rec[] }> {
    this.changeCount++
    if (this.failChanges) throw new Error('네트워크 끊김')
    return {
      changes: [
        ...[...this.dirs].map((d) => this.rec(d, true)),
        ...[...this.files].map(([p, b]) => this.rec(p, false, b)),
      ],
    }
  }
  async download(path: string, toAbs: string): Promise<void> {
    this.calls.push(`download:${path}`)
    writeFileSync(toAbs, this.files.get(path) ?? '')
  }
  async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
    this.calls.push(`put:${path}:base=${baseSha}`)
    const body = readFileSync(fromAbs, 'utf8')
    this.files.set(path, body)
    return { sha256: `sha-${body.length}` }
  }
  /** 서버의 fail-closed 계약을 그대로 흉내낸다 — force 없는 삭제는 거부. */
  strictServer = false
  async del(path: string, baseSha?: string, opts?: { force?: boolean }): Promise<void> {
    this.calls.push(`del:${path}:base=${baseSha ?? ''}:force=${opts?.force ? '1' : '0'}`)
    if (this.strictServer && !opts?.force) {
      const isDir = this.dirs.has(path)
      const hasKids = [...this.files.keys()].some((f) => f.startsWith(`${path}/`))
      if (isDir && hasKids) throw Object.assign(new Error('dir_not_empty'), { status: 409 })
      if (!isDir && !baseSha) throw Object.assign(new Error('base_sha_required'), { status: 409 })
    }
    this.files.delete(path)
    this.dirs.delete(path)
    for (const f of [...this.files.keys()]) {
      if (f.startsWith(`${path}/`)) this.files.delete(f)
    }
  }
  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir:${path}`)
    this.dirs.add(path)
  }
}

function setup(): { be: WorkspaceDavBackend; user: FakeApi } {
  // 루트 = 사용자 클라우드 스토리지. 폴더(저장소) 단위로 구성된다.
  const user = new FakeApi()
  user.dirs.add('내-PC')
  user.files.set('내-PC/내 메모.md', '개인 파일\n')
  user.dirs.add('자료')
  user.files.set('자료/표.csv', 'a,b\n')
  const be = new WorkspaceDavBackend()
  be.setUserStorage(user)
  return { be, user }
}

test('루트가 곧 클라우드다 — 웹의 스토리지 화면과 1:1', async () => {
  // 예전에는 루트를 클라우드/에이전트 예약 폴더로 갈랐다. 에이전트가
  // 드라이브에서 빠지면서(→ local-sync) 루트는 클라우드 내용 그대로다.
  const { be } = setup()
  const root = await be.stat('/')
  assert.ok(root?.isDir)
  const names = (await be.readdir('/')).map((k) => k.name)
  assert.deepEqual(names.sort(), ['내-PC', '자료'])
})

test('직계 자식만 나열한다 — 하위 폴더 파일이 새어 나오지 않는다', async () => {
  const { be } = setup()
  const kids = await be.readdir('/자료')
  assert.deepEqual(kids.map((k) => k.name), ['표.csv'])
  assert.ok(!(await be.readdir('/')).some((k) => k.name.includes('/')))
})

test('파일 stat 이 크기와 ETag 를 준다', async () => {
  const { be } = setup()
  const n = await be.stat('/자료/표.csv')
  assert.ok(n && !n.isDir)
  assert.equal(n!.name, '표.csv')
  assert.equal(n!.size, 'a,b\n'.length)
  assert.ok(n!.etag)
})

test('없는 경로는 404 (null)', async () => {
  const { be } = setup()
  assert.equal(await be.stat('/없는 폴더/파일.md'), null)
  assert.deepEqual(await be.readdir('/없는 폴더'), [])
})

test('읽기가 서버에서 내용을 가져온다', async () => {
  const { be, user } = setup()
  const buf = await be.read('/내-PC/내 메모.md')
  assert.equal(buf.toString(), '개인 파일\n')
  assert.ok(user.calls.includes('download:내-PC/내 메모.md'))
})

test('쓰기가 base_sha 를 실어 보낸다 (서버 낙관적 동시성)', async () => {
  const { be, user } = setup()
  await be.write('/내-PC/내 메모.md', Buffer.from('# 수정됨\n'))
  const put = user.calls.find((c) => c.startsWith('put:내-PC/내 메모.md'))
  assert.ok(put, user.calls.join(','))
  assert.match(put!, /base=sha-/, 'base_sha 없이 덮어썼다')
  assert.equal(user.files.get('내-PC/내 메모.md'), '# 수정됨\n')
})

test('쓰기 뒤 목록이 최신을 반영한다 (캐시 무효화)', async () => {
  const { be } = setup()
  await be.readdir('/자료')
  await be.write('/자료/새 파일.txt', Buffer.from('x'))
  const kids = await be.readdir('/자료')
  assert.ok(kids.some((k) => k.name === '새 파일.txt'), kids.map((k) => k.name).join(','))
})

test('트리를 캐시해 폴더 열기가 매번 왕복하지 않는다', async () => {
  // Finder 는 폴더 하나를 열 때 항목마다 PROPFIND 를 따로 쏜다.
  const { be, user } = setup()
  await be.readdir('/')
  const after = user.changeCount
  await be.stat('/자료/표.csv')
  await be.stat('/내-PC')
  await be.readdir('/자료')
  assert.equal(user.changeCount, after, `캐시가 안 먹었다 (${user.changeCount - after}회 추가 왕복)`)
})

test('조회 실패 시 이전 캐시를 유지한다 (전부 사라진 것처럼 보이면 안 된다)', async () => {
  const { be, user } = setup()
  const before = await be.readdir('/')
  assert.equal(before.length, 2)

  user.failChanges = true
  await new Promise((r) => setTimeout(r, 4100)) // TTL 만료
  const after = await be.readdir('/')
  assert.equal(after.length, 2, '네트워크가 끊기자 파일이 전부 사라졌다')
})

test('삭제는 파일에 base_sha 를 주고 디렉터리에는 주지 않는다', async () => {
  const { be, user } = setup()
  await be.remove('/자료/표.csv')
  assert.ok(user.calls.some((c) => /^del:자료\/표\.csv:base=sha-/.test(c)), user.calls.join(','))

  await be.remove('/자료')
  assert.ok(user.calls.some((c) => c.startsWith('del:자료:base=:')), user.calls.join(','))
})

test('MOVE 는 복사+삭제로 처리한다 (편집기의 임시파일→rename 저장)', async () => {
  const { be, user } = setup()
  await be.move('/내-PC/내 메모.md', '/내-PC/메모-최종.md')
  assert.equal(user.files.get('내-PC/메모-최종.md'), '개인 파일\n')
  assert.ok(!user.files.has('내-PC/내 메모.md'))
})

test('루트 직속 파일 쓰기는 거부한다 (클라우드는 폴더 단위) — 폴더는 자유', async () => {
  const { be, user } = setup()
  await assert.rejects(
    () => be.write('/새 메모.txt', Buffer.from('hello')),
    /루트에는 파일을 만들 수 없습니다/,
  )
  // 폴더는 만들 수 있고, 그 폴더 안에는 자유롭게 쓴다 — 내 스토리지다.
  await be.mkdir('/새 폴더')
  assert.ok(user.dirs.has('새 폴더'))
  await be.write('/새 폴더/새 메모.txt', Buffer.from('hello'))
  assert.equal(user.files.get('새 폴더/새 메모.txt'), 'hello')
  // 루트 자체는 만들거나 지울 수 없다.
  await assert.rejects(() => be.remove('/'), /루트는 지울 수 없습니다/)
  await assert.rejects(() => be.mkdir('/'), /루트는 만들 수 없습니다/)
})

test('회귀: 새 폴더 생성이 관리자 승인 대기로 미뤄지면 성공으로 위장하지 않는다', async () => {
  // 새 최상위 폴더는 RAG 통제가 켜져 있으면 서버가 실제로는 아무것도 만들지
  // 않고 pending_approval 을 던진다(HTTP 는 200) — transport 가 이걸 그냥
  // 삼키면 드라이브엔 폴더가 "생긴 것"처럼 보이는데 서버엔 없는 유령 폴더가
  // 된다. api.mkdir 이 이 신호를 에러로 던지면 백엔드는 그대로 전파해야 한다
  // (dirs 에 추가하거나 성공한 것처럼 캐시를 무효화하면 안 된다).
  const { be, user } = setup()
  const originalMkdir = user.mkdir.bind(user)
  user.mkdir = async (path: string) => {
    user.calls.push(`mkdir:${path}`)
    throw new ApprovalPendingError(7, path) // 서버가 pending 을 돌려준 상황을 흉내
  }
  await assert.rejects(() => be.mkdir('/새저장소'), ApprovalPendingError)
  assert.ok(!user.dirs.has('새저장소'), '승인 대기인데 로컬 캐시에 폴더가 생겼다')
  user.mkdir = originalMkdir
})

test('루트 파일 거부 시 이 PC 의 폴더를 정확히 안내한다', async () => {
  const { be, user } = setup()
  // home_folder 를 모르면 일반 안내.
  await assert.rejects(() => be.write('/메모.txt', Buffer.from('x')), /폴더 안에 저장하세요/)
  // 서버가 정한 이 PC 의 폴더를 알면, 정확한 경로를 안내한다.
  be.setHomeFolder('내-PC')
  await assert.rejects(
    () => be.write('/메모.txt', Buffer.from('x')),
    /내-PC\/ 폴더 안에 저장하세요/,
  )
  // 안내한 그 폴더 안에는 정상적으로 써진다.
  await be.write('/내-PC/메모.txt', Buffer.from('x'))
  assert.equal(user.files.get('내-PC/메모.txt'), 'x')
})

test('클라우드가 없으면 드라이브는 비어 있고 쓰기는 사유를 말한다', async () => {
  const { be } = setup()
  be.setUserStorage(null)
  assert.deepEqual(await be.readdir('/'), [])
  await assert.rejects(() => be.write('/폴더/x.txt', Buffer.from('x')), /연결되어 있지 않습니다/)
})

// ── 삭제: 드라이브에서 지운 것은 사용자의 명시적 의사다 ──────────────
//
// 서버는 force 없는 삭제를 "동기화 레플리카의 추론"으로 보고 fail-closed 로
// 막는다 (파일=base_sha 필수, 폴더=비어 있을 때만). 그 가드는 낡은 레플리카가
// 에이전트 산출물을 쓸어 담는 것을 막기 위한 것이지 **사람 손**을 막으려는
// 게 아니다.

test('드라이브에서 지우면 force 를 실어 보낸다', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  await be.remove('/내-PC/내 메모.md')
  const del = user.calls.find((c) => c.startsWith('del:'))
  assert.ok(del?.endsWith(':force=1'), `force 를 안 보냈다: ${del}`)
})

test('내용이 있는 폴더도 드라이브에서 지워진다', async () => {
  const { be, user } = setup()
  user.strictServer = true // 서버의 fail-closed 계약을 켠다
  await be.readdir('/자료')
  await be.remove('/자료') // 안에 표.csv 가 있다
  assert.ok(!user.dirs.has('자료'), '폴더가 안 지워졌다')
  assert.ok(!user.files.has('자료/표.csv'), '폴더 안 파일이 남았다')
})

test('캐시가 모르는 파일도 지워진다', async () => {
  const { be, user } = setup()
  user.strictServer = true
  await be.readdir('/')
  // 다른 기기가 방금 만든 파일 — 우리 트리 캐시엔 없어서 base_sha 가 없다.
  user.files.set('남이만든.txt', 'x')
  await be.remove('/남이만든.txt')
  assert.ok(!user.files.has('남이만든.txt'), '캐시에 없다고 삭제를 포기했다')
})

test('레거시 페어 동기화 엔진이 코드에 존재하지 않는다', () => {
  // 예전 리컨사일러는 base 없이 자기 인덱스만 보고 지운 파일을 되살렸다
  // (무한 부활). 대체는 base 스냅숏을 갖는 local-sync(3-way)다 — 이름이
  // 같은 옛 모듈이 되살아나면 안 된다.
  for (const gone of ['sync-core.ts', 'sync-fs.ts', 'sync-manager.ts']) {
    assert.ok(
      !existsSync(new URL(`../src/main/${gone}`, import.meta.url)),
      `레거시 엔진이 되살아났다: src/main/${gone}`,
    )
  }
})

// ── 409 충돌 재시도: 실제로 도는가 ────────────────────────────────────

test('전송 계층의 충돌 예외를 409 로 알아본다', () => {
  const e = new SyncConflictError('abc123')
  assert.equal((e as unknown as { status: number }).status, 409, 'status 가 없다')
  assert.match(e.message, /abc123/, '서버 sha 를 메시지에 안 남긴다')
})

test('쓰기가 충돌하면 최신 sha 로 다시 올린다 (EIO 로 끝내지 않는다)', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  let first = true
  const realPut = user.put.bind(user)
  user.put = async (path, fromAbs, baseSha) => {
    if (first) {
      first = false
      throw new SyncConflictError('서버가아는sha') // 캐시가 낡았다
    }
    return realPut(path, fromAbs, baseSha)
  }
  await be.write('/메모/내 메모.md', Buffer.from('새 내용\n'))
  assert.equal(user.files.get('메모/내 메모.md'), '새 내용\n', '재시도가 안 돌아 쓰기가 유실됐다')
})

test('삭제가 충돌해도 최신 sha 로 다시 지운다', async () => {
  const { be, user } = setup()
  await be.readdir('/')
  let first = true
  const realDel = user.del.bind(user)
  user.del = async (path, baseSha, opts) => {
    if (first) {
      first = false
      throw new SyncConflictError('서버가아는sha')
    }
    return realDel(path, baseSha, opts)
  }
  await be.remove('/내-PC/내 메모.md')
  assert.ok(!user.files.has('내-PC/내 메모.md'), '재시도가 안 돌아 삭제가 유실됐다')
})

// ── macOS/Windows: 조각 읽기와 다운로드 횟수 ──────────────────────────
//
// 두 OS 의 내장 WebDAV 클라이언트는 큰 파일을 Range 로 조각내 읽는다.
// 조각마다 서버에서 파일 전체를 내려받으면 100MB 파일 한 번 여는 데 수십 GB
// 가 오간다. Linux 는 FUSE 가 열 때 통째로 한 번 읽어서 안 드러났다.

test('같은 파일을 여러 번 읽어도 한 번만 내려받는다', async () => {
  const { be, user } = setup()
  const before = user.calls.filter((c) => c.startsWith('download:')).length
  await be.read('/자료/표.csv')
  await be.read('/자료/표.csv')
  await be.read('/자료/표.csv')
  const n = user.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `${n}번 내려받았다 — 캐시가 안 먹는다`)
})

test('부분 읽기가 정확한 조각을 준다', async () => {
  const { be } = setup()
  const whole = await be.read('/내-PC/내 메모.md')
  const part = await be.readRange('/내-PC/내 메모.md', 2, 5)
  assert.deepEqual(part, whole.subarray(2, 6))
})

test('조각을 여러 번 읽어도 내려받기는 한 번뿐이다', async () => {
  const { be, user } = setup()
  const before = user.calls.filter((c) => c.startsWith('download:')).length
  for (let i = 0; i < 5; i++) await be.readRange('/자료/표.csv', i, i + 1)
  const n = user.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `조각 5개에 ${n}번 내려받았다`)
})

test('내용이 바뀌면 캐시가 저절로 무효화된다 (키가 sha)', async () => {
  const { be, user } = setup()
  await be.read('/내-PC/내 메모.md')
  await be.write('/내-PC/내 메모.md', Buffer.from('완전히 다른 내용이다\n'))
  const after = await be.read('/내-PC/내 메모.md')
  assert.equal(after.toString(), '완전히 다른 내용이다\n', '낡은 캐시를 돌려줬다')
  assert.ok(user.calls.filter((c) => c.startsWith('download:')).length >= 2)
})

test('동시에 같은 파일을 읽어도 한 번만 내려받는다', async () => {
  const { be, user } = setup()
  const before = user.calls.filter((c) => c.startsWith('download:')).length
  await Promise.all([
    be.read('/자료/표.csv'),
    be.read('/자료/표.csv'),
    be.readRange('/자료/표.csv', 0, 3),
  ])
  const n = user.calls.filter((c) => c.startsWith('download:')).length - before
  assert.equal(n, 1, `동시 읽기가 ${n}번 내려받았다`)
})
