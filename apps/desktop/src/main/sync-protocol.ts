/**
 * XGEN workspace 저장소 API 의 **와이어 계약** — 타입과 오류 하나뿐이다.
 *
 * 여기 있는 것은 `HttpSyncTransport`(sync-transport)와 가상 드라이브 백엔드가
 * 서버와 말할 때 쓰는 형상이다. 로직은 없다.
 *
 * ── 왜 별도 파일인가 ─────────────────────────────────────────────────
 *
 * 예전에는 이 타입들이 `sync-core` 안에 있었다. 그 파일에는 **레거시 페어
 * 동기화 엔진**(로컬 폴더 ↔ 서버를 주기적으로 맞추는 리컨사일러)도 함께
 * 들어 있었는데, 가상 드라이브가 그 모델을 대체한 뒤에도 설정에 남은
 * `syncPairs` 로 계속 되살아나 **같은 폴더를 향해 두 시스템이 동시에** 돌았다.
 * 그 결과 사용자가 지운 파일을 레거시 엔진이 자기 인덱스를 근거로 다시
 * 올렸다(무한 부활, 2026-08-06).
 *
 * 엔진을 "멈추는" 것으로는 부족했다 — 재가동 경로가 다섯 군데였고, 하나만
 * 되살아나도 증상이 돌아온다. 그래서 엔진을 **코드에서 들어냈다.** 전송
 * 계층이 필요로 하던 계약만 이 파일로 남긴다.
 */

/** 서버 인덱스의 항목 하나 (커서 응답의 원소). */
export interface RemoteChange {
  path: string
  is_dir: boolean
  size: number
  mtime_ns: number
  sha256: string
  seq: number
  deleted: boolean
}

/** `GET /storage/changes?since=` 응답. */
export interface ChangesResponse {
  latest_seq: number
  changes: RemoteChange[]
  max_file_bytes?: number
  /** 서버가 인덱스에서 제외하는 gitignore 스타일 패턴. */
  sync_ignores?: string[]
  /** 이 커서가 프룬된 툼스톤보다 앞선다 — 델타로는 삭제를 놓친다. */
  stale_cursor?: boolean
}

/** 저장소 API 표면. `HttpSyncTransport` 가 구현한다. */
export interface Transport {
  changes(since: number): Promise<ChangesResponse>
  /** workspace 상대 경로를 로컬 절대 경로로 내려받는다. */
  download(path: string, toAbs: string): Promise<void>
  /** 정확한 경로에 PUT. 새 sha 반환, 409 면 SyncConflictError. */
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>
  del(path: string, baseSha?: string, opts?: { force?: boolean }): Promise<void>
  mkdir(path: string): Promise<void>
}

/**
 * 서버가 새 최상위 폴더(=새 저장소) 생성을 관리자 승인 대기로 돌린 것 — HTTP 는
 * 200 이지만(`{ok:true, status:"pending_approval", request_id, path}`) 실제로는
 * **아무것도 만들어지지 않았다**. 이 신호를 무시하고 성공으로 취급하면(예전 버그)
 * 사용자 드라이브에는 폴더가 있는 것처럼 보이는데 서버·다른 기기·다른 사용자에게는
 * 존재하지 않는 유령 폴더가 생긴다.
 */
export class ApprovalPendingError extends Error {
  readonly requestId?: number
  readonly path?: string
  constructor(requestId?: number, path?: string) {
    super('새 최상위 폴더 생성은 관리자 승인이 필요합니다 — 승인 후 다시 시도해 주세요.')
    this.requestId = requestId
    this.path = path
  }
}

export class SyncConflictError extends Error {
  currentSha?: string
  /**
   * HTTP 상태를 **함께 들고 다닌다**.
   *
   * 이게 없어서 실기에서 사고가 났다: 호출부들이 `(e as {status?}).status !== 409`
   * 로 충돌을 가려내는데, 이 예외에는 status 가 없어 늘 `undefined !== 409` 가
   * 되어 **409 재시도 분기가 한 번도 실행되지 않았다.** 드라이브에 파일을
   * 복사하면 close() 에서 EIO 로 끝났고(재시도했으면 성공했을 상황),
   * 0바이트 파일만 서버에 남은 것도 같은 이유다.
   */
  readonly status = 409
  constructor(currentSha?: string) {
    super(currentSha ? `sync conflict (서버 sha=${currentSha})` : 'sync conflict')
    this.currentSha = currentSha
  }
}
