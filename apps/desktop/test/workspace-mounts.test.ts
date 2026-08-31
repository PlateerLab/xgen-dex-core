/**
 * 플랫폼 게이팅 — macOS 는 기능을 숨기고 사유를 말한다.
 *
 * "반쯤 되는" 상태가 가장 위험하다: 사용자는 파일이 사라졌다고 느낀다.
 * 미지원이면 **아무것도 만들지 않고** 사유를 들고 실패해야 한다.
 */
import assert from 'assert'
import { test } from 'node:test'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectMountSupport,
  fuseInstallHint,
  providerFor,
  UnsupportedMount,
} from '../src/main/workspace-mounts'
import { materialize, setMountProvider, mount } from '../src/main/workspace'

const okProbe = () => ({ ok: true })
const failProbe = () => ({ ok: false, hint: '준비물 없음' })

test('macOS 는 내장 WebDAV 클라이언트로 지원된다', () => {
  // Apple Developer Program 도 커널 확장도 필요 없는 경로.
  const s = detectMountSupport('darwin', okProbe)
  assert.equal(s.supported, true)
  assert.equal(s.kind, 'webdav')
})

test('구형 macOS 는 사유와 함께 막는다', () => {
  const s = detectMountSupport('darwin', failProbe)
  assert.equal(s.supported, false)
  assert.equal(s.hint, '준비물 없음')
})

test('Linux 는 FUSE 가 있으면 지원', () => {
  const s = detectMountSupport('linux', okProbe)
  assert.equal(s.supported, true)
  assert.equal(s.kind, 'fuse')
})

test('Linux 에서 FUSE 준비물이 없으면 사유와 해결 힌트를 준다', () => {
  const s = detectMountSupport('linux', failProbe)
  assert.equal(s.supported, false)
  assert.ok(s.reason && s.reason.length > 0)
  assert.equal(s.hint, '준비물 없음')
})

test('Windows 는 내장 WebClient 로 지원된다', () => {
  const s = detectMountSupport('win32', okProbe)
  assert.equal(s.supported, true)
  assert.equal(s.kind, 'webdav')
})

test('구형 Windows 는 사유와 함께 막는다', () => {
  const s = detectMountSupport('win32', failProbe)
  assert.equal(s.supported, false)
  assert.equal(s.hint, '준비물 없음')
})

test('모르는 플랫폼도 조용히 실패하지 않고 사유를 말한다', () => {
  const s = detectMountSupport('freebsd' as NodeJS.Platform, okProbe)
  assert.equal(s.supported, false)
  assert.ok(s.reason?.includes('freebsd'))
})

test('미지원 제공자는 마운트 지점조차 만들지 않는다', () => {
  const support = detectMountSupport('freebsd' as NodeJS.Platform, okProbe)
  const provider = providerFor(support)
  assert.ok(provider instanceof UnsupportedMount)

  const original = mount()
  setMountProvider(provider)
  try {
    const home = mkdtempSync(join(tmpdir(), 'ws-unsup-'))
    assert.throws(
      () => materialize({ agents: [] }, home),
      /파일시스템 기능을 제공하지 않습니다/,
      '미지원 플랫폼에서 마운트 지점을 만들었다',
    )
    assert.ok(!existsSync(join(home, 'XGEN-Workspace')), '미지원인데 루트를 만들었다')
  } finally {
    setMountProvider(original)
  }
})

test('미지원 제공자의 정리 요청은 조용히 지나간다', () => {
  const provider = new UnsupportedMount('nope')
  // 만든 적이 없으니 지울 것도 없다 — 여기서 던지면 로그아웃/종료가 깨진다.
  assert.doesNotThrow(() => provider.dispose('/x'))
})

test('지원 플랫폼은 실제로 동작하는 제공자를 받는다', () => {
  const provider = providerFor(detectMountSupport('linux', okProbe))
  assert.ok(!(provider instanceof UnsupportedMount))
  const home = mkdtempSync(join(tmpdir(), 'ws-lin-'))
  const root = provider.ensureRoot(join(home, 'XGEN-Workspace'))
  assert.ok(existsSync(root))
})

test('배포판별 설치 명령을 정확히 안내한다 (AppImage 는 의존성 선언이 불가)', () => {
  assert.match(fuseInstallHint('6.8.0-generic ubuntu'), /apt install libfuse2/)
  assert.match(fuseInstallHint('6.5.0-1.fc39.x86_64'), /dnf install/)
  assert.match(fuseInstallHint('6.9-arch1-1'), /pacman -S fuse2/)
  assert.match(fuseInstallHint('6.4.0-150600-default opensuse'), /zypper/)
  // 모르는 배포판은 데비안 계열로 안내한다 (가장 흔한 대상)
  assert.match(fuseInstallHint(''), /apt install/)
})

test('실제 이 컴퓨터의 FUSE 준비 상태를 판정한다 (실기)', (ctx) => {
  if (process.platform !== 'linux') return ctx.skip('linux 전용')
  const s = detectMountSupport('linux')
  // 이 저장소의 CI/개발 머신은 libfuse-dev 를 설치하므로 지원이어야 한다.
  // 실패하면 hint 가 사용자에게 그대로 나갈 문구다 — 비어 있으면 안 된다.
  if (!s.supported) {
    assert.ok(s.hint && s.hint.length > 10, `안내 문구가 없다: ${JSON.stringify(s)}`)
    assert.match(s.hint!, /install/)
  } else {
    assert.equal(s.kind, 'fuse')
  }
})
