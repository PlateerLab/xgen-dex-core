/**
 * Linux FUSE 마운트 — 같은 `WebdavBackend` 를 파일시스템으로 노출한다.
 *
 * 리눅스에는 데스크톱 환경에 독립적인 내장 WebDAV 클라이언트가 없다
 * (davfs2 는 별도 설치 + 대개 root, gvfs 는 GNOME 전용). 그래서 리눅스만
 * FUSE 로 직접 붙인다 — 백엔드는 macOS/Windows 와 **완전히 동일**하고,
 * 여기서는 커널이 요구하는 POSIX 의미론만 얹는다.
 *
 * ── 실기에서 확인한 두 가지 제약 ─────────────────────────────────────
 *
 * 1. **같은 프로세스에서 마운트를 동기 IO 로 읽으면 데드락**이다. FUSE 콜백이
 *    이 이벤트 루프에 올라오는데 `readFileSync` 가 루프를 막아 서로를
 *    기다린다. 그래서 이 파일의 모든 백엔드 호출은 비동기이고, 커넥터의
 *    다른 코드는 절대 자기 마운트를 만지지 않는다.
 *
 * 2. **프로세스가 죽으면 스테일 마운트가 남는다** ("Transport endpoint is not
 *    connected"). 그 상태의 디렉터리는 이후 모든 접근을 거부하므로, 마운트
 *    전에 반드시 걷어내야 한다. 안 그러면 한 번 크래시한 사용자는 폴더가
 *    영구히 먹통이 된다.
 *
 * ── 쓰기 모델 ────────────────────────────────────────────────────────
 *
 * 커널은 write 를 오프셋 단위로 잘게 보낸다. 매 조각을 서버에 올리면 파일
 * 하나 저장에 수십 번 왕복한다. 그래서 **열린 파일마다 메모리 버퍼**를 두고
 * release/flush 에서 한 번만 올린다 (네트워크 파일시스템의 표준 방식).
 */

import { accessSync, constants, existsSync, statSync } from 'fs'
import { join } from 'path'
import { diag } from './diag-log'
import type { WebdavBackend } from './webdav-server'

/** FUSE 바인딩 (optionalDependency — 없으면 이 플랫폼은 미지원). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FuseModule = any

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

interface OpenFile {
  path: string
  buf: Buffer
  dirty: boolean
}

export interface FuseMountHandle {
  mountpoint: string
  unmount(): Promise<void>
}

/**
 * FUSE 바인딩을 불러온다.
 *
 * 프로덕션(번들된 CJS main)에서는 `require` 가 있다. 테스트는 ESM 이라
 * `require` 가 없으므로 **모듈을 주입**할 수 있게 열어 둔다 — 그래야 실제
 * 마운트를 거는 검증을 돌릴 수 있다.
 */
function loadFuse(injected?: FuseModule): FuseModule | null {
  if (injected) return injected
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@cocalc/fuse-native')
  } catch (e) {
    diag('fuse', `바인딩 로드 실패: ${(e as Error).message}`)
    return null
  }
}

/**
 * 스테일 마운트를 걷어낸다. 정상 마운트는 건드리지 않는다.
 *
 * 판정: 디렉터리를 읽어 보고 ENOTCONN/EIO 가 나면 스테일이다.
 */
export async function clearStale(mountpoint: string, exec: typeof runCmd = runCmd): Promise<void> {
  const probe = await listSafely(mountpoint)
  // 정상이거나 아예 없으면 할 일이 없다. ENOENT 는 "마운트 지점이 없다" 다.
  if (probe.ok || /ENOENT|no such file/i.test(probe.why)) return
  diag('fuse', `스테일 마운트 감지 ${mountpoint}: ${probe.why}`)
  for (const bin of fusermountBinaries()) {
    const r = await exec(bin, ['-uz', mountpoint])
    if (r.code === 0) {
      diag('fuse', '스테일 마운트 정리됨')
      return
    }
  }
  diag('fuse', '스테일 마운트를 정리하지 못했다')
}

/** 설치된 fusermount 후보 (시스템 경로 — 마운트 지점과 무관하다). */
function fusermountBinaries(): string[] {
  return ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount'].filter((b) =>
    existsSync(b),
  )
}

/**
 * 마운트 지점을 **이벤트 루프를 막지 않고** 읽어 본다.
 *
 * ⚠ 여기서 `readdirSync` 를 쓰면 앱이 통째로 멈춘다. FUSE 콜백이 이 루프에
 * 올라오는데 동기 호출이 루프를 잡고 있으면 서로를 기다린다 — 실기에서
 * [다시 연결] 을 누르는 순간 "응답하지 않습니다" 가 떴다.
 *
 * 비동기 readdir 은 libuv 스레드풀에서 돌아 루프가 살아 있으므로, 우리
 * 마운트가 살아 있으면 우리 콜백이 응답해 정상적으로 끝난다. 죽어 있으면
 * 오류로 끝난다. **어느 쪽도 아니게 매달리는** 경우(반쯤 죽은 마운트)를 위해
 * 타임아웃을 둔다 — 무한정 기다리면 그것도 멈춤이다.
 */
async function listSafely(
  dir: string,
  timeoutMs = 4000,
): Promise<{ ok: true; names: string[] } | { ok: false; why: string }> {
  const { readdir } = await import('fs/promises')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const names = await Promise.race([
      readdir(dir),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`응답 없음 (${timeoutMs}ms)`)), timeoutMs)
      }),
    ])
    return { ok: true, names }
  } catch (e) {
    return { ok: false, why: (e as Error).message }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runCmd(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _o, stderr) => {
      resolve({ code: err ? 1 : 0, stderr: String(stderr ?? '') })
    })
  })
}

/**
 * 백엔드를 FUSE 연산으로 옮긴다.
 *
 * 별도 함수로 뺀 이유: FUSE 바인딩 없이도 **연산 자체를 테스트**할 수 있어야
 * 한다 (네이티브 모듈은 CI 플랫폼마다 있고 없다).
 */
export function buildOps(backend: WebdavBackend, errno: Record<string, number>): Record<string, unknown> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0
  const open = new Map<number, OpenFile>()
  // 만들어졌지만 아직 서버에 올라가지 않은 파일. 커널은 create 직후 getattr 을
  // 하는데, 그때 서버에는 아직 없다 — 여기서 답해 준다.
  const pending = new Map<string, Buffer>()
  let nextFd = 10

  const ENOENT = errno.ENOENT ?? -2
  const EIO = errno.EIO ?? -5
  const EISDIR = errno.EISDIR ?? -21

  const stat = (isDir: boolean, size: number, mtime: Date) => ({
    mtime,
    atime: mtime,
    ctime: mtime,
    size: isDir ? 4096 : size,
    // 소유자만 읽기/쓰기 — 워크스페이스는 이 사용자만의 것이다.
    mode: isDir ? S_IFDIR | 0o700 : S_IFREG | 0o600,
    uid,
    gid,
    nlink: 1,
  })

  /** 콜백 규약: 실패는 errno 를 돌려주고 **절대 던지지 않는다** (던지면 커널이 멈춘다). */
  const guard =
    <A extends unknown[]>(name: string, fn: (...a: A) => Promise<void>) =>
    (...args: A): void => {
      // 마지막 인자가 콜백이라는 FUSE 규약.
      const cb = args[args.length - 1] as (code: number, ...rest: unknown[]) => void
      fn(...args).catch((e) => {
        diag('fuse', `${name} 실패: ${(e as Error).message}`)
        try {
          cb(EIO)
        } catch {
          /* 이미 응답했다 */
        }
      })
    }

  return {
    readdir: guard('readdir', async (path: string, cb: (c: number, names?: string[]) => void) => {
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      const kids = await backend.readdir(path)
      cb(0, ['.', '..', ...kids.map((k) => k.name)])
    }),

    getattr: guard('getattr', async (path: string, cb: (c: number, s?: unknown) => void) => {
      const held = pending.get(path)
      if (held) return cb(0, stat(false, held.length, new Date()))
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      cb(0, stat(node.isDir, node.size, node.mtime))
    }),

    open: guard('open', async (path: string, _flags: number, cb: (c: number, fd?: number) => void) => {
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      if (node.isDir) return cb(EISDIR)
      // 전체를 한 번 읽어 버퍼에 둔다 — 커널의 잘게 쪼갠 read/write 를
      // 매번 서버로 보내면 파일 하나에 수십 번 왕복한다.
      // **복사해서** 들고 있어야 한다. 백엔드가 내부 버퍼를 그대로 돌려주는
      // 구현이면(캐시 등) write 가 그 원본을 제자리에서 훼손해, flush 전인데도
      // 서버 쪽 내용이 바뀐 것처럼 보인다.
      const buf = Buffer.from(await backend.read(path))
      const fd = nextFd++
      open.set(fd, { path, buf, dirty: false })
      cb(0, fd)
    }),

    create: guard(
      'create',
      async (path: string, _mode: number, cb: (c: number, fd?: number) => void) => {
        // ⚠ 서버에 **빈 파일을 만들지 않는다.**
        //
        // 예전에는 여기서 즉시 0바이트를 PUT 했다. 커널이 바로 이어서 하는
        // getattr 이 ENOENT 로 실패하면 셸/편집기가 "Directory nonexistent" 로
        // 포기하기 때문이었다. 그런데 그 뒤 본문 PUT 이 한 번이라도 실패하면
        // **0바이트 파일만 서버에 남는다** — 실기에서 PDF 가 0 B 로 올라갔다.
        //
        // 대신 "아직 안 올라간 파일"을 여기서 기억하고 getattr 이 그것으로
        // 답한다. 서버에는 flush/release 때 **완성된 내용 한 번만** 올린다.
        pending.set(path, Buffer.alloc(0))
        const fd = nextFd++
        open.set(fd, { path, buf: Buffer.alloc(0), dirty: true })
        cb(0, fd)
      },
    ),

    read: guard(
      'read',
      async (
        path: string,
        fd: number,
        buffer: Buffer,
        length: number,
        position: number,
        cb: (n: number) => void,
      ) => {
        const f = open.get(fd)
        const src = f ? f.buf : await backend.read(path)
        const slice = src.subarray(position, position + length)
        slice.copy(buffer)
        cb(slice.length)
      },
    ),

    write: guard(
      'write',
      async (
        _path: string,
        fd: number,
        buffer: Buffer,
        length: number,
        position: number,
        cb: (n: number) => void,
      ) => {
        const f = open.get(fd)
        if (!f) return cb(EIO)
        if (position + length > f.buf.length) {
          const grown = Buffer.alloc(position + length)
          f.buf.copy(grown)
          f.buf = grown
        }
        buffer.subarray(0, length).copy(f.buf, position)
        f.dirty = true
        if (pending.has(f.path)) pending.set(f.path, f.buf)
        cb(length)
      },
    ),

    truncate: guard(
      'truncate',
      async (path: string, size: number, cb: (c: number) => void) => {
        const cur = await backend.read(path).catch(() => Buffer.alloc(0))
        const next = Buffer.alloc(size)
        cur.copy(next, 0, 0, Math.min(size, cur.length))
        await backend.write(path, next)
        cb(0)
      },
    ),

    ftruncate: guard(
      'ftruncate',
      async (_path: string, fd: number, size: number, cb: (c: number) => void) => {
        const f = open.get(fd)
        if (!f) return cb(EIO)
        const next = Buffer.alloc(size)
        f.buf.copy(next, 0, 0, Math.min(size, f.buf.length))
        f.buf = next
        f.dirty = true
        cb(0)
      },
    ),

    // flush 는 close() 마다 온다 — 여기서 올려야 편집기의 저장이 즉시 반영된다.
    flush: guard('flush', async (_path: string, fd: number, cb: (c: number) => void) => {
      const f = open.get(fd)
      if (f?.dirty) {
        // 완성된 내용을 **한 번만** 올린다. 실패하면 pending 을 그대로 두어
        // 다음 flush/release 가 다시 시도하고, 커널에는 오류를 돌려준다 —
        // 조용히 0바이트로 남는 것보다 낫다.
        await backend.write(f.path, f.buf)
        f.dirty = false
        pending.delete(f.path)
      }
      cb(0)
    }),

    release: guard('release', async (_path: string, fd: number, cb: (c: number) => void) => {
      const f = open.get(fd)
      if (f?.dirty) {
        await backend.write(f.path, f.buf)
        f.dirty = false
      }
      if (f) pending.delete(f.path)
      open.delete(fd)
      cb(0)
    }),

    unlink: guard('unlink', async (path: string, cb: (c: number) => void) => {
      await backend.remove(path)
      cb(0)
    }),

    mkdir: guard('mkdir', async (path: string, _mode: number, cb: (c: number) => void) => {
      await backend.mkdir(path)
      cb(0)
    }),

    rmdir: guard('rmdir', async (path: string, cb: (c: number) => void) => {
      await backend.remove(path)
      cb(0)
    }),

    rename: guard('rename', async (src: string, dest: string, cb: (c: number) => void) => {
      await backend.move(src, dest, true)
      cb(0)
    }),

    // 커널이 크기를 물어본다 — 0 을 주면 "디스크 꽉 참"으로 보여 쓰기가 막힌다.
    statfs: guard('statfs', async (_path: string, cb: (c: number, s?: unknown) => void) => {
      const bsize = 4096
      const blocks = 2 ** 30 // 4TiB 상당 — 클라우드라 실제 상한은 서버가 정한다
      cb(0, { bsize, frsize: bsize, blocks, bfree: blocks, bavail: blocks, files: 1e6, ffree: 1e6, namemax: 255 })
    }),

    // 소유자 변경/권한 변경은 받아만 준다 — 거부하면 편집기가 저장에 실패한다.
    chmod: (_p: string, _m: number, cb: (c: number) => void) => cb(0),
    chown: (_p: string, _u: number, _g: number, cb: (c: number) => void) => cb(0),
    utimens: (_p: string, _a: unknown, _m: unknown, cb: (c: number) => void) => cb(0),
  }
}

/**
 * 마운트 전 점검 — 바인딩이 "fuse failed" 한 줄만 주므로 여기서 원인을 짚는다.
 *
 * 실기에서 확인한 필수 조건: setuid-root `fusermount` (비루트 마운트),
 * 비어 있는 마운트 지점, `/dev/fuse` 접근 권한.
 */
/**
 * FUSE 를 쓸 수 있는 환경인가 — **시스템 쪽만** 본다 (마운트 지점은 안 만진다).
 *
 * 마운트 지점 검사와 섞으면 "이 함수는 마운트에 동기 IO 를 하지 않는다"를
 * 기계적으로 검증할 수 없다. 대상이 다르면 함수도 나눈다.
 */
export function checkFuseEnvironment(): PreflightProblem | null {
  const helper = ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount3', '/bin/fusermount']
    .map((p) => {
      try {
        return { p, st: statSync(p) }
      } catch {
        return null
      }
    })
    .find(Boolean)
  if (!helper) {
    return {
      error: 'FUSE 도우미(fusermount)가 없습니다.',
      hint: 'sudo apt install fuse3   (설치 후 앱을 다시 시작하세요)',
    }
  }
  // 비루트 마운트는 setuid-root 헬퍼가 있어야 한다.
  const mode = helper.st.mode
  if ((mode & 0o4000) === 0 || helper.st.uid !== 0) {
    return {
      error: `${helper.p} 에 setuid 권한이 없어 마운트할 수 없습니다.`,
      hint: `sudo chmod u+s ${helper.p}`,
    }
  }
  try {
    accessSync('/dev/fuse', constants.R_OK | constants.W_OK)
  } catch {
    return {
      error: '/dev/fuse 에 접근할 수 없습니다.',
      hint: '컨테이너/스냅 환경이면 FUSE 가 막혀 있을 수 있습니다. 일반 데스크톱 세션에서 실행해 보세요.',
    }
  }
  return null
}

/**
 * 마운트 지점이 붙일 수 있는 상태인가.
 *
 * ⚠ 이 함수는 **마운트 지점을 만진다** — 전부 비동기여야 한다.
 * 동기로 읽으면 반쯤 살아 있는 마운트에서 이벤트 루프가 잡혀 앱이 멈춘다
 * (실기: [다시 연결] → "응답하지 않습니다").
 */
export async function preflight(mountpoint: string): Promise<PreflightProblem | null> {
  const env = checkFuseEnvironment()
  if (env) return env
  // 마운트 지점은 비어 있어야 한다. 다만 **빈 디렉터리는 우리가 치운다** —
  // 내용이 있는 항목만 남으면 그때 사용자에게 알린다 (사용자 파일일 수 있다).
  // ⚠ 전부 **비동기**다. 마운트 지점을 동기로 읽으면 반쯤 살아 있는 마운트에서
  // 이벤트 루프가 잡혀 앱이 멈춘다 (실기: [다시 연결] → "응답하지 않습니다").
  const first = await listSafely(mountpoint)
  if (!first.ok) {
    return { error: `마운트 지점을 읽을 수 없습니다: ${first.why}` }
  }
  try {
    const { rmdir } = await import('fs/promises')
    for (const name of first.names) {
      const child = join(mountpoint, name)
      try {
        const kids = await listSafely(child)
        if (kids.ok && kids.names.length === 0) {
          await rmdir(child)
          diag('fuse', `빈 잔재 폴더 정리: ${name}`)
        }
      } catch {
        /* 못 지우면 아래에서 사용자에게 알린다 */
      }
    }
    const after = await listSafely(mountpoint)
    const left = after.ok ? after.names : first.names
    if (left.length > 0) {
      return {
        error: `마운트 지점에 파일이 남아 있어 연결할 수 없습니다 (${left.length}개)`,
        hint: `${mountpoint} 의 내용을 다른 곳으로 옮긴 뒤 다시 시도하세요 (남은 항목: ${left
          .slice(0, 5)
          .join(', ')}${left.length > 5 ? ' …' : ''}).`,
        strays: left,
      }
    }
  } catch (e) {
    return { error: `마운트 지점을 읽을 수 없습니다: ${(e as Error).message}` }
  }
  return null
}

export interface PreflightProblem {
  error: string
  hint?: string
  /** 마운트를 막고 있는 로컬 항목들 (있으면 rescueStrays 로 구해 낼 수 있다). */
  strays?: string[]
}

/**
 * 마운트를 막고 있는 로컬 파일들을 **옆으로 옮긴다**.
 *
 * FUSE 는 비어 있지 않은 폴더 위에 못 붙는다. 예전에는 여기서 그냥 실패했고,
 * 그래서 사용자가 (마운트가 아닌) 빈 폴더에 파일 하나를 넣는 순간 드라이브가
 * **영영 안 붙는** 상태가 됐다 — 그 파일을 지우라고 할 수도 없다. 사용자 것이다.
 *
 * 그래서 지우지 않고 형제 폴더로 옮긴다. 마운트한 뒤 클라우드로 올리고,
 * 올리기에 실패하면 그 폴더를 그대로 남겨 둔다 — 어느 쪽이든 파일은 살아 있다.
 *
 * @returns 옮긴 폴더 경로 (옮길 것이 없으면 null)
 */
export async function rescueStrays(mountpoint: string, stamp: string): Promise<string | null> {
  const probe = await listSafely(mountpoint)
  if (!probe.ok) return null
  const names = probe.names
  if (names.length === 0) return null
  const backup = `${mountpoint.replace(/[/\\]+$/, '')} (로컬 보관 ${stamp})`
  const { mkdir, rename } = await import('fs/promises')
  await mkdir(backup, { recursive: true })
  for (const name of names) {
    try {
      await rename(join(mountpoint, name), join(backup, name))
    } catch (e) {
      diag('fuse', `잔여 파일 이동 실패 ${name}: ${(e as Error).message}`)
    }
  }
  diag('fuse', `잔여 파일 ${names.length}개를 옮겼다: ${backup}`)
  return backup
}

/** 백엔드를 mountpoint 에 FUSE 로 붙인다. */
export async function mountFuse(
  backend: WebdavBackend,
  mountpoint: string,
  fuseModule?: FuseModule,
): Promise<{
  ok: boolean
  handle?: FuseMountHandle
  error?: string
  hint?: string
  /** 마운트를 막고 있는 로컬 항목 — 호출자가 rescueStrays 로 구해 낼 수 있다. */
  strays?: string[]
}> {
  const Fuse = loadFuse(fuseModule)
  if (!Fuse) {
    return {
      ok: false,
      error: '이 빌드에 FUSE 지원이 포함되어 있지 않습니다.',
      hint: 'libfuse2 를 설치한 뒤 다시 시도하세요 (sudo apt install libfuse2 fuse3).',
    }
  }
  await clearStale(mountpoint)
  try {
    // 비동기 — 살아 있는 마운트 위에서 동기 mkdir 은 getattr 콜백과 얽힌다.
    const { mkdir } = await import('fs/promises')
    await mkdir(mountpoint, { recursive: true })
  } catch (e) {
    return { ok: false, error: `마운트 지점을 만들지 못했습니다: ${(e as Error).message}` }
  }

  // 바인딩의 실패 메시지는 "fuse failed" 한 줄이라 원인을 알 수 없다.
  // 미리 짚어서 **무엇이 막혔는지** 말한다.
  const pre = await preflight(mountpoint)
  if (pre) {
    diag('fuse', `사전 점검 실패: ${pre.error}`)
    return { ok: false, ...pre }
  }

  const ops = buildOps(backend, Fuse as unknown as Record<string, number>)
  const fuse = new Fuse(mountpoint, ops, { force: true, mkdir: true, displayFolder: 'XGEN Workspace' })

  return new Promise((resolve) => {
    fuse.mount((err: Error | null) => {
      if (err) {
        diag('fuse', `마운트 실패: ${err.message}`)
        // 바인딩은 대개 "fuse failed" 한 줄만 준다 — 사전 점검을 통과했는데도
        // 실패했다는 사실 자체가 정보다.
        resolve({
          ok: false,
          error: `마운트 실패: ${err.message}`,
          hint:
            '사전 점검(fusermount setuid / /dev/fuse / 빈 폴더)은 통과했습니다. ' +
            '진단 로그를 보내 주세요.',
        })
        return
      }
      diag('fuse', `마운트 성공 → ${mountpoint}`)
      resolve({
        ok: true,
        handle: {
          mountpoint,
          unmount: () =>
            new Promise<void>((done) => {
              fuse.unmount(() => {
                // ⚠ 여기서 마운트 경로를 **동기로** 만지지 않는다. 언마운트
                // 콜백 시점에 커널이 아직 정리 중이면 그 호출이 우리 루프를
                // 막고, 곧 데드락이 된다. 정리는 비동기로 미룬다.
                setTimeout(() => {
                  void (async () => {
                    try {
                      const { readdir, rmdir } = await import('fs/promises')
                      if ((await readdir(mountpoint)).length === 0) await rmdir(mountpoint)
                    } catch {
                      /* 정리 실패는 무해 */
                    }
                  })()
                }, 0)
                diag('fuse', '언마운트 완료')
                done()
              })
            }),
        },
      })
    })
  })
}
