/**
 * 플랫폼별 마운트 제공자 선택 — 어디서 가상 드라이브가 되고, 어디서 안 되는가.
 *
 * 지원 현황 (2026-08):
 *
 *     Linux    FUSE (libfuse2 + @cocalc/fuse-native)   자식 프로세스로 마운트
 *     macOS    `mount_webdav` (내장)                    로컬 WebDAV 서버에 붙는다
 *     Windows  WebClient (내장, `net use`)              로컬 WebDAV 서버에 붙는다
 *
 * 즉 **서버는 하나**(webdav-server)이고, 플랫폼별 코드는 "이 URL 을 어떻게
 * 붙이느냐"뿐이다. macOS 는 Apple Developer Program 이 필요한 File Provider
 * Extension 을 쓰지 않으므로 별도 자격이 필요 없다.
 *
 * 여기서 하는 일은 **판정과 사유 전달**뿐이다. 실제 파일시스템 구현은 각
 * 제공자 모듈에 있고, 이 모듈은 그것들을 고르기만 한다 — 새 플랫폼이 생기면
 * 표 한 줄과 제공자 하나만 추가된다.
 */

import type { MountProvider } from './workspace'
import { PlainDirMount } from './workspace'

export type MountKind = 'fuse' | 'webdav' | 'unsupported' | 'plain'

export interface MountSupport {
  /** 이 컴퓨터에서 워크스페이스 기능을 쓸 수 있는가. */
  supported: boolean
  kind: MountKind
  /** 미지원일 때 사용자에게 그대로 보여줄 문구. */
  reason?: string
  /** 지원되지만 준비물이 빠졌을 때의 안내 (예: libfuse 미설치). */
  hint?: string
}

const MACOS_MIN_MAJOR = 19 // Darwin 19 = macOS 10.15

/**
 * 이 플랫폼에서 가상 드라이브가 가능한지 판정한다.
 *
 * ``probe`` 는 네이티브 준비물 확인을 주입하기 위한 테스트 훅이다 (실제로는
 * 바인딩 require 를 시도한다).
 */
export function detectMountSupport(
  platform: NodeJS.Platform = process.platform,
  probe: (kind: MountKind) => { ok: boolean; hint?: string } = defaultProbe,
): MountSupport {
  if (platform === 'darwin') {
    // WebDAV 는 macOS 내장 클라이언트(mount_webdav)로 붙는다 — Apple
    // Developer Program 도 커널 확장도 필요 없다.
    const p = probe('webdav')
    return p.ok
      ? { supported: true, kind: 'webdav' }
      : {
          supported: false,
          kind: 'unsupported',
          reason: '이 macOS 버전에서는 파일시스템 기능을 제공하지 않습니다.',
          hint: p.hint ?? `macOS 10.15 이상이 필요합니다.`,
        }
  }
  if (platform === 'linux') {
    const p = probe('fuse')
    return p.ok
      ? { supported: true, kind: 'fuse' }
      : {
          supported: false,
          kind: 'unsupported',
          reason: '이 컴퓨터에서 가상 드라이브를 만들 수 없습니다.',
          hint: p.hint ?? 'FUSE 가 필요합니다 — 배포판 패키지 관리자로 fuse 를 설치한 뒤 다시 시도하세요.',
        }
  }
  if (platform === 'win32') {
    // 내장 WebClient 로 붙는다 (net use). 별도 설치물이 없다.
    const p = probe('webdav')
    return p.ok
      ? { supported: true, kind: 'webdav' }
      : {
          supported: false,
          kind: 'unsupported',
          reason: '이 Windows 에서는 파일시스템 기능을 제공하지 않습니다.',
          hint: p.hint ?? 'WebClient 서비스가 필요합니다 (Windows 기능 "WebDAV 리디렉터").',
        }
  }
  return {
    supported: false,
    kind: 'unsupported',
    reason: `${platform} 에서는 파일시스템 기능을 제공하지 않습니다.`,
  }
}

/** 배포판별 설치 명령 — AppImage 는 의존성을 선언할 수 없어 앱이 안내한다. */
export function fuseInstallHint(release = ''): string {
  const r = release.toLowerCase()
  if (/(fedora|rhel|centos|\.fc\d)/.test(r)) return 'sudo dnf install fuse fuse-libs'
  if (/(arch|manjaro)/.test(r)) return 'sudo pacman -S fuse2'
  if (/(suse|opensuse)/.test(r)) return 'sudo zypper install fuse libfuse2'
  // 기본은 데비안 계열 — .deb 로 설치했다면 이미 의존성으로 들어와 있다.
  return 'sudo apt install libfuse2 fuse3   (Ubuntu 24.04 는 libfuse2t64)'
}

function defaultProbe(kind: MountKind): { ok: boolean; hint?: string } {
  if (kind === 'fuse') {
    const os = require('os') as typeof import('os')
    const install = fuseInstallHint(`${os.release?.() ?? ''} ${process.env.ID ?? ''}`)
    try {
      // 네이티브 바인딩이 이 빌드에 포함되어 로드되는지 (libfuse2 런타임 포함).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@cocalc/fuse-native')
    } catch (e) {
      return {
        ok: false,
        hint:
          `FUSE 라이브러리를 불러오지 못했습니다. 다음을 설치한 뒤 다시 시작하세요:\n  ${install}` +
          `\n(원인: ${(e as Error).message})`,
      }
    }
    // 바인딩이 로드돼도 **비루트 마운트에는 setuid fusermount 가 필요하다** —
    // 이게 없으면 마운트가 권한 오류로 죽는다. 미리 잡아 사용자에게 알린다.
    const fs = require('fs') as typeof import('fs')
    const helper = ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount3', '/bin/fusermount']
      .find((p) => {
        try {
          return fs.statSync(p).isFile()
        } catch {
          return false
        }
      })
    if (!helper) {
      return { ok: false, hint: `fusermount 도우미가 없습니다. 다음을 설치하세요:\n  ${install}` }
    }
    return { ok: true }
  }
  if (kind === 'webdav') {
    // Windows WebClient / macOS webdavfs 는 지원 버전이면 항상 있다.
    // 실제 마운트 가능 여부는 마운트 시점에 드러나므로 여기서는 OS 버전만 본다.
    const os = require('os') as typeof import('os')
    if (process.platform === 'darwin') {
      const major = Number(os.release().split('.')[0] || 0)
      return major >= MACOS_MIN_MAJOR
        ? { ok: true }
        : { ok: false, hint: 'macOS 10.15(카탈리나) 이상이 필요합니다.' }
    }
    return { ok: true }
  }
  return { ok: false }
}

/** 미지원 플랫폼용 제공자 — 무엇을 시켜도 사유를 들고 실패한다. */
export class UnsupportedMount implements MountProvider {
  readonly streaming = false

  constructor(private readonly reason: string) {}

  private fail(): never {
    throw new Error(this.reason)
  }

  ensureRoot(): string {
    this.fail()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  dispose(_root: string): void {
    /* 만든 적이 없으니 지울 것도 없다 — 던지면 로그아웃/종료가 깨진다. */
  }
}

/**
 * 판정 결과에 맞는 제공자를 만든다.
 *
 * 실제 FUSE/cfapi 구현이 붙기 전까지 지원 플랫폼은 :class:`PlainDirMount` 로
 * 동작한다 (기능은 되고, 스트리밍만 아직 아니다). 미지원 플랫폼은 제공자
 * 단계에서 막아 UI 가 사유를 그대로 보여줄 수 있게 한다.
 */
export function providerFor(support: MountSupport): MountProvider {
  if (!support.supported) return new UnsupportedMount(support.reason ?? '지원하지 않는 플랫폼입니다.')
  return new PlainDirMount()
}
