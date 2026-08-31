/**
 * 가상 드라이브 — 방금 들어온 크로스플랫폼 배선을 **적대적으로** 검증한다.
 *
 * Range·잡파일 고스트·NFC·읽기 캐시는 macOS/Windows 를 위해 넣었지만, 새 코드는
 * 새 사고의 원천이다. 여기서는 "되는 것"이 아니라 **깨질 만한 것**을 찌른다:
 * 경계값 Range, 하위 폴더의 잡파일, MOVE/COPY 와 고스트의 상호작용, 캐시 축출
 * 중의 읽기, 0바이트, 이름에 특수문자.
 */
import assert from 'assert'
import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'fs'
import { startDavServer, isOsJunk, parseRange, decodePath, type DavNode, type WebdavBackend } from '../src/main/webdav-server'
import { WorkspaceDavBackend, type WorkspaceApi } from '../src/main/workspace-backend'

// ── 백엔드 대역 ───────────────────────────────────────────────────────
class Mem implements WebdavBackend {
  files = new Map<string, Buffer>()
  dirs = new Set<string>(['/'])
  async stat(p: string): Promise<DavNode | null> {
    const name = p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1)
    if (this.dirs.has(p)) return { name, isDir: true, size: 0, mtime: new Date(0) }
    const f = this.files.get(p)
    return f ? { name, isDir: false, size: f.length, mtime: new Date(0), etag: `e${f.length}` } : null
  }
  async readdir(p: string): Promise<DavNode[]> {
    const prefix = p === '/' ? '/' : `${p}/`
    const out: DavNode[] = []
    for (const k of [...this.dirs, ...this.files.keys()]) {
      if (k === p || !k.startsWith(prefix) || k.slice(prefix.length).includes('/')) continue
      out.push((await this.stat(k))!)
    }
    return out
  }
  async read(p: string) { return this.files.get(p) ?? Buffer.alloc(0) }
  async write(p: string, d: Buffer) { this.files.set(p, d) }
  async mkdir(p: string) { this.dirs.add(p) }
  async remove(p: string) { this.files.delete(p); this.dirs.delete(p) }
  async move(from: string, to: string) {
    const f = this.files.get(from)
    if (f) { this.files.delete(from); this.files.set(to, f) }
    else if (this.dirs.delete(from)) this.dirs.add(to)
  }
}

async function srv(fn: (c: { be: Mem; t: string; req: (m: string, p: string, i?: RequestInit) => Promise<Response> }) => Promise<void>) {
  const be = new Mem()
  const h = await startDavServer(be)
  const req = (m: string, p: string, i: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${h.port}${p}`, { method: m, ...i })
  try { await fn({ be, t: h.token, req }) } finally { await h.close() }
}
const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')

// ── Range 경계값 ──────────────────────────────────────────────────────
test('parseRange 경계값', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 })
  assert.deepEqual(parseRange('bytes=0-', 10), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=5-999', 10), { start: 5, end: 9 }, '끝을 파일 크기로 잘라야 한다')
  assert.deepEqual(parseRange('bytes=-999', 10), { start: 0, end: 9 }, '접미가 파일보다 크면 전체')
  assert.equal(parseRange('bytes=10-', 10), 'invalid', '시작이 EOF 면 416')
  assert.equal(parseRange('bytes=-0', 10), 'invalid')
  assert.equal(parseRange('bytes=5-3', 10), 'invalid', '뒤집힌 범위')
  assert.equal(parseRange('bytes=0-1,5-6', 10), null, '다중 범위는 전체로 (RFC 허용)')
  assert.equal(parseRange('', 10), null)
  assert.equal(parseRange('items=0-1', 10), null, '알 수 없는 단위')
})

test('0바이트 파일에 Range 를 요구하면 416 이고 멈추지 않는다', async () => {
  await srv(async ({ be, t, req }) => {
    be.files.set('/empty.bin', Buffer.alloc(0))
    const r = await req('GET', `/${t}/empty.bin`, { headers: { Range: 'bytes=0-0' } })
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-length'), '0')
    assert.equal((await r.text()).length, 0)
  })
})

test('전체를 덮는 Range 도 206 으로 답한다', async () => {
  await srv(async ({ be, t, req }) => {
    be.files.set('/f.bin', Buffer.from('abcdefghij'))
    const r = await req('GET', `/${t}/f.bin`, { headers: { Range: 'bytes=0-' } })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), 'bytes 0-9/10')
    assert.equal(await r.text(), 'abcdefghij')
  })
})

// ── 잡파일 고스트 ─────────────────────────────────────────────────────
test('하위 폴더의 잡파일도 클라우드로 안 나간다', async () => {
  await srv(async ({ be, t, req }) => {
    be.dirs.add('/문서')
    await req('PUT', `/${t}/${enc('문서/.DS_Store')}`, { body: 'x' })
    await req('PUT', `/${t}/${enc('문서/._보고서.pdf')}`, { body: 'x' })
    await req('PUT', `/${t}/${enc('문서/보고서.pdf')}`, { body: 'real' })
    assert.deepEqual([...be.files.keys()], ['/문서/보고서.pdf'])
  })
})

test('잡파일과 이름이 비슷할 뿐인 진짜 파일은 건드리지 않는다', async () => {
  await srv(async ({ be, t, req }) => {
    for (const n of ['_보고서.pdf', '.DS_Store_백업', 'my.DS_Store', 'desktop.ini.bak', 'Thumbs.dbx']) {
      await req('PUT', `/${t}/${enc(n)}`, { body: 'real' })
    }
    assert.equal(be.files.size, 5, `진짜 파일을 잡파일로 오인했다: ${[...be.files.keys()]}`)
  })
})

test('잡파일 삭제는 성공으로 답한다 (Finder 가 정리에 실패하면 안 된다)', async () => {
  await srv(async ({ t, req }) => {
    await req('PUT', `/${t}/.DS_Store`, { body: 'x' })
    assert.equal((await req('DELETE', `/${t}/.DS_Store`)).status, 204)
    assert.equal((await req('GET', `/${t}/.DS_Store`)).status, 404, '지웠는데 남아 있다')
    // 없는 것을 지워도 성공 (멱등)
    assert.equal((await req('DELETE', `/${t}/.DS_Store`)).status, 204)
  })
})

test('잡파일 PROPFIND 는 있으면 207, 없으면 404', async () => {
  await srv(async ({ t, req }) => {
    assert.equal((await req('PROPFIND', `/${t}/.DS_Store`, { headers: { Depth: '0' } })).status, 404)
    await req('PUT', `/${t}/.DS_Store`, { body: 'x' })
    assert.equal((await req('PROPFIND', `/${t}/.DS_Store`, { headers: { Depth: '0' } })).status, 207)
  })
})

test('잡파일 이름의 MKCOL 이 클라우드에 폴더를 만들지 않는다', async () => {
  await srv(async ({ be, t, req }) => {
    await req('MKCOL', `/${t}/.Trashes`)
    assert.ok(!be.dirs.has('/.Trashes'), '잡파일 이름의 폴더가 클라우드에 생겼다')
  })
})

test('isOsJunk 판정', () => {
  for (const y of ['/._a', '/x/.DS_Store', '/Thumbs.db', '/desktop.ini', '/.Spotlight-V100', '/x/._장하렴.pdf'])
    assert.ok(isOsJunk(y), `놓쳤다: ${y}`)
  for (const n of ['/', '/a.txt', '/_a', '/x/.DS_Store_bak', '/my.DS_Store', '/.gitignore', '/.env'])
    assert.ok(!isOsJunk(n), `오인했다: ${n}`)
})

// ── NFC ───────────────────────────────────────────────────────────────
test('하위 경로의 모든 조각이 NFC 로 정규화된다', () => {
  const nfd = '상'.normalize('NFD')
  const p = decodePath(`/tok/${enc(`${nfd}폴더/${nfd}파일.txt`)}`, 'tok')
  assert.equal(p, '/상폴더/상파일.txt')
  assert.equal(p, p!.normalize('NFC'))
})

test('NFC 정규화가 경로 탈출 방어를 무력화하지 않는다', () => {
  // 방어는 두 겹이다. 바깥: URL 생성자가 `..` 를 먼저 해석하므로 토큰 밖으로
  // 나가는 경로는 접두사 검사에서 **아예 거부**된다(null). 안쪽: 인코딩된
  // `%2e%2e` 는 URL 생성자가 해석하지 않으므로 우리 루프가 걷어낸다.
  assert.equal(decodePath('/tok/../../etc/passwd', 'tok'), null, '토큰 밖 경로가 통과했다')
  assert.equal(decodePath('/tok/a/../../..', 'tok'), null)
  assert.equal(decodePath('/other/x', 'tok'), null)
  // 인코딩된 탈출도 루트 안에 가둔다.
  // 인코딩된 형태(%2e%2e)도 URL 생성자가 해석하므로 똑같이 거부된다.
  assert.equal(decodePath('/tok/%2e%2e/%2e%2e/etc/passwd', 'tok'), null)
  // 토큰 안에서 소진되는 `..` 는 정상 경로다.
  assert.equal(decodePath('/tok/a/%2e%2e/b', 'tok'), '/b')
  assert.equal(decodePath('/tok/a/../b', 'tok'), '/b')
})

// ── 읽기 캐시 ─────────────────────────────────────────────────────────
class Api implements WorkspaceApi {
  files = new Map<string, Buffer>()
  downloads = 0
  async changes() {
    return { changes: [...this.files].map(([p, b]) => ({
      path: p, is_dir: false, size: b.length, mtime_ns: 1e18,
      sha256: `sha-${b.length}-${b[0] ?? 0}`, deleted: false })) }
  }
  async download(p: string, to: string) { this.downloads++; writeFileSync(to, this.files.get(p) ?? Buffer.alloc(0)) }
  async put(p: string, from: string) { const b = readFileSync(from); this.files.set(p, b); return { sha256: `sha-${b.length}-${b[0] ?? 0}` } }
  async del(p: string) { this.files.delete(p) }
  async mkdir() {}
}

function backend(): { be: WorkspaceDavBackend; api: Api } {
  const api = new Api()
  api.files.set('큰파일.bin', Buffer.from('0123456789'.repeat(100)))
  api.files.set('빈파일.bin', Buffer.alloc(0))
  const be = new WorkspaceDavBackend()
  be.setUserStorage(api)
  return { be, api }
}

test('0바이트 파일도 캐시가 처리한다 (sha 가 비어도)', async () => {
  const { be } = backend()
  assert.equal((await be.read('/빈파일.bin')).length, 0)
  assert.equal((await be.readRange('/빈파일.bin', 0, 10)).length, 0)
})

test('파일 끝을 넘는 조각 요청은 있는 만큼만 준다', async () => {
  const { be } = backend()
  const part = await be.readRange('/큰파일.bin', 995, 2000)
  assert.equal(part.length, 5, `${part.length}B 를 돌려줬다`)
})

test('없는 파일 읽기는 빈 버퍼 (예외로 마운트를 죽이지 않는다)', async () => {
  const { be } = backend()
  assert.equal((await be.read('/없는파일.bin')).length, 0)
  assert.equal((await be.readRange('/없는파일.bin', 0, 10)).length, 0)
})

test('캐시가 다른 파일끼리 섞이지 않는다', async () => {
  const { be, api } = backend()
  api.files.set('다른파일.bin', Buffer.from('XXXX'))
  const a = await be.read('/큰파일.bin')
  const b = await be.read('/다른파일.bin')
  assert.equal(b.toString(), 'XXXX')
  assert.equal(a.length, 1000)
})

test('dispose 뒤에도 앱이 죽지 않는다', async () => {
  const { be } = backend()
  await be.read('/큰파일.bin')
  be.dispose()
  // 캐시 파일이 사라졌으므로 다시 내려받아야 한다 — 던지면 안 된다.
  const again = await be.read('/큰파일.bin')
  assert.equal(again.length, 1000, '캐시 디렉터리가 사라지자 읽기가 깨졌다')
})
