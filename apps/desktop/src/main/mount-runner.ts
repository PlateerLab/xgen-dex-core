/**
 * 플랫폼별 마운트 실행기 — "이 WebDAV URL 을 이 경로에 붙여라".
 *
 * 서버는 공통이고 여기서 하는 일은 OS 에게 마운트를 시키는 것뿐이다:
 *
 *     macOS    mount_webdav [-S [-v name]] <url> <mountpoint>
 *     Windows  net use <drive> <url> /persistent:no
 *     Linux    (FUSE — 별도 제공자)
 *
 * **모든 단계를 진단 로그에 남긴다.** 마운트 실패는 사용자 컴퓨터에서만
 * 재현되는 대표적인 문제라, 그 순간의 명령·종료코드·stderr 가 없으면 원인을
 * 추측할 수밖에 없다.
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';
import { diag } from './diag-log';

export interface MountResult {
  ok: boolean;
  /** 실제로 붙은 경로 (Windows 는 드라이브 문자). */
  path?: string;
  error?: string;
  /** 사용자에게 보여줄 다음 행동. */
  hint?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 명령 실행 + 로깅. 절대 throw 하지 않는다 — 실패도 결과다. */
export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  diag('mount', `exec ${cmd} ${args.join(' ')}`);
  return new Promise<RunResult>((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const res: RunResult = {
          code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        };
        diag('mount', `exit=${res.code}`, {
          stdout: res.stdout.slice(0, 500),
          stderr: res.stderr.slice(0, 500),
        });
        resolve(res);
      },
    );
  });
}

// ── macOS ────────────────────────────────────────────────────────────

/**
 * macOS: `mount_webdav`.
 *
 * ⚠ 실기에서 확인된 것: `-S` 와 `-i` 를 **함께 주면 usage 오류**다. 둘이
 * 모순이기 때문이다 (`-S` = 모든 대화상자 억제, `-i` = 대화형). 처음에 둘 다
 * 넘겼다가 다음을 받았다:
 *
 *     usage: mount_webdav [-i] [-s] [-S] [-o options] [-v <volume name>]
 *                         <WebDAV_URL> node
 *
 * macOS 버전마다 받는 플래그가 미묘하게 다르므로, **후보를 사다리로 시도하고
 * 각 시도를 진단 로그에 남긴다** — 한 번의 사용자 테스트로 어떤 조합이 통하는지
 * 확정된다. 성공한 조합은 로그에 남아 다음 릴리스에서 첫 번째로 올릴 수 있다.
 *
 * 마운트 지점은 **미리 존재해야** 하고 비어 있어야 한다.
 */
const MACOS_ATTEMPTS: Array<{ label: string; args: (url: string, mnt: string) => string[] }> = [
  // 대화상자 억제 + Finder 볼륨 이름
  { label: '-S -v', args: (u, m) => ['-S', '-v', 'XGEN Workspace', u, m] },
  // 억제만
  { label: '-S', args: (u, m) => ['-S', u, m] },
  // 플래그 없이 (가장 보수적)
  { label: 'bare', args: (u, m) => [u, m] },
];

export async function mountMacos(url: string, mountpoint: string): Promise<MountResult> {
  await unmountMacos(mountpoint); // 스테일 정리
  try {
    mkdirSync(mountpoint, { recursive: true });
  } catch (e) {
    return { ok: false, error: `마운트 지점을 만들지 못했습니다: ${(e as Error).message}` };
  }

  const failures: string[] = [];
  for (const attempt of MACOS_ATTEMPTS) {
    diag('mount', `macOS 시도: ${attempt.label}`);
    const r = await run('/sbin/mount_webdav', attempt.args(url, mountpoint));
    if (r.code === 0) {
      diag('mount', `macOS 마운트 성공 (${attempt.label}) → ${mountpoint}`);
      return { ok: true, path: mountpoint };
    }
    const err = (r.stderr || r.stdout).trim().split('\n')[0] || `code ${r.code}`;
    failures.push(`${attempt.label}: ${err}`);
    // usage 오류가 아니라 실제 마운트 실패(권한/네트워크)면 다음 조합도 같은
    // 이유로 실패한다 — 사다리를 계속 타는 건 로그만 지저분해진다.
    if (!/usage:/i.test(err)) {
      diag('mount', `사다리 중단 (usage 오류 아님): ${err}`);
      break;
    }
  }

  return {
    ok: false,
    error: failures[failures.length - 1] ?? 'mount_webdav 가 실패했습니다',
    hint:
      'Finder 에서 "이동 > 서버에 연결"로 같은 주소가 열리는지 확인해 보세요. ' +
      '진단 로그에 시도한 조합이 전부 남아 있습니다.',
  };
}

export async function unmountMacos(mountpoint: string): Promise<void> {
  if (!existsSync(mountpoint)) return;
  // 마운트돼 있지 않아도 umount 는 무해하게 실패한다 — 상태 조회보다 싸다.
  await run('/sbin/umount', ['-f', mountpoint], { timeoutMs: 10_000 });
  try {
    // 빈 디렉터리만 정리 (사용자 파일이 남아 있으면 건드리지 않는다).
    if (existsSync(mountpoint) && readdirSync(mountpoint).length === 0) rmdirSync(mountpoint);
  } catch {
    /* 정리는 실패해도 무방 */
  }
}

// ── Windows ──────────────────────────────────────────────────────────

/** 쓸 수 있는 드라이브 문자를 고른다 (Z 부터 거꾸로 — 흔한 문자를 피한다). */
export async function pickDriveLetter(): Promise<string | null> {
  const used = new Set<string>();
  const r = await run('cmd.exe', ['/d', '/s', '/c', 'net use']);
  for (const m of r.stdout.matchAll(/^\s*\S*\s+([A-Z]):/gim)) used.add(m[1].toUpperCase());
  for (const c of 'ZYXWVUTSRQPONMLKJIH') {
    if (!used.has(c) && !existsSync(`${c}:\\`)) return `${c}:`;
  }
  return null;
}

/**
 * Windows: 내장 WebClient 로 드라이브를 붙인다.
 *
 * ⚠ WebClient 는 기본 **50MB 파일 상한**이 있다 (FileSizeLimitInBytes).
 * 이건 레지스트리(HKLM) 조정이라 설치 프로그램에서 다루고, 여기서는 상한에
 * 걸렸을 때 사용자가 원인을 알 수 있도록 로그에 남긴다.
 */
export async function mountWindows(url: string): Promise<MountResult> {
  // WebClient 가 꺼져 있으면 net use 가 "시스템 오류 67" 로 실패한다 —
  // 시작을 시도하고, 안 되면 사용자에게 그대로 알린다.
  await run('cmd.exe', ['/d', '/s', '/c', 'sc start WebClient'], { timeoutMs: 15_000 });
  // 새 마운트 전에 이전 세션이 남긴 유령 WebDAV 마운트를 걷어 낸다(무한 누적 방지).
  await unmountStaleWindows().catch(() => 0);
  const drive = await pickDriveLetter();
  if (!drive) {
    return { ok: false, error: '사용 가능한 드라이브 문자가 없습니다.' };
  }
  const r = await run('cmd.exe', ['/d', '/s', '/c', `net use ${drive} ${url} /persistent:no`]);
  if (r.code === 0) {
    diag('mount', `Windows 마운트 성공: ${drive}`);
    return { ok: true, path: drive };
  }
  const err = (r.stdout || r.stderr).trim();
  return {
    ok: false,
    error: err || `net use 가 코드 ${r.code} 로 실패했습니다`,
    hint: /67|WebClient/i.test(err)
      ? 'Windows 의 "WebClient" 서비스가 필요합니다. 서비스 관리자에서 시작한 뒤 다시 시도하세요.'
      : undefined,
  };
}

/**
 * 스테일 Windows WebDAV 마운트 정리 — **누적 버그의 근본 해결**.
 *
 * 우리 마운트는 매 시작마다 새 포트/토큰/드라이브 문자로 붙는데(webdav-server),
 * 앱이 업데이트로 **언마운트 전에 강제 종료**되면 이전 마운트가 유령 드라이브로
 * 남는다(실기: net use 에 "연결 안 됨" 으로 쌓임). 다음 시작이 또 다른 문자로 붙으며
 * 무한 누적됐다. 새 마운트를 만들기 **전에** 우리(127.0.0.1 로컬 WebDAV) 마운트를
 * 전부 걷어 낸다 — 마커 유무와 무관하게(이 수정 이전 버전이 남긴 것도 정리).
 *
 * 127.0.0.1 로 WebDAV 를 붙이는 건 이 커넥터뿐이라 안전하다. 반환은 정리한 개수.
 */
/**
 * `net use` 출력 → 정리할 대상(드라이브 문자 또는 원격 경로) 목록. 순수 함수(테스트 대상).
 * 우리 마운트만: 원격이 127.0.0.1 인 항목. 드라이브 문자가 있으면 그걸로, 없으면(연결 끊김) 원격 경로로.
 */
export function parseStaleWebdavTargets(netUseStdout: string): string[] {
  const drives = new Set<string>();
  const remotes = new Set<string>();
  for (const line of String(netUseStdout || '').split(/\r?\n/)) {
    if (!/127\.0\.0\.1/.test(line)) continue; // 우리 로컬 WebDAV 만
    const dm = line.match(/\b([A-Z]):/);
    if (dm) drives.add(`${dm[1]}:`);
    else {
      const rm = line.match(/\\\\127\.0\.0\.1@\d+\S*/);
      if (rm) remotes.add(rm[0].trim());
    }
  }
  return [...drives, ...remotes];
}

export async function unmountStaleWindows(): Promise<number> {
  const scan = async () =>
    parseStaleWebdavTargets((await run('cmd.exe', ['/d', '/s', '/c', 'net use'])).stdout);
  const before = await scan();
  if (before.length === 0) return 0;
  // 1) 드라이브 문자 매핑은 **강제 제거**한다. `net use /delete` 는 이전 세션의 WebDAV
  //    서버가 사라진 **죽은 마운트**에서 실패·행(hang)하는데(=무한 누적의 진짜 원인),
  //    WScript.Network.RemoveNetworkDrive(force) 는 사용 중·연결 끊김도 걷어 낸다.
  await forceRemoveStaleWindowsDrives().catch(() => undefined);
  // 2) 남은 것(드라이브 문자 없는 끊긴 원격 + PS 미처리분)은 net use /delete 로 마저.
  const remaining = await scan();
  await Promise.all(
    remaining.map((t) =>
      run('cmd.exe', ['/d', '/s', '/c', `net use "${t}" /delete /y`], { timeoutMs: 10_000 }),
    ),
  );
  const after = await scan();
  const cleaned = Math.max(0, before.length - after.length);
  if (cleaned) diag('mount', `스테일 WebDAV 마운트 ${cleaned}/${before.length}개 정리 완료`);
  if (after.length)
    diag('mount', `스테일 WebDAV ${after.length}개 잔존 — 재부팅 시 정리(persistent:no)`);
  return cleaned;
}

/**
 * 127.0.0.1 WebDAV 드라이브 매핑을 **강제 제거** — 로케일 무관·죽은 서버도 걷힌다.
 *
 * `WScript.Network.RemoveNetworkDrive(name, force=true, updateProfile=true)` 는 연결
 * 끊김·사용 중 매핑도 강제로 제거한다 (`net use /delete` 가 죽은 WebDAV 에서 실패·행하던
 * 누적의 근본 원인을 우회). PS 안에서 `net use` 출력을 직접 훑어 `127.0.0.1@` 라인의
 * 드라이브 문자만 뽑으므로 한국어 등 로케일 문자열에 의존하지 않는다. PS 부재/실패는
 * 조용히 무시하고 호출부의 net use /delete 폴백에 맡긴다.
 */
async function forceRemoveStaleWindowsDrives(): Promise<void> {
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    '$n=New-Object -ComObject WScript.Network;' +
    "foreach($l in (net use)){if($l -match '127\\.0\\.0\\.1@' -and $l -match '\\b([A-Za-z]):'){try{$n.RemoveNetworkDrive($matches[1]+':',$true,$true)}catch{}}}";
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeoutMs: 20_000,
  });
}

export async function unmountWindows(drive: string): Promise<void> {
  if (!drive) return;
  await run('cmd.exe', ['/d', '/s', '/c', `net use ${drive} /delete /y`], { timeoutMs: 15_000 });
}

// ── Linux (FUSE 제공자가 별도로 처리) ────────────────────────────────

/**
 * 스테일 FUSE 마운트 정리.
 *
 * 프로세스가 죽으면 마운트포인트가 "Transport endpoint is not connected"
 * 상태로 남아 **이후 모든 접근을 막는다** (실기에서 확인). 기동 시 이걸
 * 걷어내지 않으면 한 번 크래시한 사용자는 폴더가 영구히 먹통이 된다.
 */
export async function clearStaleFuse(mountpoint: string): Promise<boolean> {
  if (!existsSync(mountpoint)) return false;
  try {
    readdirSync(mountpoint);
    return false; // 정상 — 건드리지 않는다
  } catch (e) {
    const msg = (e as Error).message;
    diag('mount', `스테일 마운트 감지: ${mountpoint} (${msg})`);
    for (const bin of ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount']) {
      if (!existsSync(bin)) continue;
      const r = await run(bin, ['-uz', mountpoint], { timeoutMs: 10_000 });
      if (r.code === 0) {
        diag('mount', '스테일 마운트 정리됨');
        return true;
      }
    }
    diag('mount', '스테일 마운트를 정리하지 못했다 — 사용자 개입 필요');
    return false;
  }
}

// ── 통합 진입점 ──────────────────────────────────────────────────────

export function defaultMountpoint(root: string): string {
  // macOS 는 /Volumes 대신 사용자 홈 아래를 쓴다 — /Volumes 쓰기는 권한이
  // 걸리고, 홈 아래면 Finder 사이드바에도 자연스럽게 붙는다.
  return process.platform === 'darwin' ? root : root;
}

export async function mountWebdav(
  url: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<MountResult> {
  diag('mount', `마운트 시작 platform=${platform} root=${basename(root)}`);
  if (platform === 'darwin') return mountMacos(url, defaultMountpoint(root));
  if (platform === 'win32') return mountWindows(url);
  return {
    ok: false,
    error: `${platform} 에서는 WebDAV 마운트를 지원하지 않습니다.`,
    hint: 'Linux 는 FUSE 제공자를 사용합니다.',
  };
}

export async function unmountWebdav(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  diag('mount', `언마운트 ${path}`);
  if (platform === 'darwin') return unmountMacos(path);
  if (platform === 'win32') return unmountWindows(path);
}

/** 기본 루트 (마운트 지점). */
export function defaultRootPath(home = homedir()): string {
  return join(home, 'XGEN-Workspace');
}
