/**
 * sync-transport — sync-protocol 의 `Transport` 를 XGEN workspace 저장소 API 위에
 * against the XGEN geny-workspace storage API (xgen-workflow), plus the
 * thin change-notify WebSocket client
 * (/api/agentflow/ws/geny-workspace/{workflowId}).
 *
 * Geny desktop/sync-transport 이식 — 축이 세션이 아니라 **에이전트
 * (workflowId)** 라는 점만 다르고 프로토콜(base_sha 낙관적 동시성, 청크/
 * 재개 업로드, thin WS notify)은 동일하다.
 *
 * 경로: `Transport` 는 WORKSPACE 상대 경로를 쓰고 REST API 는
 * storage-root-relative ("workspace/<p>") — mapped here and nowhere else.
 */

import { createReadStream, createWriteStream } from 'fs'
import { createHash } from 'crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import WebSocket from 'ws'
import { ApprovalPendingError, ChangesResponse, SyncConflictError, Transport } from './sync-protocol'
import { xgenWebSocketTlsOptions } from './connection-security'

export type NetworkFetch = (input: string | Request, init?: RequestInit) => Promise<Response>

export interface TransportAuth {
  baseUrl: string // e.g. https://xgen.example.com (no trailing slash)
  token: () => string | Promise<string>
  workflowId: string
  deviceId: string
  /**
   * 이 PC 의 표시 이름. **쓰기 요청에도 실어야 한다.**
   *
   * 예전에는 WS 접속(hello)에서만 보냈다. 그런데 업로드가 먼저 도착하면 서버는
   * 이름 없이 기기를 등록하고 그대로 굳는다 — 그러면 웹이 id 앞 8자를 이름처럼
   * 보여주고(`b5b5f5cf`), 그 기기는 클라우드 안에서 자기 폴더를 갖지 못한다.
   */
  deviceName?: string
  /** Electron net.fetch를 주입해 설정된 XGEN 서버의 인증서 정책을 공유한다. */
  fetch?: NetworkFetch
  /** 설정된 XGEN WebSocket의 사설 인증서를 허용한다. */
  allowPrivateCertificate?: boolean
  /**
   * 인증 실패(401/403) 시 **자가치유** — 호스트가 refresh 토큰으로 액세스 토큰을
   * 회전시키고(single-flight) 새 토큰을 돌려준다. 게이트웨이는 토큰 회전/세션
   * 회수 때 이전 세션 키를 지우므로, 이 훅이 없으면 장수명 소비자(WS·동기화)는
   * 폐기된 토큰으로 **영원히 재시도**한다 (실기: 채팅은 되는데 WS 만 403).
   * null 반환 = 회전 불가(재로그인 대상) — 그때는 기존 백오프 재시도만 남는다.
   */
  refreshAuth?: () => Promise<string | null>
}

function wsPath(p: string): string {
  return `workspace/${p}`
}

function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

async function authHeaders(auth: TransportAuth): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await auth.token()}` }
}

async function transportFetch(auth: TransportAuth, input: string, init?: RequestInit): Promise<Response> {
  const f = auth.fetch ?? globalThis.fetch
  const res = await f(input, init)
  // 401 = 토큰이 회전/회수됐다 — refresh 로 한 번 자가치유 후 같은 요청을 재발송.
  // 본문은 전부 Buffer(스트림 아님)라 재사용이 안전하다. 403 은 재시도하지 않는다
  // (권한 거부·정책 거부 — 토큰을 바꿔도 결과가 같고, 서버 안내를 살려야 한다).
  if (res.status === 401 && auth.refreshAuth) {
    const fresh = await Promise.resolve(auth.refreshAuth()).catch(() => null)
    if (fresh) {
      const headers = {
        ...((init?.headers as Record<string, string> | undefined) ?? {}),
        Authorization: `Bearer ${fresh}`,
      }
      return f(input, { ...init, headers })
    }
  }
  return res
}

/** Files above this go through the chunked/resumable path. */
const CHUNK_THRESHOLD_DEFAULT = 64 * 1024 * 1024
const CHUNK_SIZE = 8 * 1024 * 1024

/**
 * 서버가 준 실패 사유를 살려 예외로 만든다.
 *
 * ⚠ 상태코드만 남기면 **원인이 여기서 소멸한다.** 실기 사고: 관리자가 조직
 * 전체에서 클라우드 스토리지를 끄면 서버는 403 과 함께 "클라우드 스토리지
 * 기능이 비활성화되어 있습니다" 를 주는데, 커넥터에는 `changes HTTP 403` 만
 * 남아 사용자에게는 그냥 "연결 불가" 로 보였다. 어디서 껐는지도, 무엇을 해야
 * 하는지도 알 수 없었다.
 *
 * FastAPI 는 오류 본문을 `{"detail": "..."}` 로 준다.
 */
async function httpError(what: string, res: Response): Promise<Error & { status: number }> {
  let detail = ''
  try {
    const body = await res.text()
    if (body) {
      try {
        const parsed = JSON.parse(body) as { detail?: unknown }
        const d = parsed?.detail
        detail = typeof d === 'string' ? d : d ? JSON.stringify(d) : body
      } catch {
        detail = body
      }
    }
  } catch {
    /* 본문을 못 읽어도 상태코드는 남긴다 */
  }
  const msg = detail ? `${what} HTTP ${res.status}: ${detail.slice(0, 300)}` : `${what} HTTP ${res.status}`
  return Object.assign(new Error(msg), { status: res.status })
}

/**
 * PUT/commit 의 409 본문을 해석해 알맞은 에러를 만든다.
 *
 * 서버는 두 가지 다른 이유로 409 를 낸다:
 *   1. **낙관적 동시성 충돌**(`detail.current_sha`) — 재시도로 해소한다.
 *   2. **정책 거부**(`detail.conflict === 'root_file'`) — 클라우드 루트에는
 *      파일을 만들 수 없다. 이건 재시도해도 영원히 같은 409 다. 그래서
 *      `SyncConflictError` **로 감싸지 않는다** — 감싸면 백엔드의 `isConflict`
 *      가 참이 되어 무한 재시도에 빠지고, 서버의 안내 메시지도 사라진다.
 *      상태코드도 싣지 않는다(`isConflict` 가 `.status===409` 도 보므로).
 */
function conflict409(body: unknown): Error {
  const detail = (body as { detail?: unknown })?.detail
  if (detail && typeof detail === 'object' && (detail as { conflict?: string }).conflict === 'root_file') {
    const d = detail as { message?: string; suggest_folder?: string }
    return new Error(d.message || '클라우드 루트에는 파일을 만들 수 없습니다. 폴더 안에 저장하세요.')
  }
  return new SyncConflictError((detail as { current_sha?: string })?.current_sha)
}

export class HttpSyncTransport implements Transport {
  private chunkThreshold: number

  constructor(
    private auth: TransportAuth,
    private tmpDir: string,
    opts: { chunkThresholdBytes?: number } = {},
  ) {
    this.chunkThreshold = opts.chunkThresholdBytes ?? CHUNK_THRESHOLD_DEFAULT
  }

  private url(path: string, qs: Record<string, string | number | undefined> = {}): string {
    const u = new URL(
      `${this.auth.baseUrl}/api/agentflow/geny-workspace/${encodeURIComponent(this.auth.workflowId)}${path}`,
    )
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined) u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  async changes(since: number): Promise<ChangesResponse> {
    const res = await transportFetch(this.auth, this.url('/storage/changes', { since }), {
      headers: await authHeaders(this.auth),
    })
    if (!res.ok) throw await httpError('changes', res)
    return (await res.json()) as ChangesResponse
  }

  async download(path: string, toAbs: string): Promise<void> {
    const res = await transportFetch(this.auth, this.url(`/storage-raw/${encPath(wsPath(path))}`), {
      headers: await authHeaders(this.auth),
    })
    if (!res.ok || !res.body) {
      throw await httpError('download', res)
    }
    await mkdir(this.tmpDir, { recursive: true })
    const tmp = join(this.tmpDir, `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp))
      await mkdir(dirname(toAbs), { recursive: true })
      await rename(tmp, toAbs)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
  }

  async put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }> {
    const size = (await stat(fromAbs)).size
    if (size > this.chunkThreshold) {
      return this.putChunked(path, fromAbs, baseSha, size)
    }
    const res = await transportFetch(
      this.auth,
      this.url('/storage/file', {
        path: wsPath(path),
        base_sha: baseSha,
        device: this.auth.deviceId,
        device_name: this.auth.deviceName,
      }),
      {
        method: 'PUT',
        headers: {
          ...(await authHeaders(this.auth)),
          'Content-Type': 'application/octet-stream',
          // ⚠ **Content-Length 를 직접 넣지 않는다.**
          //
          // Chromium 의 fetch 에서 Content-Length 는 *금지 헤더*다. 이 전송
          // 계층은 설정된 XGEN 서버의 인증서 정책을 공유하려고 Electron
          // `net.fetch`(Chromium 네트워크 스택)를 주입받는데, 금지 헤더가
          // 붙으면 요청을 **보내기도 전에** 거부한다:
          //
          //     net::ERR_INVALID_ARGUMENT
          //
          // 그래서 주입이 들어간 뒤로 단일 PUT 이 전부 실패했고, 드라이브에
          // 파일을 복사하면 close() 에서 EIO 로 끝났다. 헤더를 안 넣는 청크
          // 업로드 경로만 멀쩡했던 이유이기도 하다.
          // 길이는 fetch 가 바디에서 알아서 계산한다.
        },
        // ⚠ **버퍼로 보낸다. 스트림 바디를 쓰면 안 된다.**
        //
        // `Readable.toWeb(...)` + `duplex:'half'` 는 Node(undici) 전용이다.
        // 이 전송 계층은 설정된 XGEN 서버의 인증서 정책을 공유하려고
        // Electron `net.fetch`(Chromium 네트워크 스택)를 주입받는데,
        // Chromium 은 ReadableStream 업로드를 지원하지 않는다. 그래서 주입이
        // 들어간 순간부터 **단일 PUT 이 전부 실패**했다 — 드라이브에 파일을
        // 복사하면 close() 에서 EIO. 8MiB 씩 Buffer 로 보내는 청크 경로만
        // 멀쩡했던 이유이기도 하다.
        //
        // 여기 오는 파일은 chunkThreshold 이하이고, 상위 FUSE 계층이 이미
        // 전체 내용을 메모리에 들고 있다. 버퍼링이 새 비용을 만들지 않는다.
        body: (await readFile(fromAbs)) as unknown as BodyInit,
      },
    )
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}) as any)
      throw conflict409(body)
    }
    if (!res.ok) throw await httpError('put', res)
    const data = (await res.json()) as { sha256: string }
    return { sha256: data.sha256 }
  }

  /** Chunked/resumable upload for large files: start → sequential 8MiB
   *  parts (resuming from the server's byte count after any hiccup) →
   *  atomic commit with the same base_sha conflict contract as PUT. */
  private async putChunked(
    path: string,
    fromAbs: string,
    baseSha: string,
    size: number,
  ): Promise<{ sha256: string }> {
    const sha = await hashFileSha256(fromAbs)
    const startRes = await transportFetch(
      this.auth,
      this.url('/storage/file/chunks/start', { path: wsPath(path), size, sha256: sha }),
      { method: 'POST', headers: await authHeaders(this.auth) },
    )
    if (!startRes.ok) {
      throw await httpError('chunk start', startRes)
    }
    const { upload_id: uploadId } = (await startRes.json()) as { upload_id: string }

    let offset = 0
    let attempts = 0
    let stalls = 0
    const fd = await open(fromAbs, 'r')
    try {
      while (offset < size) {
        const len = Math.min(CHUNK_SIZE, size - offset)
        const buf = Buffer.alloc(len)
        const { bytesRead } = await fd.read(buf, 0, len, offset)
        if (bytesRead <= 0) throw new Error('local file shrank during chunked upload')
        try {
          const res = await transportFetch(
            this.auth,
            this.url(`/storage/file/chunks/${uploadId}`, { offset }),
            {
              method: 'PUT',
              headers: {
                ...(await authHeaders(this.auth)),
                'Content-Type': 'application/octet-stream',
              },
              body: buf.subarray(0, bytesRead) as unknown as BodyInit,
            },
          )
          if (res.status === 409) {
            // out-of-sync — server tells us the true resume point.
            // Progress guard: a resume point that never advances would
            // otherwise hammer the server in a tight loop.
            const body = (await res.json().catch(() => ({}))) as any
            const resume = Number(body?.detail?.received ?? 0)
            if (resume <= offset) {
              if (++stalls > 3) throw new Error('chunked upload stalled (no resume progress)')
            } else {
              stalls = 0
            }
            offset = resume
            continue
          }
          if (!res.ok) throw await httpError('chunk', res)
          const data = (await res.json()) as { received: number }
          offset = data.received
          attempts = 0
        } catch (e) {
          if ((e as any)?.status) throw e // HTTP-level error: don't loop
          // network hiccup → ask the server where to resume
          if (++attempts > 5) throw e
          await new Promise((r) => setTimeout(r, 1000 * attempts))
          const st = await transportFetch(this.auth, this.url(`/storage/file/chunks/${uploadId}`), {
            headers: await authHeaders(this.auth),
          })
          if (st.ok) offset = Number(((await st.json()) as any).received ?? offset)
        }
      }
    } finally {
      await fd.close()
    }

    const commit = await transportFetch(
      this.auth,
      this.url(`/storage/file/chunks/${uploadId}/commit`, { base_sha: baseSha, device: this.auth.deviceId, device_name: this.auth.deviceName }),
      { method: 'POST', headers: await authHeaders(this.auth) },
    )
    if (commit.status === 409) {
      const body = (await commit.json().catch(() => ({}))) as any
      throw conflict409(body)
    }
    if (!commit.ok) {
      throw await httpError('chunk commit', commit)
    }
    const done = (await commit.json()) as { sha256: string }
    return { sha256: done.sha256 }
  }

  /**
   * 항목 삭제.
   *
   * ⚠ `force` 는 **사용자가 직접 지웠을 때만** 켠다 (가상 드라이브에서의 삭제).
   * 서버는 force 없는 삭제를 "동기화 레플리카의 요청"으로 보고 fail-closed 로
   * 다룬다 — 파일은 base_sha 필수, 폴더는 비어 있을 때만. 낡은 레플리카가
   * 에이전트 산출물을 쓸어 담는 사고를 막는 가드라서, 리컨사일 엔진은 절대
   * 켜면 안 된다.
   *
   * 반대로 사용자가 드라이브에서 지운 것은 추론이 아니라 **명시적 의사**다.
   * 여기에 force 를 안 실어 보내서 서버가 409(base_sha_required /
   * dir_not_empty)를 돌려주었고, 그게 그대로 실패로 올라가 **드라이브에서
   * 지워도 파일이 그대로 남았다** (폴더 삭제는 항상 실패했다).
   */
  async del(path: string, baseSha?: string, opts: { force?: boolean } = {}): Promise<void> {
    const res = await transportFetch(
      this.auth,
      this.url('/storage/entry', {
        path: wsPath(path),
        base_sha: baseSha,
        device: this.auth.deviceId,
        device_name: this.auth.deviceName,
        ...(opts.force ? { force: 'true' } : {}),
      }),
      { method: 'DELETE', headers: await authHeaders(this.auth) },
    )
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}) as any)
      throw new SyncConflictError(body?.detail?.current_sha)
    }
    if (res.status === 404) throw Object.assign(new Error('not found'), { status: 404 })
    if (!res.ok) throw await httpError('delete', res)
  }

  async mkdir(path: string): Promise<void> {
    const res = await transportFetch(this.auth, this.url('/storage/mkdir', { path: wsPath(path) }), {
      method: 'POST',
      headers: await authHeaders(this.auth),
    })
    if (res.status === 409) return // already exists — fine
    if (!res.ok) throw await httpError('mkdir', res)
    // ⚠ 200 인데도 아무것도 안 만들어졌을 수 있다 — 새 최상위 폴더(=새 저장소)는
    // RAG 통제가 켜져 있으면 관리자 승인 대기로 미뤄지고, 서버는 그 사실을
    // 여전히 `{ok:true, status:"pending_approval"}` 로 돌려준다(폴더는 없다).
    // 여기서 안 걸러내면 드라이브엔 폴더가 "생긴 것"처럼 보이고 실제로는
    // 서버·다른 기기 어디에도 없는 유령 폴더가 된다.
    const body = await res.json().catch(() => null as { status?: string; request_id?: number } | null)
    if (body?.status === 'pending_approval') {
      throw new ApprovalPendingError(body.request_id, path)
    }
  }
}

/** Thin change-notification listener with auto-reconnect. Fires
 *  `onChanged(latestSeq)` whenever the server says the workspace moved,
 *  `onState(connected)` on connection transitions. */
export class WorkspaceWsClient {
  private ws: WebSocket | null = null
  private closed = false
  private retryMs = 2000
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private auth: TransportAuth,
    private deviceName: string,
    private onChanged: (latestSeq: number) => void,
    private onState: (connected: boolean) => void,
  ) {}

  async start(): Promise<void> {
    this.closed = false
    await this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
    this.ws = null
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    let ws: WebSocket
    try {
      const base = this.auth.baseUrl.replace(/^http/, 'ws')
      const token = await this.auth.token()
      const url = `${base}/api/agentflow/ws/geny-workspace/${encodeURIComponent(this.auth.workflowId)}`
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        ...xgenWebSocketTlsOptions(this.auth.allowPrivateCertificate === true),
      })
    } catch {
      // token/keychain hiccup must not kill reconnection forever
      this.onState(false)
      const delay = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, 60_000)
      setTimeout(() => void this.connect(), delay)
      return
    }
    this.ws = ws

    ws.on('open', () => {
      // Reset backoff only once the connection SURVIVES a few seconds —
      // an accept-then-close server (expired auth) must keep backing off.
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) this.retryMs = 2000
      }, 5000)
      this.onState(true)
      // Defensive: a send failure must degrade to a reconnect, never an
      // uncaught main-process exception (error dialog).
      const safeSend = (payload: unknown): void => {
        try {
          ws.send(JSON.stringify(payload))
        } catch {
          try { ws.close() } catch { /* already gone */ }
        }
      }
      safeSend({
        type: 'hello',
        data: { device_id: this.auth.deviceId, device_name: this.deviceName },
      })
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          safeSend({ type: 'heartbeat', ts: Date.now() })
        }
      }, 25_000)
    })
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg?.type === 'changed' || msg?.type === 'state') {
          const seq = Number(msg?.data?.latest_seq ?? 0)
          this.onChanged(seq)
        }
      } catch {
        /* ignore malformed frames */
      }
    })
    let retried = false
    const scheduleRetry = () => {
      // unexpected-response 와 close 가 겹쳐도 재시도 타이머는 한 번만.
      if (retried) return
      retried = true
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.onState(false)
      if (this.closed) return
      const delay = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, 60_000)
      setTimeout(() => void this.connect(), delay)
    }
    // 핸드셰이크가 401/403 으로 거절됐다 = 토큰이 회전됐거나 세션이 회수된 것.
    // 이 리스너가 없으면 'error' 로만 떨어져 **폐기된 토큰으로 영원히 재시도**한다
    // (실기: 게이트웨이 "session revoked" 403 무한 반복). refresh 로 토큰을
    // 회전시킨 뒤 재시도한다 — 다음 connect() 가 auth.token() 으로 새 토큰을 집는다.
    ws.on('unexpected-response', (_req, res) => {
      const sc = res?.statusCode ?? 0
      try { res?.resume?.() } catch { /* drain */ }
      const heal =
        (sc === 401 || sc === 403) && this.auth.refreshAuth
          ? Promise.resolve(this.auth.refreshAuth()).catch(() => null)
          : Promise.resolve(null)
      void heal.then((fresh) => {
        // 토큰이 실제로 회전됐으면 백오프를 리셋해 즉시 다시 붙는다.
        if (fresh) this.retryMs = 2000
        try { ws.close() } catch { /* already gone */ }
        scheduleRetry()
      })
    })
    ws.on('close', scheduleRetry)
    ws.on('error', () => ws.close())
  }
}

/** Streaming sha256 of a local file (chunked-upload manifest). */
export function hashFileSha256(absPath: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(absPath)
      .on('data', (c) => h.update(c))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej)
  })
}
