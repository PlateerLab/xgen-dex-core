/**
 * FUSE 마운트 호스트 — **별도 프로세스**로 실행된다.
 *
 *     Electron 메인            이 프로세스
 *     ─────────────            ───────────
 *     WebdavBackend            FUSE 마운트
 *     로컬 WebDAV 서버  ←HTTP─  얇은 브리지
 *
 * ── 왜 프로세스를 나누나 ─────────────────────────────────────────────
 *
 * 1. **네이티브 크래시가 앱을 죽이면 안 된다.** FUSE 바인딩이 Electron 메인에서
 *    SIGSEGV 를 내면 커넥터가 통째로 사라진다 (실기: 클라우드 폴더에 파일을
 *    넣는 순간 앱이 죽었다 — v1.15.0 에서 원인은 고쳤지만, 네이티브 코드가
 *    메인에 있는 한 같은 계열의 사고가 또 난다). 여기서 죽으면 부모는 살아서
 *    이유를 보여주고 다시 띄운다.
 *
 * 2. **데드락이 구조적으로 사라진다.** FUSE 콜백이 메인 이벤트 루프에 올라오면
 *    자기 마운트를 건드리는 동기 호출 하나가 서로를 기다리게 만든다. 그동안
 *    이 문제를 세 번 겪었고 그때마다 "동기 IO 금지" 규칙으로 막아 왔는데,
 *    루프가 아예 다르면 규칙 없이도 성립한다.
 *
 * 브리지가 WebDAV 를 쓰는 이유: macOS/Windows 가 이미 같은 서버에 붙는다.
 * 백엔드 로직(트리 캐시·base_sha·MOVE 의미론)이 한 벌로 유지된다.
 */

import { request } from 'http'
import { mountFuse } from './fuse-mount'
import type { DavNode, WebdavBackend } from './webdav-server'

/** 부모가 argv 로 넘기는 실행 인자. */
interface HostArgs {
  /** 로컬 WebDAV 루트 (토큰 포함). 예: http://127.0.0.1:1234/<token> */
  davUrl: string
  mountpoint: string
}

function parseArgs(argv: string[]): HostArgs | null {
  const dav = argv.find((a) => a.startsWith('--dav='))?.slice('--dav='.length)
  const mp = argv.find((a) => a.startsWith('--mount='))?.slice('--mount='.length)
  return dav && mp ? { davUrl: dav, mountpoint: mp } : null
}

/** 부모에게 한 줄 상태를 알린다 (부모가 stdout 을 읽는다). */
function say(kind: string, detail = ''): void {
  process.stdout.write(`${kind}${detail ? ` ${detail}` : ''}\n`)
}

interface DavReply {
  status: number
  body: Buffer
  headers: Record<string, string | string[] | undefined>
}

/** WebDAV 서버로 한 번 왕복. 실패는 예외로 올린다. */
function dav(method: string, url: string, body?: Buffer, extra?: Record<string, string>): Promise<DavReply> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { ...(body ? { 'content-length': String(body.length) } : {}), ...(extra ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
        )
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/** 경로를 WebDAV URL 로. 세그먼트마다 인코딩한다 (공백·한글·# 등). */
function toUrl(base: string, path: string): string {
  const enc = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `${base.replace(/\/+$/, '')}/${enc}`
}

/**
 * WebDAV 를 `WebdavBackend` 로 보이게 감싼다.
 *
 * FUSE 쪽 코드(fuse-mount)는 이 인터페이스만 알면 되므로, 부모에서 직접
 * 백엔드를 쓰던 때와 **한 줄도 다르지 않게** 동작한다.
 */
function davBackend(base: string): WebdavBackend {
  const propfind = async (path: string, depth: '0' | '1'): Promise<Array<DavNode & { href: string }>> => {
    const r = await dav('PROPFIND', toUrl(base, path), undefined, { depth })
    if (r.status === 404) return []
    if (r.status >= 400) throw new Error(`PROPFIND ${r.status}`)
    const xml = r.body.toString('utf8')
    const out: Array<DavNode & { href: string }> = []
    // 서버가 우리 자신이라 형식이 고정돼 있다 — 최소 파서로 충분하다.
    for (const m of xml.matchAll(/<D:response>([\s\S]*?)<\/D:response>/g)) {
      const chunk = m[1]
      const href = decodeURIComponent(/<D:href>([^<]*)<\/D:href>/.exec(chunk)?.[1] ?? '')
      const isDir = /<D:collection\s*\/>/.test(chunk)
      const size = Number(/<D:getcontentlength>(\d+)<\/D:getcontentlength>/.exec(chunk)?.[1] ?? 0)
      const mtime = /<D:getlastmodified>([^<]*)<\/D:getlastmodified>/.exec(chunk)?.[1]
      const name = href.replace(/\/+$/, '').split('/').pop() ?? ''
      out.push({ name, isDir, size, mtime: mtime ? new Date(mtime) : new Date(), href })
    }
    return out
  }

  return {
    async stat(path) {
      const rows = await propfind(path, '0')
      if (!rows[0]) return null
      const { name, isDir, size, mtime } = rows[0]
      return { name, isDir, size, mtime }
    },
    async readdir(path) {
      const rows = await propfind(path, '1')
      // depth=1 의 **첫 항목은 자기 자신**이다. 이름으로 거르면 같은 이름의
      // 자식(예: a/a)까지 사라지므로 href 로 판별한다.
      const selfHref = rows[0]?.href
      return rows
        .filter((r) => r.href !== selfHref)
        .map(({ name, isDir, size, mtime }) => ({ name, isDir, size, mtime }))
    },
    async read(path) {
      const r = await dav('GET', toUrl(base, path))
      if (r.status >= 400) throw new Error(`GET ${r.status}`)
      return r.body
    },
    async write(path, data) {
      const r = await dav('PUT', toUrl(base, path), data)
      // 상태코드만 남기면 원인이 여기서 소멸한다 — 부모가 실어 보낸 이유를
      // 그대로 올린다. 커널에는 어차피 EIO 하나뿐이라, 로그가 유일한 단서다.
      if (r.status >= 400) throw new Error(`PUT ${r.status}: ${r.body.toString().slice(0, 300)}`)
    },
    async mkdir(path) {
      const r = await dav('MKCOL', toUrl(base, path))
      if (r.status >= 400 && r.status !== 405) throw new Error(`MKCOL ${r.status}`)
    },
    async remove(path) {
      const r = await dav('DELETE', toUrl(base, path))
      if (r.status >= 400 && r.status !== 404) throw new Error(`DELETE ${r.status}`)
    },
    async move(from, to) {
      const r = await dav('MOVE', toUrl(base, from), undefined, { destination: toUrl(base, to) })
      if (r.status >= 400) throw new Error(`MOVE ${r.status}`)
    },
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(1))
  if (!args) {
    say('error', '실행 인자가 없습니다 (--dav=, --mount= 필요)')
    process.exit(2)
  }
  // 이 프로세스가 죽더라도 **부모는 살아 있어야 한다**. 여기서 죽는 것은
  // 부모가 감지해 사용자에게 사유를 보여주고 다시 띄우는 신호일 뿐이다.
  process.on('uncaughtException', (e) => say('error', `처리되지 않은 예외: ${e?.message}`))
  process.on('unhandledRejection', (e) => say('error', `처리되지 않은 거부: ${String(e)}`))

  const r = await mountFuse(davBackend(args.davUrl), args.mountpoint)
  if (!r.ok) {
    say('mount-failed', `${r.error ?? ''}|${r.hint ?? ''}`)
    process.exit(1)
  }
  say('mounted', args.mountpoint)

  const stop = async (): Promise<void> => {
    try {
      await r.handle?.unmount()
    } catch {
      /* 부모가 clearStale 로 마무리한다 */
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  // 부모가 stdin 을 닫으면(=부모가 사라졌으면) 마운트를 남기지 않고 정리한다.
  process.stdin.on('end', () => void stop())
  process.stdin.resume()
}

void main()
