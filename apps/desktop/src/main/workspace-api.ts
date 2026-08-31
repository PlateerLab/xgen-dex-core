/**
 * 전송 계층 어댑터 — XGEN workspace REST API 를 `WorkspaceApi` 로.
 *
 * `HttpSyncTransport` 는 이미 changes/download/put/del/mkdir 를 갖고 있다.
 * 백엔드가 필요로 하는 것과 형태가 같으므로 얇게 감싸기만 한다 — 여기서
 * 로직을 다시 쓰면 인증·청크 업로드·재시도 같은 것들이 두 벌이 된다.
 */

import { join } from 'path'
import { HttpSyncTransport, type NetworkFetch } from './sync-transport'
import type { WorkspaceApi } from './workspace-backend'

export interface ApiFactoryDeps {
  serverUrl: () => string
  token: () => string | Promise<string>
  /** 401 자가치유 — refresh 로 토큰 회전(single-flight). see TransportAuth.refreshAuth */
  refreshAuth?: () => Promise<string | null>
  deviceId: () => string
  fetch: NetworkFetch
  allowPrivateCertificate: () => boolean
  /** 청크 업로드 스테이징에 쓸 임시 디렉터리. */
  tmpDir: string
}

/**
 * 에이전트 하나의 워크스페이스 API 를 만든다.
 *
 * 전송 객체를 **호출마다 새로 만드는** 이유: 서버 주소와 토큰이 세션 중에
 * 바뀔 수 있고(서버 변경·토큰 갱신), 오래된 인스턴스를 들고 있으면 갱신된
 * 토큰을 못 쓴다. 생성 비용은 무시할 만하다.
 */
export function makeWorkspaceApi(deps: ApiFactoryDeps, workflowId: string): WorkspaceApi {
  const transport = () =>
    new HttpSyncTransport(
      {
        baseUrl: deps.serverUrl(),
        token: deps.token,
        refreshAuth: deps.refreshAuth,
        workflowId,
        deviceId: deps.deviceId(),
        fetch: deps.fetch,
        allowPrivateCertificate: deps.allowPrivateCertificate(),
      },
      join(deps.tmpDir, 'dav-staging'),
    )

  return {
    changes: (since) => transport().changes(since),
    download: (path, toAbs) => transport().download(path, toAbs),
    put: (path, fromAbs, baseSha) => transport().put(path, fromAbs, baseSha),
    del: (path, baseSha, opts) => transport().del(path, baseSha, opts),
    mkdir: (path) => transport().mkdir(path),
  }
}
