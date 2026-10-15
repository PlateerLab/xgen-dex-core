/**
 * Claude Code·Codex CLI 찾기 — XD 가 설치한 것 → PATH(로그인 셸 포함) → 알려진 위치.
 *
 * 찾는 것은 **실행 파일**뿐이다. 로그인은 XD 전용 홈(`<루트>/.xd/cli/<이름>/home`)에 따로 한다 — 사용자의
 * `~/.claude`·`~/.codex` 를 쓰면 그쪽의 훅·플러그인·MCP·지시 파일이 에이전트 턴에 섞이고, 한 번 쓰면 바뀌는
 * 토큰을 두 곳이 나눠 쓰다 한쪽이 끊긴다(DESIGN §6).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutable } from '@dex/engine/exec-resolve';

export type CliName = 'claude' | 'codex';

export interface CliFound {
  name: CliName;
  path: string;
  /** `--version` 에서 읽은 판(못 읽으면 null — 실행이 안 되는 파일일 수 있다). */
  version: string | null;
  source: 'xd' | 'path' | 'known';
}

const exe = (name: string, platform: NodeJS.Platform) => (platform === 'win32' ? `${name}.exe` : name);

/** XD 가 설치한 실행 파일의 자리. */
export function xdCliPath(cliDir: string, name: CliName, platform: NodeJS.Platform = process.platform): string {
  return join(cliDir, name, 'bin', exe(name, platform));
}

/** 공식 설치기·패키지 관리자가 흔히 두는 자리(PATH 에 없을 때). */
export function knownCliPaths(name: CliName, home = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return name === 'claude'
      ? [join(home, '.local', 'bin', 'claude.exe'), join(appData, 'npm', 'claude.cmd'), join(local, 'Programs', 'claude', 'claude.exe')]
      : [join(appData, 'npm', 'codex.cmd'), join(home, '.local', 'bin', 'codex.exe')];
  }
  const common = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin')];
  return name === 'claude'
    ? [...common.map((d) => join(d, 'claude')), join(home, '.claude', 'local', 'claude')]
    : [...common.map((d) => join(d, 'codex')), join(home, '.local', 'codex-cli', 'bin', 'codex')];
}

/** `--version` 첫 줄의 판(2.1.285 · 0.160.0). */
export function parseVersion(output: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(output);
  return m ? m[1] : null;
}

export function cliVersion(path: string, timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: timeoutMs, windowsHide: true, shell: /\.(cmd|bat)$/i.test(path) }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve(null);
      resolve(parseVersion(`${stdout}\n${stderr}`));
    });
  });
}

export interface DetectOptions {
  /** `<루트>/.xd/cli` */
  cliDir: string;
  /** 찾을 PATH(로그인 셸로 보강한 것). */
  pathStr: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** 시험이 바꾼다. */
  version?: (path: string) => Promise<string | null>;
}

/** 처음 찾은 것. 판을 읽지 못한 파일은 건너뛴다(깨진 설치·다른 프로그램). */
export async function detectCli(name: CliName, opts: DetectOptions): Promise<CliFound | null> {
  const platform = opts.platform ?? process.platform;
  const version = opts.version ?? cliVersion;
  const candidates: Array<{ path: string; source: CliFound['source'] }> = [];
  const xd = xdCliPath(opts.cliDir, name, platform);
  if (existsSync(xd)) candidates.push({ path: xd, source: 'xd' });
  const onPath = resolveExecutable(name, opts.pathStr);
  if (onPath) candidates.push({ path: onPath, source: 'path' });
  for (const p of knownCliPaths(name, opts.home, platform)) {
    if (existsSync(p)) candidates.push({ path: p, source: 'known' });
  }
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const v = await version(c.path);
    if (v) return { name, path: c.path, version: v, source: c.source };
  }
  return null;
}
