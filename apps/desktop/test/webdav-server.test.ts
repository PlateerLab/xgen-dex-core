/**
 * 로컬 WebDAV 서버 — 가상 드라이브의 공통 핵심.
 *
 * 여기서 고정하는 것은 **클라이언트가 실제로 요구하는 것들**이다. 이 중
 * 하나만 빠져도 마운트가 조용히 실패하거나 읽기 전용으로 붙는다:
 *   - DAV: 1,2 (class 2 = 잠금) / MS-Author-Via
 *   - PROPFIND 멀티스테이터스 형식, Depth 0/1
 *   - LOCK 이 락 토큰을 돌려줄 것
 * 그리고 보안 계약: 루프백 전용 + 비밀 토큰 + 경로 탈출 차단.
 */
import assert from 'assert'
import { test } from 'node:test'
import { decodePath, startDavServer, xmlEscape, type DavNode, type WebdavBackend } from '../src/main/webdav-server'

/** 테스트용 메모리 백엔드 — 경로 -> 내용(파일) 또는 null(디렉터리). */
class MemBackend implements WebdavBackend {
  files = new Map<string, Buffer>()
  dirs = new Set<string>(['/'])

  async stat(p: string): Promise<DavNode | null> {
    const name = p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1)
    if (this.dirs.has(p)) return { name, isDir: true, size: 0, mtime: new Date(0) }
    const f = this.files.get(p)
    if (f) return { name, isDir: false, size: f.length, mtime: new Date(0), etag: `e${f.length}` }
    return null
  }

  async readdir(p: string): Promise<DavNode[]> {
    const prefix = p === '/' ? '/' : `${p}/`
    const out: DavNode[] = []
    for (const d of this.dirs) {
      if (d === p || !d.startsWith(prefix)) continue
      if (d.slice(prefix.length).includes('/')) continue
      out.push((await this.stat(d))!)
    }
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix) || f.slice(prefix.length).includes('/')) continue
      out.push((await this.stat(f))!)
    }
    return out
  }

  async read(p: string): Promise<Buffer> {
    return this.files.get(p) ?? Buffer.alloc(0)
  }
  async write(p: string, d: Buffer): Promise<void> {
    this.files.set(p, d)
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p)
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p)
    this.dirs.delete(p)
  }
  async move(from: string, to: string): Promise<void> {
    const f = this.files.get(from)
    if (f) {
      this.files.delete(from)
      this.files.set(to, f)
    } else if (this.dirs.delete(from)) {
      this.dirs.add(to)
    }
  }
}

async function withServer(
  fn: (ctx: { url: string; token: string; be: MemBackend; req: (m: string, p: string, o?: RequestInit) => Promise<Response> }) => Promise<void>,
): Promise<void> {
  const be = new MemBackend()
  const h = await startDavServer(be)
  const req = (method: string, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${h.port}${path}`, { method, ...init })
  try {
    await fn({ url: h.url(), token: h.token, be, req })
  } finally {
    await h.close()
  }
}

test('루프백에만 바인딩하고 비밀 토큰 경로를 쓴다', async () => {
  await withServer(async ({ url, token }) => {
    assert.ok(url.startsWith('http://127.0.0.1:'), `외부에 노출됐다: ${url}`)
    assert.ok(token.length >= 16, '토큰이 너무 짧다')
    assert.ok(url.endsWith(`/${token}/`))
  })
})

test('토큰이 틀리면 존재 자체를 알리지 않는다 (401 아닌 404)', async () => {
  await withServer(async ({ req }) => {
    const r = await req('PROPFIND', '/wrong-token/', { headers: { Depth: '0' } })
    assert.equal(r.status, 404)
  })
})

test('OPTIONS 가 DAV class 2 와 MS-Author-Via 를 광고한다', async () => {
  // 이게 없으면 macOS 는 붙지 않고 Windows 는 읽기 전용으로 붙는다.
  await withServer(async ({ req, token }) => {
    const r = await req('OPTIONS', `/${token}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('dav') ?? '', /\b2\b/)
    assert.equal(r.headers.get('ms-author-via'), 'DAV')
    assert.match(r.headers.get('allow') ?? '', /PROPFIND/)
    assert.match(r.headers.get('allow') ?? '', /LOCK/)
  })
})

test('LOCK 이 락 토큰을 돌려준다 (쓰기 가능 판정의 근거)', async () => {
  await withServer(async ({ req, token }) => {
    const r = await req('LOCK', `/${token}/a.txt`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('lock-token') ?? '', /^<opaquelocktoken:/)
    assert.match(await r.text(), /<D:locktoken>/)
    assert.equal((await req('UNLOCK', `/${token}/a.txt`)).status, 204)
  })
})

test('PROPFIND Depth:1 이 자식을 나열한다', async () => {
  await withServer(async ({ req, token, be }) => {
    await be.write('/hello.txt', Buffer.from('hi'))
    await be.mkdir('/sub')
    const r = await req('PROPFIND', `/${token}/`, { headers: { Depth: '1' } })
    assert.equal(r.status, 207)
    assert.match(r.headers.get('content-type') ?? '', /xml/)
    const xml = await r.text()
    assert.match(xml, /<D:multistatus/)
    assert.match(xml, /hello\.txt/)
    assert.match(xml, /sub/)
    // 디렉터리는 collection 으로, 파일은 길이를 가진다
    assert.match(xml, /<D:collection\/>/)
    assert.match(xml, /<D:getcontentlength>2<\/D:getcontentlength>/)
  })
})

test('PROPFIND Depth:0 은 자기 자신만 준다', async () => {
  await withServer(async ({ req, token, be }) => {
    await be.write('/a.txt', Buffer.from('x'))
    const xml = await (await req('PROPFIND', `/${token}/`, { headers: { Depth: '0' } })).text()
    assert.ok(!xml.includes('a.txt'), 'Depth:0 인데 자식이 섞였다')
  })
})

test('디렉터리에는 getcontentlength 를 주지 않는다', async () => {
  // 일부 클라이언트가 이를 파일 신호로 읽어 폴더를 열지 못한다.
  await withServer(async ({ req, token, be }) => {
    await be.mkdir('/folder')
    const xml = await (await req('PROPFIND', `/${token}/folder`, { headers: { Depth: '0' } })).text()
    assert.match(xml, /<D:collection\/>/)
    assert.ok(!/getcontentlength/.test(xml), '디렉터리에 길이가 붙었다')
  })
})

test('PUT / GET / HEAD 왕복', async () => {
  await withServer(async ({ req, token, be }) => {
    const created = await req('PUT', `/${token}/note.txt`, { body: 'hello dav' })
    assert.equal(created.status, 201, '새 파일은 201')
    assert.equal(be.files.get('/note.txt')?.toString(), 'hello dav')

    const again = await req('PUT', `/${token}/note.txt`, { body: 'v2' })
    assert.equal(again.status, 204, '덮어쓰기는 204')

    const g = await req('GET', `/${token}/note.txt`)
    assert.equal(g.status, 200)
    assert.equal(await g.text(), 'v2')
    assert.equal(g.headers.get('accept-ranges'), 'bytes')

    const h = await req('HEAD', `/${token}/note.txt`)
    assert.equal(h.headers.get('content-length'), '2')
    assert.equal(await h.text(), '', 'HEAD 에 본문이 실렸다')
  })
})

test('디렉터리 GET 은 405 (파일이 아니다)', async () => {
  await withServer(async ({ req, token, be }) => {
    await be.mkdir('/d')
    assert.equal((await req('GET', `/${token}/d`)).status, 405)
  })
})

test('MKCOL / DELETE', async () => {
  await withServer(async ({ req, token, be }) => {
    assert.equal((await req('MKCOL', `/${token}/newdir`)).status, 201)
    assert.ok(be.dirs.has('/newdir'))
    assert.equal((await req('MKCOL', `/${token}/newdir`)).status, 405, '중복 생성은 405')
    assert.equal((await req('DELETE', `/${token}/newdir`)).status, 204)
    assert.equal((await req('DELETE', `/${token}/newdir`)).status, 404, '없는 것 삭제는 404')
  })
})

test('MOVE 와 COPY', async () => {
  await withServer(async ({ req, token, be }) => {
    await be.write('/a.txt', Buffer.from('data'))
    const dest = (p: string) => ({ Destination: `http://127.0.0.1/${token}${p}` })

    assert.equal((await req('MOVE', `/${token}/a.txt`, { headers: dest('/b.txt') })).status, 201)
    assert.ok(!be.files.has('/a.txt') && be.files.has('/b.txt'))

    assert.equal((await req('COPY', `/${token}/b.txt`, { headers: dest('/c.txt') })).status, 201)
    assert.equal(be.files.get('/c.txt')?.toString(), 'data')

    // Overwrite: F 로 기존 대상을 덮으려 하면 412
    const r = await req('MOVE', `/${token}/b.txt`, {
      headers: { ...dest('/c.txt'), Overwrite: 'F' },
    })
    assert.equal(r.status, 412)
  })
})

test('경로 탈출은 서버에서 끝난다 (백엔드가 루트 밖을 못 본다)', () => {
  const t = 'tok'
  // URL 파서가 dot-segment 를 먼저 정규화하므로, 탈출 시도는 **토큰 접두사
  // 자체를 벗어나** 거부된다 — 백엔드에 루트 밖 경로가 도달할 길이 없다.
  assert.equal(decodePath(`/${t}/../../etc/passwd`, t), null)
  assert.equal(decodePath(`/${t}/a/../../..`, t), null)
  assert.equal(decodePath(`/${t}/%2e%2e/x`, t), null, '인코딩된 .. 도 막아야 한다')
  // 접두사 안에서의 .. 는 정상 해석
  assert.equal(decodePath(`/${t}/a/b/../c`, t), '/a/c')
  assert.equal(decodePath(`/${t}/`, t), '/')
  assert.equal(decodePath(`/${t}`, t), '/')
  // 다른/없는 토큰은 거부
  assert.equal(decodePath('/other/a', t), null)
  assert.equal(decodePath('/', t), null)
})

test('한글·공백·기호가 든 이름이 왕복한다', async () => {
  await withServer(async ({ req, token, be }) => {
    const name = '실행통계 30일 & 요약.xlsx'
    const r = await req('PUT', `/${token}/${encodeURIComponent(name)}`, { body: 'X' })
    assert.equal(r.status, 201)
    assert.ok(be.files.has(`/${name}`), [...be.files.keys()].join(','))

    const xml = await (await req('PROPFIND', `/${token}/`, { headers: { Depth: '1' } })).text()
    // & 가 이스케이프되지 않으면 XML 파서가 응답 전체를 버린다
    assert.ok(!/[^&]&(?!amp;|lt;|gt;|quot;)/.test(xml), `XML 이스케이프가 깨졌다: ${xml.slice(0, 400)}`)
    assert.match(xml, /실행통계/)
  })
})

test('xmlEscape 가 XML 을 깨는 문자를 전부 막는다', () => {
  assert.equal(xmlEscape('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e')
})

test('모르는 메서드는 405 와 Allow 를 준다', async () => {
  await withServer(async ({ req, token }) => {
    const r = await req('PATCH', `/${token}/x`)
    assert.equal(r.status, 405)
    assert.match(r.headers.get('allow') ?? '', /PROPFIND/)
  })
})

test('없는 파일 PROPFIND/GET 은 404', async () => {
  await withServer(async ({ req, token }) => {
    assert.equal((await req('PROPFIND', `/${token}/nope`, { headers: { Depth: '0' } })).status, 404)
    assert.equal((await req('GET', `/${token}/nope`)).status, 404)
  })
})

// ── macOS / Windows 클라이언트 계약 ───────────────────────────────────
//
// Linux 는 FUSE 자식이 **우리가 만든 관대한 클라이언트**로 말한다. macOS
// `webdavfs` 와 Windows WebClient 는 OS 내장 클라이언트라 프로토콜을 엄격히
// 쓴다 — 그래서 이 표면은 리눅스 실기로는 검증되지 않는다. 여기 고정한다.

const BIG = Buffer.from('0123456789'.repeat(1000)) // 10,000 B

test('Range 요청에 206 + Content-Range 로 답한다', async () => {
  // macOS webdavfs / Windows WebClient 는 큰 파일을 조각조각 읽는다. 전체를
  // 돌려주면 조각마다 파일 전체가 서버에서 내려와 타임아웃에 걸린다.
  await withServer(async ({ be, req, token }) => {
    be.files.set('/big.bin', BIG)
    const r = await req('GET', `/${token}/big.bin`, { headers: { Range: 'bytes=100-199' } })
    assert.equal(r.status, 206, 'Range 를 무시하고 전체를 돌려준다')
    const body = Buffer.from(await r.arrayBuffer())
    assert.equal(body.length, 100)
    assert.equal(r.headers.get('content-range'), `bytes 100-199/${BIG.length}`)
    assert.deepEqual(body, BIG.subarray(100, 200))
  })
})

test('접미 Range(마지막 N 바이트)도 지원한다', async () => {
  await withServer(async ({ be, req, token }) => {
    be.files.set('/big.bin', BIG)
    const r = await req('GET', `/${token}/big.bin`, { headers: { Range: 'bytes=-50' } })
    assert.equal(r.status, 206)
    const body = Buffer.from(await r.arrayBuffer())
    assert.deepEqual(body, BIG.subarray(BIG.length - 50))
  })
})

test('만족할 수 없는 Range 는 416 이고 본문을 기다리게 하지 않는다', async () => {
  await withServer(async ({ be, req, token }) => {
    be.files.set('/big.bin', BIG)
    const r = await req('GET', `/${token}/big.bin`, { headers: { Range: 'bytes=99999-' } })
    assert.equal(r.status, 416)
    assert.equal(r.headers.get('content-range'), `bytes */${BIG.length}`)
    // Content-Length 를 물려주면 클라이언트가 오지 않을 바이트를 기다린다.
    assert.equal(r.headers.get('content-length'), '0')
  })
})

test('Range 가 없으면 예전처럼 200 + 전체', async () => {
  await withServer(async ({ be, req, token }) => {
    be.files.set('/big.bin', BIG)
    const r = await req('GET', `/${token}/big.bin`)
    assert.equal(r.status, 200)
    assert.equal(Buffer.from(await r.arrayBuffer()).length, BIG.length)
  })
})

test('OS 메타데이터 파일은 클라우드로 나가지 않는다', async () => {
  // macOS 는 파일마다 ._<이름>(AppleDouble)과 .DS_Store 를, Windows 는
  // desktop.ini/Thumbs.db 를 남긴다. 그대로 두면 사용자의 클라우드가 이
  // 쓰레기로 뒤덮이고 웹 화면에도 전부 보인다.
  await withServer(async ({ be, req, token }) => {
    for (const name of ['._장하렴.pdf', '.DS_Store', 'desktop.ini', 'Thumbs.db']) {
      const r = await req('PUT', `/${token}/${encodeURIComponent(name)}`, { body: 'junk' })
      assert.ok(r.status < 300, `${name} 쓰기를 거부하면 Finder 가 복사를 중단한다`)
    }
    await req('PUT', `/${token}/${encodeURIComponent('진짜.pdf')}`, { body: 'real' })
    assert.deepEqual([...be.files.keys()], ['/진짜.pdf'], '잡파일이 클라우드로 나갔다')
  })
})

test('잡파일은 세션 안에서는 읽히되 목록에는 안 보인다', async () => {
  await withServer(async ({ be, req, token }) => {
    await req('PUT', `/${token}/.DS_Store`, { body: 'finder' })
    const g = await req('GET', `/${token}/.DS_Store`)
    assert.equal(g.status, 200, 'Finder 가 방금 쓴 것을 못 읽으면 혼란스러워한다')
    assert.equal(await g.text(), 'finder')

    // 예전 버전이 이미 올려 둔 것도 가린다.
    be.files.set('/.DS_Store', Buffer.from('old'))
    be.files.set('/문서.txt', Buffer.from('x'))
    const r = await req('PROPFIND', `/${token}/`, { headers: { Depth: '1' } })
    const names = [...(await r.text()).matchAll(/<D:displayname>([^<]*)</g)].map((m) => m[1])
    assert.ok(!names.includes('.DS_Store'), `목록에 잡파일이 보인다: ${names.join(',')}`)
    assert.ok(names.includes('문서.txt'), `진짜 파일이 사라졌다: ${names.join(',')}`)
  })
})

test('macOS 의 NFD 파일명이 NFC 로 수렴한다', async () => {
  // 정규화하지 않으면 같은 이름이 서로 다른 두 파일이 되어 목록에 두 번 뜨고
  // 한쪽에서 지워도 다른 쪽이 남는다.
  const nfd = '상'.normalize('NFD')
  assert.notEqual(nfd, '상', '테스트 전제가 틀렸다')
  await withServer(async ({ be, req, token }) => {
    await req('PUT', `/${token}/${encodeURIComponent(`${nfd}.txt`)}`, { body: 'mac' })
    assert.deepEqual([...be.files.keys()], ['/상.txt'], 'NFD 그대로 저장됐다')
  })
})

test('NFD 로 만든 파일을 NFC 로 지울 수 있다 (그 반대도)', async () => {
  const nfd = '상'.normalize('NFD')
  await withServer(async ({ be, req, token }) => {
    await req('PUT', `/${token}/${encodeURIComponent(`${nfd}.txt`)}`, { body: 'mac' })
    const r = await req('DELETE', `/${token}/${encodeURIComponent('상.txt')}`)
    assert.equal(r.status, 204)
    assert.deepEqual([...be.files.keys()], [], '정규화가 갈려 삭제가 빗나갔다')
  })
})
