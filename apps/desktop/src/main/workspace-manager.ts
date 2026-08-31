/**
 * 워크스페이스 매니저 — 가상 드라이브 하나의 수명을 통째로 소유한다.
 *
 *     설정(부착된 에이전트) → 백엔드 배선 → WebDAV 서버 → OS 마운트
 *
 * 로그인하면 붙고, 로그아웃/종료하면 걷힌다. 구글 드라이브처럼 **앱이 켜져
 * 있을 때만 존재하는 폴더**다.
 *
 * 여기가 유일한 소유자인 이유: 서버·마운트·백엔드는 항상 같이 살고 같이
 * 죽어야 한다. 셋을 따로 두면 "서버는 떴는데 마운트가 없다", "마운트는 남았는데
 * 서버가 죽었다"(= 스테일 마운트로 폴더가 먹통) 같은 상태가 생긴다.
 */

import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { diag } from './diag-log'
import { clearStale, preflight, rescueStrays } from './fuse-mount'
import { mountWebdav, unmountWebdav } from './mount-runner'
import { WorkspaceDavBackend, type WorkspaceApi } from './workspace-backend'
import { startDavServer, type DavServerHandle } from './webdav-server'
import { detectMountSupport, type MountSupport } from './workspace-mounts'
import {
  applyCloudLinks,
  isEnabled,
  rootOf,
  sameAgents,
  type CloudAgentLink,
  type WorkspaceConfig,
} from './workspace'

export interface WorkspaceManagerDeps {
  /** 현재 설정 (부착된 에이전트 목록 + 루트). */
  config: () => WorkspaceConfig | undefined
  /** 에이전트 하나의 워크스페이스 API 를 만든다 (전송 계층 어댑터). */
  apiFor: (workflowId: string) => WorkspaceApi
  /** 로그인 상태 — 꺼져 있으면 마운트하지 않는다. */
  loggedIn: () => boolean
  /** 로그인한 사용자의 클라우드 스토리지 API (루트). 없으면 에이전트만. */
  userApi?: () => WorkspaceApi | null
  /** 현재 로그인한 사용자의 owner key (`user:<id>`). 없으면 null. */
  userOwner?: () => string | null
  /**
   * 저장소 하나에 대한 **접속 표시(presence)**. 서버에 "이 PC 가 이 저장소에
   * 붙어 있다"를 알리고, 변경 알림을 받는다.
   *
   * 이게 없으면 두 가지가 조용히 빠진다:
   *   1. 웹의 "PC N대 동기화 중" 칩이 영영 안 뜬다 (기기 등록이 hello 로만 된다)
   *   2. 서버 변경을 못 받아, 웹에서 올린 파일이 드라이브에 늦게/안 나타난다
   */
  presenceFor?: (owner: string, onChanged: () => void) => WorkspacePresence
  /**
   * 서버가 이 PC 를 어떻게 알고 있는지 묻는다. 없으면 확인하지 않는다.
   *
   * 커넥터가 직접 판단할 수 없는 이유: 이름이 서버까지 갔는지, 그래서 이 PC 의
   * 홈 폴더가 무엇으로 정해졌는지는 **서버만** 안다. 여기서 이름을 흉내 내면
   * (예: hostname 을 그대로 폴더로 쓰면) 서버가 정한 것과 어긋나 파일이 엉뚱한
   * 폴더로 간다.
   *
   * 모르면 ``null`` — "재연결 필요" 라고 단정하지 않는다.
   */
  cloudProbe?: () => Promise<{ needsReconnect: boolean; homeFolder: string } | null>
  /**
   * 서버가 아는 **연결된 에이전트 목록**. 이것이 유일한 원본이다.
   *
   * 예전에는 커넥터가 자기 설정 파일에 목록을 따로 들고 있어서, 웹에서 연결한
   * 에이전트는 커넥터에 안 뜨고 커넥터에서 추가한 에이전트는 웹에 안 떴다.
   */
  cloudLinks?: () => Promise<CloudAgentLink[]>
  /** 서버에서 받아온 목록을 이 계정 설정에 저장한다. */
  persist?: (cfg: WorkspaceConfig) => void
  /** 새 동기화 페어 id 발급 (테스트에서 고정할 수 있게 주입한다). */
  newId?: () => string
  onStatus?: (s: WorkspaceStatus) => void
}

/** 저장소 하나에 대한 서버 접속 표시. */
export interface WorkspacePresence {
  start(): Promise<void>
  stop(): void
}

export interface WorkspaceStatus {
  supported: boolean
  /** 사용자가 드라이브를 켜 두었는가. 꺼져 있으면 마운트하지 않는다. */
  enabled: boolean
  /**
   * 마운트 지점에 남아 있던 로컬 파일을 구해 낸 위치.
   *
   * FUSE 는 비어 있지 않은 폴더 위에 못 붙는다. 예전에는 여기서 그냥 실패해서
   * **사용자 파일이 영영 드라이브를 막는** 상태가 됐다. 이제는 옆으로 옮겨
   * 두고 마운트한 뒤, 어디로 옮겼는지 알려준다.
   */
  rescued?: string
  /** 미지원 사유 (macOS 미지원 등). */
  reason?: string
  hint?: string
  mounted: boolean
  /**
   * 이 PC 가 **재연결**을 해야 하는 상태.
   *
   * 서버에 이름 없이 등록된 기기는 클라우드 안에서 자기 폴더를 갖지 못한다 —
   * 예전 커넥터가 쓰기 요청에 id 만 실어 보내던 시절의 흔적이다. 그대로 두면
   * 파일이 계속 루트에 섞이고, 웹은 id 앞 8자를 기기 이름인 줄 보여준다.
   *
   * 조용히 고칠 수 없는 이유: 서버가 이 PC 를 다시 등록해야 하고, 그것은
   * 사용자가 연결을 다시 맺을 때 일어난다. 그래서 **알린다.**
   */
  needsReconnect?: boolean
  reconnectReason?: string
  /**
   * 클라우드 안에서 이 PC 가 쓰는 폴더 — ``{클라우드}/{PC 이름}/(파일)``.
   *
   * 화면에 이걸 보여 줘야 사용자가 자기 파일을 어디에 두는지 안다. 예전에는
   * 모든 PC 가 루트를 그대로 썼고, 그래서 파일이 전부 한 트리에 섞였다.
   */
  homeFolder?: string
  /** 마운트된 경로 또는 드라이브 문자. */
  path?: string
  error?: string
  /** 오류를 사용자가 직접 풀 수 있는 방법 (설치 명령 등). */
  errorHint?: string
  /**
   * 클라우드 스토리지가 **꺼져 있어서** 루트가 없는 경우의 사유.
   *
   * 관리자가 조직 전체에서 껐거나, 사용자가 자기 설정에서 껐다는 뜻이다.
   * 오류가 아니므로 error 와 구분한다 — "실패"로 보이면 사용자가 고치려
   * 든다. 서버 문구를 그대로 실어 무엇을 켜야 하는지 알린다.
   */
  storageOff?: string
  /**
   * RAG 시스템 통제 — 이 PC 의 클라우드 연결(cloud.device_link)이 관리자
   * **승인 대기중/거절** 상태. 서버가 403 사유에 실어 준다.
   *
   * storageOff("꺼짐")와 구분한다 — 대기는 관리자가 승인하면 저절로 풀리는
   * 상태라, "권한을 확인하라"는 안내가 오히려 사용자를 헤매게 한다.
   * 에이전트 폴더 동기화는 이 상태와 무관하게 동작한다.
   */
  cloudApproval?: 'pending' | 'rejected'
  /** 서버가 준 사유 원문 (표시용). */
  cloudApprovalDetail?: string
  agents: Array<{ workflowId: string; label: string; folder: string }>
}

/**
 * ⚠ **이 프로세스는 자기 마운트를 절대 동기 IO 로 만지면 안 된다.**
 *
 * FUSE 콜백이 이 이벤트 루프에 올라온다. 루프를 막는 동기 호출이 마운트를
 * 향하면 콜백이 응답하지 못하고 **서로를 기다리는 데드락**이 된다 (실기:
 * shell.openPath 로 "폴더 열기"를 누르는 순간 앱이 응답 없음).
 *
 * 그래서 마운트 경로를 다루는 일은 전부 자식 프로세스나 비동기로 한다.
 */
export class WorkspaceManager {
  private backend = new WorkspaceDavBackend()
  private handle: DavServerHandle | null = null
  /** Linux FUSE 를 소유한 자식 프로세스 (있으면 마운트가 살아 있다). */
  private host: ChildProcess | null = null
  /** 자식이 스스로 죽었을 때 한 번만 자동 복구한다 (무한 재기동 방지). */
  private hostRestarts = 0
  private mountedPath: string | null = null
  // ⚠ **기동 시점에 만들지 않는다.** 판정은 네이티브 FUSE 바인딩을 require
  // 하는데, ABI 가 어긋난 .node 의 dlopen 은 JS 예외가 아니라 **프로세스를
  // 통째로 죽일 수 있다**. 앱이 켜지자마자 죽으면 사용자는 원인을 알 길이
  // 없으므로, 워크스페이스가 실제로 필요해질 때까지 미룬다.
  private supportCache: MountSupport | null = null

  private get support(): MountSupport {
    if (!this.supportCache) this.supportCache = detectMountSupport()
    return this.supportCache
  }
  private lastError: string | undefined
  private lastHint: string | undefined
  /** 클라우드 스토리지가 꺼져 있을 때의 사유 (오류가 아니다). */
  private storageOff: string | undefined
  private cloudApproval: 'pending' | 'rejected' | undefined
  private cloudApprovalDetail: string | undefined
  private needsReconnect = false
  /** 클라우드 안 이 PC 의 폴더 이름. 서버가 정한다 — 모르면 빈 문자열. */
  private homeFolder = ''
  private reconnectReason: string | undefined
  /** owner → 접속 표시. 마운트되어 있는 동안만 살아 있다. */
  private presence = new Map<string, WorkspacePresence>()
  /** 마운트를 막던 로컬 파일을 구해 낸 위치 (있으면 사용자에게 알린다). */
  private rescued: string | undefined
  /**
   * 구해 낸 파일을 이미 올려 봤는가.
   *
   * ⚠ 이 플래그가 없으면 마운트할 때마다·[동기화] 누를 때마다 보관 폴더를
   * **다시 업로드**한다. 사용자가 지운 파일이 그대로 되살아난다 — 실기에서
   * "지우고 새로고침하면 다시 생긴다" 의 진짜 원인이 이것이었다.
   * 업로드는 **구해 낸 직후 딱 한 번**이다.
   */
  private rescueUploaded = false
  /** 리컨사일이 진행 중인가 — 진행 중에는 "실패"라고 말하지 않는다. */
  private inFlight = false
  private busy: Promise<void> | null = null

  constructor(private deps: WorkspaceManagerDeps) {}

  status(): WorkspaceStatus {
    const cfg = this.deps.config()
    // 불변식: **연결되지 않았다면 반드시 이유가 있어야 한다.**
    // 이유 없이 안 붙어 있으면 사용자는 (마운트가 아닌) 빈 폴더에 파일을 넣고
    // 그 파일은 아무 데도 가지 않는다. 원인을 못 밝히더라도 "모른다"고는
    // 말해야 한다 — 침묵이 가장 나쁘다.
    const attached = (cfg?.agents ?? []).length > 0
    const wants = isEnabled(cfg) && (attached || !!this.deps.userApi?.())
    // ⚠ **아직 시도 중이면 실패라고 말하지 않는다.** 기동 직후에는 로그인과
    // 마운트가 진행 중이라 잠깐 "안 붙은" 상태가 정상이다. 여기서 실패를
    // 지어내면 사용자는 매번 [다시 연결] 을 눌러야 하는 줄 안다 (실기 신고).
    //
    // 그리고 상태 조회는 **상태를 바꾸지 않는다** — 예전엔 여기서 lastError 를
    // 직접 써 넣어, 화면을 한 번 본 것만으로 오류가 눌러앉았다.
    const unexplained =
      wants && this.mountedPath === null && this.support.supported && !this.inFlight
        ? '드라이브를 연결하지 못했습니다 (원인 미상 — 진단 로그를 확인하세요)'
        : undefined
    const error = this.lastError ?? (this.storageOff || this.cloudApproval ? undefined : unexplained)
    return {
      supported: this.support.supported,
      reason: this.support.reason,
      hint: this.support.hint,
      enabled: isEnabled(cfg),
      mounted: this.mountedPath !== null,
      path: this.mountedPath ?? undefined,
      rescued: this.rescued,
      error,
      errorHint: this.lastHint,
      storageOff: this.storageOff,
      cloudApproval: this.cloudApproval,
      cloudApprovalDetail: this.cloudApprovalDetail,
      needsReconnect: this.needsReconnect,
      reconnectReason: this.reconnectReason,
      homeFolder: this.homeFolder || undefined,
      agents: (cfg?.agents ?? []).map((a) => ({
        workflowId: a.workflowId,
        label: a.label,
        folder: a.folder,
      })),
    }
  }

  /**
   * 드라이브 안 한 폴더의 직계 자식 — **인앱 탐색기**가 쓴다.
   *
   * OS 마운트를 거치지 않고 백엔드(readdir → 서버 API)로 바로 읽는다. 이 프로세스가
   * 자기 FUSE 마운트를 만지면 데드락이므로(위 클래스 주석), 마운트 경로가 아니라
   * 백엔드를 쓰는 것이 유일하게 안전한 길이기도 하다. 백엔드가 아직 배선되지
   * 않았으면(드라이브 꺼짐·로그아웃) 빈 목록이 온다 — 화면은 status 로 사유를 안다.
   */
  async list(
    path: string,
  ): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>> {
    const nodes = await this.backend.readdir(path)
    return nodes.map((n) => ({
      name: n.name,
      isDir: n.isDir,
      size: n.size,
      mtime: n.mtime.getTime(),
    }))
  }

  private emit(): void {
    this.deps.onStatus?.(this.status())
  }

  /** 설정/로그인 상태에 맞춰 실제 상태를 맞춘다. 연속 호출은 직렬화된다. */
  async reconcile(): Promise<void> {
    // 마운트/언마운트가 겹치면 스테일 마운트가 남는다 — 항상 한 줄로 세운다.
    const prev = this.busy ?? Promise.resolve()
    this.inFlight = true
    this.busy = prev
      .then(() => this.reconcileInner())
      .catch((e) => {
        // 진단 로그에만 남기면 화면에는 **아무 이유 없이 연결 안 됨**으로
        // 보인다. 사용자는 폴더가 있으니 파일을 넣고, 그 파일은 아무 데도
        // 가지 않는다 — 실제로 그렇게 잃어버렸다. 반드시 화면까지 올린다.
        this.lastError = `연결하지 못했습니다: ${(e as Error).message}`
        diag('workspace', `리컨사일 실패: ${(e as Error).message}`)
      })
      .finally(() => {
        this.inFlight = false
        this.emit()
      })
    return this.busy
  }

  /**
   * 사용자 클라우드 스토리지를 실제로 쓸 수 있는지 서버에 물어본다.
   *
   * on/off 는 **두 곳**에 있다 — 관리자 전역 설정과 사용자 개인 설정. 어느
   * 쪽이 껐는지 커넥터가 따로 알 필요는 없다. 서버가 403 으로 거절하면
   * 그것이 곧 "꺼짐"이고, 사유 문구도 서버가 준다 (게이트 판정을 여기서
   * 흉내내면 서버와 어긋난다).
   *
   * 403 이 아닌 실패(네트워크 등)는 **꺼짐이 아니다**. 잠깐 끊겼다고 루트를
   * 떼면 파일이 전부 사라진 것처럼 보인다 — 그때는 그대로 붙여 둔다.
   */
  /**
   * 서버가 이 PC 를 어떻게 알고 있는지 확인한다.
   *
   * 실패는 삼킨다 — 상태 표시를 위한 조회가 드라이브를 막으면 안 된다.
   * 확인하지 못했으면 "재연결 필요" 라고 단정하지 않는다(모르면서 경고하면
   * 사용자는 멀쩡한 연결을 다시 맺는다).
   */
  private async checkReconnect(api: WorkspaceApi | null): Promise<void> {
    const probe = this.deps.cloudProbe
    if (!probe) return
    try {
      const seen = await probe()
      if (!seen) return              // 모르면 아무 말도 하지 않는다
      const stale = seen.needsReconnect
      if (stale !== this.needsReconnect) {
        diag('workspace', stale ? '재연결 필요로 표시됨' : '재연결 필요 해제')
      }
      this.needsReconnect = stale
      this.reconnectReason = stale
        ? '이 PC 가 이름 없이 등록되어 클라우드 안에서 자기 폴더를 쓰지 못합니다. 다시 연결하면 PC 이름으로 정리됩니다.'
        : undefined
      if (this.homeFolder !== seen.homeFolder) {
        diag('workspace', `이 PC 의 클라우드 폴더: /${seen.homeFolder}`)
      }
      this.homeFolder = seen.homeFolder
      // 백엔드가 루트 파일을 거부할 때 이 PC 의 폴더를 정확히 안내할 수 있게 전달.
      this.backend.setHomeFolder(seen.homeFolder)
      if (!stale) await this.ensureHomeFolder(api)
    } catch {
      // 모르면 아무 말도 하지 않는다.
    }
  }

  /**
   * 클라우드 안에 이 PC 의 폴더를 만들어 둔다 — ``{클라우드}/{PC 이름}/(파일)``.
   *
   * 폴더가 **비어 있어도 보여야** 한다. 없으면 사용자는 드라이브 루트에 파일을
   * 떨어뜨리고, 그러면 모든 PC 의 파일이 한 트리에 섞인다 — 그게 원래 문제였다.
   * 여기서 미리 만들어 두면 어디에 넣어야 하는지가 화면에 드러난다.
   *
   * 이름은 **서버가 정한 것**을 그대로 쓴다(:func:`home_folder_for`). 커넥터가
   * hostname 으로 흉내 내면 서버가 아는 폴더와 어긋난다.
   *
   * 실패는 삼킨다 — 폴더 하나 때문에 드라이브가 안 붙으면 안 된다.
   */
  private async ensureHomeFolder(api: WorkspaceApi | null): Promise<void> {
    if (!api || !this.homeFolder) return
    try {
      await api.mkdir(this.homeFolder)
    } catch (e) {
      diag('workspace', `PC 폴더 준비 실패(무시): ${(e as Error).message}`)
    }
  }

  private async probeUserStorage(api: WorkspaceApi | null): Promise<WorkspaceApi | null> {
    if (!api) {
      this.storageOff = undefined
      this.cloudApproval = undefined
      this.cloudApprovalDetail = undefined
      return null
    }
    try {
      await api.changes(0)
      this.storageOff = undefined
      this.cloudApproval = undefined
      this.cloudApprovalDetail = undefined
      await this.checkReconnect(api)
      return api
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 403) {
        const why = (e as Error).message || '클라우드 스토리지가 꺼져 있습니다'
        // RAG 시스템 통제 — 관리자 승인 게이트의 403 은 "꺼짐"이 아니라
        // **대기/거절**이다. 서버 detail 문구로 판별한다 (게이트의 문구:
        // "관리자 승인 대기 중" / "관리자에 의해 거절"). 원문에서
        // "changes HTTP 403:" 접두는 표시용으로 걷어낸다.
        const detail = why.replace(/^.*HTTP\s*403:\s*/, '').trim() || why
        if (why.includes('승인 대기')) {
          if (this.cloudApproval !== 'pending')
            diag('workspace', `클라우드 연결 승인 대기중: ${detail}`)
          this.cloudApproval = 'pending'
          this.cloudApprovalDetail = detail
          this.storageOff = undefined
          return null
        }
        if (why.includes('거절')) {
          if (this.cloudApproval !== 'rejected')
            diag('workspace', `클라우드 연결 거절됨: ${detail}`)
          this.cloudApproval = 'rejected'
          this.cloudApprovalDetail = detail
          this.storageOff = undefined
          return null
        }
        if (this.storageOff !== why) diag('workspace', `사용자 클라우드 스토리지 꺼짐: ${why}`)
        this.storageOff = why
        this.cloudApproval = undefined
        this.cloudApprovalDetail = undefined
        return null
      }
      // 일시적 실패 — 백엔드의 트리 캐시가 알아서 버틴다.
      diag('workspace', `사용자 스토리지 확인 실패(무시): ${(e as Error).message}`)
      this.storageOff = undefined
      return api
    }
  }

  /**
   * 드라이브를 끈다 — 마운트를 걷고 스테일 흔적까지 정리한다.
   *
   * 루트를 옮기기 전에 **반드시** 먼저 부른다. 안 그러면 옛 지점이 마운트된
   * 채 남아 상위 폴더가 EBUSY 로 잠기고, 사용자는 되돌아갈 수도 지울 수도
   * 없게 된다 (실기 사고).
   */
  async detach(): Promise<void> {
    const prev = this.busy ?? Promise.resolve()
    this.busy = prev
      .then(async () => {
        const path = this.mountedPath ?? rootOf(this.deps.config())
        await this.teardown()
        await clearStale(path)
        this.emit()
      })
      .catch((e) => diag('workspace', `해제 실패: ${(e as Error).message}`))
    return this.busy
  }

  /**
   * 다시 연결 — 걷고 처음부터 붙인다.
   *
   * 실패한 마운트는 사용자가 스스로 되살릴 수 있어야 한다. 앱을 껐다 켜라고
   * 하는 건 해결책이 아니다. 남아 있던 오류는 지우고 시작한다 — 안 그러면
   * 성공해도 옛 오류가 화면에 남는다.
   */
  async remount(): Promise<void> {
    await this.detach()
    this.lastError = undefined
    this.lastHint = undefined
    await this.reconcile()
  }

  /**
   * 동기화 — 서버 상태를 지금 다시 읽는다.
   *
   * 드라이브는 스트리밍이라 "올릴 것"이 따로 쌓이지 않는다. 그래서 동기화는
   * **캐시를 버리고 최신 목록을 다시 가져오는 것**이 전부다.
   */
  async refreshNow(): Promise<void> {
    // ⚠ 여기서 보관 폴더를 다시 올리면 **사용자가 지운 파일이 되살아난다.**
    // 동기화는 "서버 상태를 다시 읽는 것"이지 "로컬을 다시 밀어 넣는 것"이
    // 아니다. 업로드는 구해 낸 직후 한 번뿐이다.
    this.backend.invalidateAll()
    await this.reconcile()
  }

  /**
   * 마운트가 아직 살아 있는가.
   *
   * 프로세스가 죽거나 강제 종료되면 마운트 지점이 **연결 끊긴 채로 남는다**.
   * 그 상태에서는 목록이 비어 보이고 파일 복사가 EIO 로 실패한다 — 겉보기엔
   * "드라이브는 있는데 아무것도 안 되는" 상태다. 우리가 mountedPath 를 들고
   * 있다는 이유로 건너뛰면 영원히 그대로다.
   *
   * ⚠ 반드시 **자식 프로세스**로 확인한다. 이 프로세스에서 마운트를 동기
   * 접근하면 FUSE 콜백과 서로 기다리는 데드락이 된다.
   */
  /** 보관 폴더 이름에 쓸 시각 표기. */
  private stamp(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  }

  /**
   * 구해 낸 로컬 파일을 클라우드로 올린다.
   *
   * ⚠ **마운트를 거치지 않고 API 로 직접** 올린다. 자기 마운트에 파일을 쓰면
   * FUSE 콜백과 같은 루프에서 서로를 기다리는 데드락이 된다.
   *
   * 실패하면 보관 폴더를 **그대로 남긴다** — 파일이 사라지느니 사용자가 직접
   * 옮기는 편이 낫다.
   */
  private async uploadRescued(backup: string): Promise<void> {
    const api = this.deps.userApi?.()
    if (!api) return
    const { readdir, stat } = await import('fs/promises')
    const { join } = await import('path')
    let ok = 0
    let failed = 0
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const name of await readdir(dir)) {
        const abs = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        try {
          if ((await stat(abs)).isDirectory()) {
            await api.mkdir(relPath)
            await walk(abs, relPath)
          } else {
            await api.put(relPath, abs, '')
            ok++
          }
        } catch (e) {
          failed++
          diag('workspace', `구해 낸 파일 업로드 실패 ${relPath}: ${(e as Error).message}`)
        }
      }
    }
    try {
      await walk(backup, '')
      diag('workspace', `구해 낸 파일 업로드: 성공 ${ok} 실패 ${failed}`)
      if (failed === 0 && ok > 0) {
        const { rm } = await import('fs/promises')
        await rm(backup, { recursive: true, force: true })
        this.rescued = undefined
        diag('workspace', '보관 폴더 정리 완료 — 파일은 클라우드에 있다')
      } else if (failed > 0) {
        // 자동 재시도는 하지 않는다. 다시 올리면 그 사이 사용자가 지운 파일을
        // 되살릴 수 있다. 보관 폴더는 남겨 두고 위치를 화면에 알린다 —
        // 사용자가 직접 드라이브로 옮기면 된다.
        diag('workspace', `보관 폴더를 남긴다 (실패 ${failed}건): ${backup}`)
      }
      this.emit()
    } catch (e) {
      diag('workspace', `구해 낸 파일 처리 실패: ${(e as Error).message}`)
    }
  }


  /**
   * 로컬 WebDAV 서버를 확보한다 (없으면 띄운다).
   *
   * Linux 도 이제 이 서버를 쓴다 — FUSE 를 자식 프로세스로 옮기면서 자식이
   * 부모에게 되물을 통로가 필요해졌고, macOS/Windows 가 쓰던 것을 그대로
   * 재사용한다. 백엔드 로직이 한 벌로 유지된다.
   */
  private async ensureDavServer(): Promise<DavServerHandle | null> {
    if (this.handle) return this.handle
    try {
      this.handle = await startDavServer(this.backend, {})
      return this.handle
    } catch (e) {
      diag('workspace', `WebDAV 서버 시작 실패: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * FUSE 호스트 자식을 띄우고 마운트 완료를 기다린다.
   *
   * 자식은 **Electron 바이너리를 Node 모드로** 실행한다 (앱에 별도 Node 가
   * 없다). 마운트 결과는 stdout 한 줄로 온다 — 성공이면 `mounted`, 실패면
   * `mount-failed <사유>|<해결법>`.
   */
  private async spawnFuseHost(
    davUrl: string,
    mountpoint: string,
  ): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const { spawn } = await import('child_process')
    const { join } = await import('path')
    // ⚠ 자식 진입점은 **__dirname 기준**으로 찾는다. process.argv[1] 은 패키징된
    // 앱에서 메인 스크립트가 아니라서(실행 인자이거나 비어 있다) 엉뚱한 곳을
    // 가리켰고, 자식이 "Cannot find module" 로 즉시 코드 1 로 죽었다 —
    // 화면에는 "드라이브 연결이 끊겼습니다 (코드 1)" 로만 보였다.
    // __dirname 은 개발(out/main)에서도 배포(app.asar/out/main)에서도 맞다.
    const entry = join(__dirname, 'fuse-host.js')
    const child = spawn(process.execPath, [entry, `--dav=${davUrl}`, `--mount=${mountpoint}`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.host = child

    let lastStderr = ''
    child.stderr?.on('data', (d) => {
      lastStderr = String(d).trim().slice(0, 300)
      diag('fuse-host', `stderr: ${lastStderr}`)
    })
    child.on('exit', (code, signal) => {
      const why = signal ? `신호 ${signal}` : `코드 ${code}`
      diag('workspace', `FUSE 호스트 종료 (${why})`)
      if (this.host !== child) return // 우리가 의도적으로 걷은 경우
      this.host = null
      this.mountedPath = null
      // 자식이 죽어도 앱은 산다 — 그게 프로세스를 나눈 이유다. 한 번은 스스로
      // 되살리고, 그래도 죽으면 사유를 남긴다 (무한 재기동은 더 나쁘다).
      if (this.hostRestarts < 1) {
        this.hostRestarts++
        diag('workspace', 'FUSE 호스트를 다시 띄운다')
        void this.reconcile()
      } else {
        // 코드만 보여주면 원인을 알 수 없다. 자식이 남긴 마지막 말을 함께 싣는다.
        this.lastError = lastStderr
          ? `드라이브 연결이 끊겼습니다 (${why}): ${lastStderr}`
          : `드라이브 연결이 끊겼습니다 (${why}) — [다시 연결] 을 눌러 주세요`
        this.emit()
      }
    })

    return new Promise((resolve) => {
      let settled = false
      const done = (v: { ok: boolean; error?: string; hint?: string }): void => {
        if (settled) return
        settled = true
        resolve(v)
      }
      child.stdout?.on('data', (d) => {
        for (const line of String(d).split('\n')) {
          if (line.startsWith('mounted')) {
            this.hostRestarts = 0
            done({ ok: true })
          } else if (line.startsWith('mount-failed')) {
            const [error, hint] = line.slice('mount-failed '.length).split('|')
            done({ ok: false, error: error || '마운트 실패', hint: hint || undefined })
          } else if (line.trim()) {
            diag('fuse-host', line.trim().slice(0, 300))
          }
        }
      })
      child.on('error', (e) => done({ ok: false, error: `호스트를 실행하지 못했습니다: ${e.message}` }))
      // 자식이 mounted/mount-failed 를 말하기도 전에 죽으면(모듈 없음 등)
      // 여기서 끝내야 한다 — 안 그러면 20초를 기다린 뒤에야 "원인 미상" 이 된다.
      child.once('exit', (code) => done({ ok: false, error: `FUSE 호스트가 시작하지 못했습니다 (코드 ${code}): ${lastStderr || '출력 없음'}` }))
      // 자식이 아무 말도 없으면 매달리지 않는다.
      setTimeout(() => done({ ok: false, error: 'FUSE 호스트가 응답하지 않습니다 (20초)' }), 20_000)
    })
  }

  /** 자식을 정중히 종료한다 (stdin 을 닫으면 자식이 스스로 언마운트한다). */
  private async stopFuseHost(): Promise<void> {
    const child = this.host
    if (!child) return
    this.host = null
    try {
      child.stdin?.end()
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* 이미 죽었다 */ }
          r()
        }, 5000)
        child.once('exit', () => { clearTimeout(t); r() })
      })
    } catch {
      /* 종료 실패는 clearStale 이 마무리한다 */
    }
  }

  private async mountAlive(path: string): Promise<boolean> {
    try {
      const { execFile } = await import('child_process')
      return await new Promise<boolean>((resolveP) => {
        execFile('ls', ['-1', path], { timeout: 5000 }, (err) => resolveP(!err))
      })
    } catch {
      return true // 확인할 수 없으면 살아 있다고 본다 (멀쩡한 마운트를 끊지 않는다)
    }
  }

  /**
   * 서버의 연결 목록을 이 PC 에 반영한다 — **매 리컨사일마다**.
   *
   * 실패하면 **아무것도 하지 않는다.** 서버를 못 읽었다고 빈 목록을 반영하면
   * 드라이브의 에이전트 폴더가 전부 사라진다 — 사용자에게는 파일이 통째로
   * 날아간 것으로 보인다.
   */
  private async syncCloudLinks(): Promise<boolean> {
    const fetchLinks = this.deps.cloudLinks
    if (!fetchLinks || !this.deps.loggedIn()) return false
    let links: CloudAgentLink[]
    try {
      links = await fetchLinks()
    } catch (e) {
      diag('workspace', `연결 목록 조회 실패(로컬 유지): ${(e as Error).message}`)
      return false
    }
    const cur = this.deps.config()
    const next = applyCloudLinks(cur, links, this.deps.newId ?? (() => randomUUID()))
    if (sameAgents(cur?.agents ?? [], next.agents)) return false
    diag('workspace', `연결 목록 갱신: ${next.agents.map((a) => a.label).join(', ') || '(없음)'}`)
    this.deps.persist?.(next)
    return true
  }

  /**
   * 서버의 연결 목록을 지금 다시 읽는다 — 사용자가 [새로고침] 을 눌렀을 때.
   *
   * 주기적으로 돌지 않는 이유: 연결은 거의 바뀌지 않는데, 타이머를 두면 앱이
   * 켜져 있는 내내 서버를 두드린다. 리컨사일(로그인·설정 변경·[다시 연결])과
   * 워크스페이스 화면을 여는 순간에 맞추고, 그 사이가 궁금하면 누르게 한다.
   */
  async refreshLinks(): Promise<void> {
    if (await this.syncCloudLinks()) await this.reconcile()
    else this.emit()
  }

  private async reconcileInner(): Promise<void> {
    // 설정을 읽기 **전에** 서버와 맞춘다 — 이 라운드가 최신 목록으로 돌아야
    // 사용자가 웹에서 붙인 에이전트가 바로 드라이브에 나타난다.
    await this.syncCloudLinks()
    const cfg = this.deps.config()
    const agents = cfg?.agents ?? []

    // 사용자가 껐다 — 붙어 있으면 걷고 끝.
    if (!isEnabled(cfg)) {
      if (this.mountedPath) await this.teardown()
      this.lastError = undefined
      this.emit()
      return
    }

    // 붙어 있다고 **믿고 있는** 마운트가 실제로 죽었는지 본다.
    if (this.mountedPath && !(await this.mountAlive(this.mountedPath))) {
      diag('workspace', `죽은 마운트 감지 — 다시 붙인다: ${this.mountedPath}`)
      const path = this.mountedPath
      await this.teardown()
      await clearStale(path)
    }

    // 드라이브는 **사용자 클라우드 스토리지만** 서빙한다 — 에이전트 워크스페이스는
    // local-sync 가 실제 폴더로 다룬다. 클라우드가 없으면(로그아웃·게이트 꺼짐)
    // 마운트할 것이 없다. 플랫폼 판정(네이티브 바인딩 로드)도 그때까지 미룬다 —
    // 갓 설치한 사용자가 앱을 켜자마자 그것 때문에 죽는 일이 없어야 한다.
    const userApi = this.deps.loggedIn()
      ? await this.probeUserStorage(this.deps.userApi?.() ?? null)
      : null
    if (!userApi || !this.deps.loggedIn()) {
      if (this.mountedPath) await this.teardown()
      this.deps.onStatus?.({
        supported: this.supportCache?.supported ?? true,
        reason: this.supportCache?.reason,
        hint: this.supportCache?.hint,
        enabled: isEnabled(cfg),
        mounted: false,
        error: this.lastError,
        storageOff: this.storageOff,
        cloudApproval: this.cloudApproval,
        cloudApprovalDetail: this.cloudApprovalDetail,
        // 연결 목록(사본)은 그대로 알린다 — local-sync 와 UI 가 이 목록을 쓴다.
        agents: agents.map((a) => ({ workflowId: a.workflowId, label: a.label, folder: a.folder })),
      })
      return
    }

    if (!this.support.supported) {
      if (this.mountedPath) await this.teardown()
      this.emit()
      return
    }

    // 백엔드는 마운트 유무와 무관하게 항상 최신 배선을 들고 있어야 한다.
    // 루트 = 사용자 클라우드 스토리지 그 자체.
    this.backend.setUserStorage(userApi)

    if (this.mountedPath) {
      this.syncPresence(userApi)
      this.emit() // 이미 붙어 있다 — 배선만 갱신되면 된다
      return
    }
    await this.setup()
    if (this.mountedPath) this.syncPresence(userApi)
    this.emit()
  }

  /**
   * 지금 드라이브가 서빙하는 저장소들에 접속 표시를 맞춘다.
   *
   * 마운트되어 있는 동안만 유지한다 — 드라이브가 없는데 "이 PC 가 붙어 있다"고
   * 알리면 웹에서 연결된 것처럼 보이는데 실제로는 아무것도 동기화되지 않는다.
   */
  private syncPresence(userApi: WorkspaceApi | null): void {
    if (!this.deps.presenceFor) return
    const want = new Map<string, string>() // owner → 캐시 키
    const userOwner = userApi ? (this.deps.userOwner?.() ?? null) : null
    if (userOwner) want.set(userOwner, '')
    // 에이전트 owner 의 접속 표시는 local-sync 가 소유한다 — 여기는 드라이브가
    // 실제로 서빙하는 사용자 스토리지 하나만 알린다.

    for (const [owner, p] of [...this.presence]) {
      if (!want.has(owner)) {
        p.stop()
        this.presence.delete(owner)
      }
    }
    for (const [owner, key] of want) {
      if (this.presence.has(owner)) continue
      const p = this.deps.presenceFor(owner, () => this.backend.invalidateSpace(key))
      this.presence.set(owner, p)
      void p.start().catch((e) => diag('workspace', `접속 표시 실패 ${owner}: ${(e as Error).message}`))
    }
  }

  private stopPresence(): void {
    for (const p of this.presence.values()) p.stop()
    this.presence.clear()
  }

  /** 인증서 정책 변경 후 기존 presence WebSocket만 새 정책으로 다시 연결한다. */
  restartPresence(): void {
    this.stopPresence()
    void this.reconcile()
  }

  private async setup(): Promise<void> {
    const cfg = this.deps.config()
    const root = rootOf(cfg)
    this.lastError = undefined
    this.lastHint = undefined

    // Linux: FUSE 로 직접 붙는다. WebDAV 서버를 띄우지 않는다 — 같은 백엔드를
    // 커널이 바로 호출하므로 루프백 HTTP 를 한 겹 더 거칠 이유가 없다.
    if (this.support.kind === 'fuse') {
      // 마운트 지점에 로컬 파일이 남아 막힌 경우 — **여기서 끝내면 안 된다.**
      // 사용자가 (마운트가 아닌) 빈 폴더에 파일 하나 넣는 순간 드라이브가
      // 영영 안 붙는 상태가 된다. 지울 수도 없다, 사용자 파일이다.
      const pre = await preflight(root)
      if (pre?.strays?.length) {
        const backup = await rescueStrays(root, this.stamp())
        if (backup) {
          this.rescued = backup
          diag('workspace', `잔여 파일을 옮기고 다시 마운트한다: ${backup}`)
        }
      }

      // ⚠ FUSE 는 **자식 프로세스**가 건다. 네이티브 크래시(SIGSEGV)가 앱을
      // 통째로 죽이는 일도, 마운트 콜백이 메인 루프를 물어 데드락이 나는 일도
      // 이 경계 하나로 사라진다. 자식은 로컬 WebDAV 로 우리에게 되묻는다 —
      // macOS/Windows 가 이미 쓰는 서버라 백엔드 로직이 한 벌로 유지된다.
      const dav = await this.ensureDavServer()
      if (!dav) {
        this.lastError = '로컬 WebDAV 서버를 시작하지 못했습니다'
        return
      }
      const spawned = await this.spawnFuseHost(dav.url(), root)
      if (!spawned.ok) {
        this.lastError = spawned.error
        this.lastHint = spawned.hint
        diag('workspace', `FUSE 호스트 실패: ${spawned.error ?? ''}`)
        return
      }
      this.lastHint = undefined
      this.mountedPath = root
      // 구해 낸 파일은 **한 번만** 올린다 (재마운트마다 올리면 지운 파일이
      // 되살아난다).
      if (this.rescued && !this.rescueUploaded) {
        this.rescueUploaded = true
        void this.uploadRescued(this.rescued)
      }
      diag('workspace', `워크스페이스 마운트(FUSE 자식 프로세스) → ${root}`)
      return
    }

    // ⚠ macOS 도 마운트 지점이 **비어 있어야** 붙는다 (`mount_webdav` 는
    // 비어 있지 않은 디렉터리를 거부하거나 그 위를 덮어 사용자 파일을
    // 가려 버린다). 잔여 파일 구조는 FUSE 분기에만 있었는데, 그러면 맥
    // 사용자는 폴더에 파일 하나만 있어도 드라이브가 영영 안 붙고 되돌릴
    // 방법도 없다. Windows 는 드라이브 문자를 쓰므로 해당 없다.
    if (process.platform === 'darwin') {
      const pre = await preflight(root)
      if (pre?.strays?.length) {
        const backup = await rescueStrays(root, this.stamp())
        if (backup) {
          this.rescued = backup
          diag('workspace', `잔여 파일을 옮기고 다시 마운트한다: ${backup}`)
        }
      }
    }

    try {
      this.handle = await startDavServer(this.backend)
      diag('workspace', `WebDAV 서버 기동 port=${this.handle.port}`)
    } catch (e) {
      this.lastError = `WebDAV 서버를 띄우지 못했습니다: ${(e as Error).message}`
      diag('workspace', this.lastError)
      return
    }
    const res = await mountWebdav(this.handle.url(), root)
    if (!res.ok) {
      this.lastError = res.error
      diag('workspace', `마운트 실패: ${res.error ?? ''}`)
      await this.handle.close().catch(() => undefined)
      this.handle = null
      return
    }
    this.mountedPath = res.path ?? root
    // 구해 낸 파일은 **한 번만** 올린다 (재마운트마다 올리면 지운 파일이
    // 되살아난다 — FUSE 분기와 같은 계약).
    if (this.rescued && !this.rescueUploaded) {
      this.rescueUploaded = true
      void this.uploadRescued(this.rescued)
    }
    diag('workspace', `워크스페이스 마운트 → ${this.mountedPath}`)
  }

  private async teardown(): Promise<void> {
    // 드라이브가 걷히면 접속 표시도 같이 내린다 — 안 그러면 웹에는 연결된
    // 것처럼 남아 있는데 실제로는 아무것도 동기화되지 않는다.
    this.stopPresence()
    const path = this.mountedPath
    this.mountedPath = null
    await this.stopFuseHost()
    if (path) {
      try {
        await unmountWebdav(path)
      } catch (e) {
        diag('workspace', `언마운트 실패: ${(e as Error).message}`)
      }
    }
    if (this.handle) {
      await this.handle.close().catch(() => undefined)
      this.handle = null
    }
    diag('workspace', '워크스페이스 해제 완료')
  }

  /** 앱 종료/로그아웃 — 마운트를 반드시 걷어낸다. */
  async stop(): Promise<void> {
    await this.reconcile().catch(() => undefined)
    await this.teardown()
    this.backend.dispose()
    this.emit()
  }
}

let instance: WorkspaceManager | null = null

export function initWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  instance = new WorkspaceManager(deps)
  return instance
}
export function getWorkspaceManager(): WorkspaceManager | null {
  return instance
}
