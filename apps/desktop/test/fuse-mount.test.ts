/**
 * Linux FUSE 마운트 — 커널이 요구하는 POSIX 의미론.
 *
 * 네이티브 바인딩 없이도 돌 수 있게 **연산(buildOps)만** 검증한다. 실제
 * 마운트는 리눅스 개발/CI 에서 별도로 확인했고(그때 잡힌 결함이 아래
 * `create` 테스트다), 여기서는 그 계약이 깨지지 않게 못을 박는다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { buildOps, clearStale, preflight } from '../src/main/fuse-mount'
import type { DavNode, WebdavBackend } from '../src/main/webdav-server'

const ERRNO = { ENOENT: -2, EIO: -5, EISDIR: -21 }

class Mem implements WebdavBackend {
  files = new Map<string, Buffer>([['/a.txt', Buffer.from('hello')]])
  dirs = new Set<string>(['/', '/sub'])
  private n(p: string, d: boolean, s: number): DavNode {
    return { name: p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1), isDir: d, size: s, mtime: new Date(0) }
  }
  async stat(p: string) {
    if (this.dirs.has(p)) return this.n(p, true, 0)
    const f = this.files.get(p)
    return f ? this.n(p, false, f.length) : null
  }
  async readdir(p: string) {
    const pre = p === '/' ? '/' : `${p}/`
    const out: DavNode[] = []
    for (const d of this.dirs) if (d !== p && d.startsWith(pre) && !d.slice(pre.length).includes('/')) out.push(this.n(d, true, 0))
    for (const [f, b] of this.files) if (f.startsWith(pre) && !f.slice(pre.length).includes('/')) out.push(this.n(f, false, b.length))
    return out
  }
  async read(p: string) {
    return this.files.get(p) ?? Buffer.alloc(0)
  }
  async write(p: string, d: Buffer) {
    this.files.set(p, d)
  }
  async mkdir(p: string) {
    this.dirs.add(p)
  }
  async remove(p: string) {
    this.files.delete(p)
    this.dirs.delete(p)
  }
  async move(a: string, b: string) {
    const f = this.files.get(a)
    if (f) {
      this.files.delete(a)
      this.files.set(b, f)
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ops = Record<string, (...a: any[]) => void>
function setup(): { ops: Ops; be: Mem } {
  const be = new Mem()
  return { ops: buildOps(be, ERRNO) as Ops, be }
}
/** 콜백형 FUSE 연산을 await 가능하게. */
function call(ops: Ops, name: string, ...args: unknown[]): Promise<unknown[]> {
  return new Promise((resolve) => ops[name](...args, (...r: unknown[]) => resolve(r)))
}

test('readdir 은 . 과 .. 를 포함한다 (커널 규약)', async () => {
  const { ops } = setup()
  const [code, names] = (await call(ops, 'readdir', '/')) as [number, string[]]
  assert.equal(code, 0)
  assert.ok(names.includes('.') && names.includes('..'), names.join(','))
  assert.ok(names.includes('a.txt') && names.includes('sub'))
})

test('없는 경로는 ENOENT', async () => {
  const { ops } = setup()
  assert.equal((await call(ops, 'getattr', '/nope'))[0], ERRNO.ENOENT)
  assert.equal((await call(ops, 'readdir', '/nope'))[0], ERRNO.ENOENT)
})

test('getattr 이 디렉터리/파일 모드를 구분한다', async () => {
  const { ops } = setup()
  const [, dir] = (await call(ops, 'getattr', '/sub')) as [number, { mode: number }]
  const [, file] = (await call(ops, 'getattr', '/a.txt')) as [number, { mode: number; size: number }]
  assert.ok((dir.mode & 0o040000) !== 0, '디렉터리 비트가 없다')
  assert.ok((file.mode & 0o100000) !== 0, '일반 파일 비트가 없다')
  assert.equal(file.size, 5)
})

test('디렉터리를 open 하면 EISDIR', async () => {
  const { ops } = setup()
  assert.equal((await call(ops, 'open', '/sub', 0))[0], ERRNO.EISDIR)
})

test('open → read 가 내용을 준다', async () => {
  const { ops } = setup()
  const [, fd] = (await call(ops, 'open', '/a.txt', 0)) as [number, number]
  const buf = Buffer.alloc(16)
  const [n] = (await call(ops, 'read', '/a.txt', fd, buf, 16, 0)) as [number]
  assert.equal(buf.subarray(0, n).toString(), 'hello')
})

test('write 는 버퍼에만 쌓이고 flush 에서 한 번 올라간다', async () => {
  // 커널은 write 를 잘게 보낸다 — 조각마다 서버로 보내면 파일 하나에 수십 번
  // 왕복한다.
  const { ops, be } = setup()
  const [, fd] = (await call(ops, 'open', '/a.txt', 0)) as [number, number]
  await call(ops, 'write', '/새 파일2.txt', fd, Buffer.from('HELLO'), 5, 0)
  assert.equal(be.files.get('/a.txt')?.toString(), 'hello', '조각마다 올렸다')
  await call(ops, 'flush', '/새 파일2.txt', fd)
  assert.equal(be.files.get('/a.txt')?.toString(), 'HELLO')
})

test('create 는 서버에 빈 파일을 만들지 않는다 (0바이트 잔존 방지)', async () => {
  // 예전에는 create 에서 즉시 0바이트를 PUT 했다. 그 뒤 본문 PUT 이 한 번이라도
  // 실패하면 **0바이트 파일만 서버에 남는다** — 실기에서 PDF 가 0 B 로 올라갔다.
  const { ops, be } = setup()
  await call(ops, 'create', '/새 파일.txt', 0o644)
  assert.equal(be.files.has('/새 파일.txt'), false, '서버에 빈 파일을 만들었다')
})

test('create 직후 getattr 이 성공한다 (커널이 곧바로 물어본다)', async () => {
  // 여기서 ENOENT 를 주면 셸/편집기가 "Directory nonexistent" 로 포기한다.
  const { ops } = setup()
  const [code] = (await call(ops, 'create', '/새 파일.txt', 0o644)) as [number, number]
  assert.equal(code, 0)
  const [gc] = (await call(ops, 'getattr', '/새 파일.txt')) as [number]
  assert.equal(gc, 0, 'create 직후 getattr 이 실패했다')
})

test('내용은 flush 때 한 번만 올라간다', async () => {
  const { ops, be } = setup()
  const [, fd] = (await call(ops, 'create', '/새 파일2.txt', 0o644)) as [number, number]
  await call(ops, 'write', '/새 파일2.txt', fd, Buffer.from('hello'), 5, 0)
  assert.equal(be.files.has('/새 파일2.txt'), false, 'flush 전에 올라갔다')
  await call(ops, 'flush', '/새 파일2.txt', fd)
  assert.equal(be.files.get('/새 파일2.txt')?.toString(), 'hello')
})

test('create 후 write→release 로 내용이 저장된다', async () => {
  const { ops, be } = setup()
  const [, fd] = (await call(ops, 'create', '/new.txt', 0o644)) as [number, number]
  await call(ops, 'write', '/new.txt', fd, Buffer.from('new\n'), 4, 0)
  await call(ops, 'release', '/new.txt', fd)
  assert.equal(be.files.get('/new.txt')?.toString(), 'new\n')
})

test('write 가 파일을 늘린다 (append 위치 쓰기)', async () => {
  const { ops, be } = setup()
  const [, fd] = (await call(ops, 'open', '/a.txt', 0)) as [number, number]
  await call(ops, 'write', '/새 파일2.txt', fd, Buffer.from('!!'), 2, 5)
  await call(ops, 'flush', '/새 파일2.txt', fd)
  assert.equal(be.files.get('/a.txt')?.toString(), 'hello!!')
})

test('ftruncate 가 버퍼를 자른다', async () => {
  const { ops, be } = setup()
  const [, fd] = (await call(ops, 'open', '/a.txt', 0)) as [number, number]
  await call(ops, 'ftruncate', '/a.txt', fd, 2)
  await call(ops, 'flush', '/새 파일2.txt', fd)
  assert.equal(be.files.get('/a.txt')?.toString(), 'he')
})

test('mkdir / rmdir / unlink / rename', async () => {
  const { ops, be } = setup()
  await call(ops, 'mkdir', '/d', 0o755)
  assert.ok(be.dirs.has('/d'))
  await call(ops, 'rename', '/a.txt', '/b.txt')
  assert.ok(be.files.has('/b.txt') && !be.files.has('/a.txt'))
  await call(ops, 'unlink', '/b.txt')
  assert.ok(!be.files.has('/b.txt'))
  await call(ops, 'rmdir', '/d')
  assert.ok(!be.dirs.has('/d'))
})

test('statfs 가 0 이 아닌 용량을 준다', async () => {
  // 0 을 주면 "디스크 꽉 참"으로 보여 쓰기가 아예 막힌다.
  const { ops } = setup()
  const [code, st] = (await call(ops, 'statfs', '/')) as [number, { blocks: number; bavail: number }]
  assert.equal(code, 0)
  assert.ok(st.blocks > 0 && st.bavail > 0)
})

test('백엔드가 던져도 커널에 EIO 를 돌려준다 (절대 throw 하지 않는다)', async () => {
  // 콜백에서 던지면 커널이 응답을 못 받아 프로세스가 멈춘다.
  const be = new Mem()
  be.read = async () => {
    throw new Error('네트워크 끊김')
  }
  const ops = buildOps(be, ERRNO) as Ops
  const [code] = (await call(ops, 'open', '/a.txt', 0)) as [number]
  assert.equal(code, ERRNO.EIO)
})

test('chmod/chown/utimens 는 받아만 준다', async () => {
  // 거부하면 편집기가 저장에 실패한다 (권한 설정을 시도하는 편집기가 많다).
  const { ops } = setup()
  assert.equal((await call(ops, 'chmod', '/새 파일2.txt', 0o644))[0], 0)
  assert.equal((await call(ops, 'chown', '/a.txt', 0, 0))[0], 0)
  assert.equal((await call(ops, 'utimens', '/a.txt', 0, 0))[0], 0)
})

test('정상 마운트 지점은 스테일 정리가 건드리지 않는다', async () => {
  let called = false
  await clearStale('/tmp', async () => {
    called = true
    return { code: 0, stderr: '' }
  })
  assert.equal(called, false, '읽히는 디렉터리에 fusermount -u 를 실행했다')
})

test('없는 경로는 스테일 정리 대상이 아니다', async () => {
  let called = false
  await clearStale('/nonexistent-xgen-mount', async () => {
    called = true
    return { code: 0, stderr: '' }
  })
  assert.equal(called, false)
})

test('사전 점검이 원인을 특정한다 (바인딩은 "fuse failed" 한 줄만 준다)', async (ctx) => {
  // FUSE 는 리눅스 전용 — 다른 OS 에서는 "fusermount 없음"이 먼저 걸린다.
  if (process.platform !== 'linux') return ctx.skip('linux 전용')
  const { mkdtempSync, writeFileSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')

  // 마운트 지점에 파일이 남아 있으면 FUSE 가 붙지 못한다 — 그 사실을 말해야 한다.
  const dir = mkdtempSync(join(tmpdir(), 'pf-'))
  writeFileSync(join(dir, 'leftover.txt'), 'x')
  const r = await preflight(dir)
  assert.ok(r, '남은 파일을 감지하지 못했다')
  assert.match(r!.error, /파일이 남아 있어/)
  assert.ok(r!.hint && r!.hint.length > 0, '해결 방법이 없다')
})

test('빈 마운트 지점은 사전 점검을 통과한다 (이 리눅스 기준)', async (ctx) => {
  if (process.platform !== 'linux') return ctx.skip('linux 전용')
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  const r = await preflight(mkdtempSync(join(tmpdir(), 'pf-ok-')))
  // 이 개발/CI 머신은 fuse3 + setuid fusermount 가 있다. 없으면 그 사유가
  // 정확히 나와야 한다 (그것도 정상 동작이다).
  if (r) {
    assert.match(r.error, /fusermount|\/dev\/fuse/)
    assert.ok(r.hint, `사유는 있는데 해결 방법이 없다: ${r.error}`)
  }
})

test('빈 잔재 폴더는 스스로 치우고, 내용 있는 것만 사용자에게 알린다', async (ctx) => {
  if (process.platform !== 'linux') return ctx.skip('linux 전용')
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')

  const dir = mkdtempSync(join(tmpdir(), 'pf-clean-'))
  // 예전 버전이 만들던 빈 에이전트 폴더 — 우리 잔재이므로 우리가 치운다
  mkdirSync(join(dir, 'XGeny_copy'))
  assert.equal(await preflight(dir), null, '빈 잔재를 치우지 못해 마운트가 막혔다')
  assert.ok(!existsSync(join(dir, 'XGeny_copy')), '빈 잔재가 남아 있다')

  // 내용이 있으면 사용자 파일일 수 있다 — 절대 지우지 않고 알린다
  mkdirSync(join(dir, '내 폴더'))
  writeFileSync(join(dir, '내 폴더', 'data.txt'), 'user data')
  const r = await preflight(dir)
  assert.ok(r, '내용 있는 폴더를 감지하지 못했다')
  assert.match(r!.hint ?? '', /내 폴더/)
  assert.ok(existsSync(join(dir, '내 폴더', 'data.txt')), '사용자 파일을 지웠다')
})
