/**
 * 실행 파일 해석 + 미설치 런타임 진단 — `spawn uvx ENOENT` 부류의 근본 처리.
 *
 * 두 가지 서로 다른 실패를 구분해서 다룬다:
 *
 *  1) **설치는 됐는데 앱이 못 찾는 경우** — GUI(Finder/Dock/시작 메뉴)로 실행된
 *     앱은 로그인 셸의 PATH 를 상속하지 않는다. macOS 는 `/usr/bin:/bin` 수준만
 *     물려받아 `~/.local/bin/uvx`, `/opt/homebrew/bin/npx` 를 전부 놓친다.
 *     → 로그인 셸 PATH 를 읽어 보강하고 **절대 경로로 해석**해서 넘긴다.
 *
 *  2) **애초에 설치가 안 된 경우** (사용자의 mac: `zsh: command not found: uvx`)
 *     → 무엇이 없는지, 어떻게 설치하는지 플랫폼별로 정확히 안내한다.
 *
 * Windows 의 `.cmd`/`.exe` 확장자 해석도 여기서 한다 (`npx` 는 실제로
 * `npx.cmd` — 확장자 없이 spawn 하면 실패). 실제 spawn 은 MCP SDK 가
 * cross-spawn 으로 하므로 `.cmd` 를 절대 경로로 넘겨도 안전하다.
 */

import { execFile } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import { homedir } from 'os';
import { basename, delimiter, isAbsolute, join, sep } from 'path';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// ── 알려진 런타임: 없을 때 무엇을 어떻게 설치해야 하는지 ──────────────

export interface RuntimeInfo {
  /** 사람이 읽는 이름 */
  label: string;
  /** 이 런타임이 제공하는 명령들 (첫 항목이 대표) */
  commands: string[];
  /** 이 명령이 무엇인지 한 줄 설명 */
  what: string;
  /** 플랫폼별 설치 방법 (표시 순서대로) */
  install: () => string[];
  /** 공식 안내 링크 */
  url: string;
}

const RUNTIMES: RuntimeInfo[] = [
  {
    label: 'uv',
    commands: ['uvx', 'uv'],
    what: 'Python MCP 서버를 실행하는 uv 패키지 매니저의 실행기입니다.',
    url: 'https://docs.astral.sh/uv/getting-started/installation/',
    install: () =>
      IS_WIN
        ? ['powershell -c "irm https://astral.sh/uv/install.ps1 | iex"', 'winget install astral-sh.uv']
        : IS_MAC
          ? ['curl -LsSf https://astral.sh/uv/install.sh | sh', 'brew install uv']
          : ['curl -LsSf https://astral.sh/uv/install.sh | sh'],
  },
  {
    label: 'Node.js',
    commands: ['npx', 'npm', 'node'],
    what: 'JavaScript MCP 서버를 실행하는 Node.js 런타임입니다.',
    url: 'https://nodejs.org/',
    install: () =>
      IS_WIN
        ? ['winget install OpenJS.NodeJS.LTS', 'https://nodejs.org 에서 LTS 설치 프로그램 내려받기']
        : IS_MAC
          ? ['brew install node', 'https://nodejs.org 에서 LTS 설치 프로그램 내려받기']
          : ['sudo apt install nodejs npm  (Debian/Ubuntu)', 'https://nodejs.org 에서 LTS 내려받기'],
  },
  {
    label: 'Python',
    commands: ['python3', 'python', 'pip', 'pip3', 'pipx'],
    what: 'Python 런타임/패키지 도구입니다.',
    url: 'https://www.python.org/downloads/',
    install: () =>
      IS_WIN
        ? ['winget install Python.Python.3.12']
        : IS_MAC
          ? ['brew install python']
          : ['sudo apt install python3 python3-pip  (Debian/Ubuntu)'],
  },
  {
    label: 'Docker',
    commands: ['docker'],
    what: '컨테이너로 배포된 MCP 서버를 실행합니다.',
    url: 'https://docs.docker.com/get-started/get-docker/',
    install: () => ['https://docs.docker.com/get-started/get-docker/ 에서 Docker Desktop 설치'],
  },
  {
    label: 'Bun',
    commands: ['bun', 'bunx'],
    what: 'Bun 런타임입니다.',
    url: 'https://bun.sh/',
    install: () =>
      IS_WIN ? ['powershell -c "irm bun.sh/install.ps1 | iex"'] : ['curl -fsSL https://bun.sh/install | bash'],
  },
  {
    label: 'Deno',
    commands: ['deno'],
    what: 'Deno 런타임입니다.',
    url: 'https://deno.land/',
    install: () =>
      IS_WIN ? ['irm https://deno.land/install.ps1 | iex'] : ['curl -fsSL https://deno.land/install.sh | sh'],
  },
];

/** 명령 이름으로 알려진 런타임을 찾는다 (확장자·경로 제거 후 비교). */
export function runtimeFor(command: string): RuntimeInfo | null {
  const base = basename(command.trim()).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
  return RUNTIMES.find((r) => r.commands.includes(base)) ?? null;
}

// ── PATH 보강 ────────────────────────────────────────────────────────

/** 사용자 도구가 흔히 설치되는 위치 (플랫폼별). */
export function commonBinDirs(home = homedir()): string[] {
  if (IS_WIN) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(localAppData, 'Microsoft', 'WindowsApps'),
      join(appData, 'npm'),
      join(localAppData, 'Programs', 'nodejs'),
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.bun', 'bin'),
      join(localAppData, 'Programs', 'Python', 'Scripts'),
      'C:\\Program Files\\nodejs',
    ];
  }
  return [
    '/opt/homebrew/bin', // Apple Silicon homebrew
    '/usr/local/bin',
    '/opt/local/bin', // MacPorts
    join(home, '.local', 'bin'), // uv / pipx
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, 'bin'),
    '/usr/bin',
    '/bin',
    '/snap/bin',
  ];
}

interface PathCache {
  value: string | null;
  at: number;
}
let loginPathCache: PathCache | null = null;
//: 로그인 셸 PATH 캐시 수명 — 사용자가 도구를 설치한 직후 [테스트]를 다시
//: 누르면 앱 재시작 없이 인식되어야 한다.
const PATH_CACHE_TTL_MS = 20_000;

/** 캐시를 즉시 버린다 (설치 직후 재시도 경로). */
export function resetPathCache(): void {
  loginPathCache = null;
}

/**
 * `env` 출력에서 PATH 줄을 뽑는다.
 *
 * `printf "$PATH"` 대신 `env` 를 쓰는 이유: **fish 는 $PATH 가 리스트**라
 * 문자열 보간하면 `/a /b` 처럼 공백으로 이어져 PATH 로 못 쓴다. 반면 `env`
 * 는 프로세스 환경 블록을 그대로 찍으므로 어느 셸이든 항상 `:` 로 이어진
 * 올바른 값이 나온다.
 *
 * rc 파일이 앞에 잡음을 뱉을 수 있어 **마지막** PATH= 줄을 택한다.
 */
export function parseEnvPath(stdout: string): string | null {
  let found: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^PATH=(.*)$/.exec(line);
    if (m) found = m[1];
  }
  if (!found) return null;
  const value = found.trim();
  if (!value) return null;
  // 온전성 검사 — 실재하는 디렉터리가 하나도 없으면 잘못 파싱한 것으로 본다.
  const usable = value.split(delimiter).some((d) => {
    if (!d) return false;
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  return usable ? value : null;
}

/** 로그인 셸의 PATH 를 읽는다 (darwin/linux). 실패/지연은 무시. */
export async function loginShellPath(): Promise<string | null> {
  if (IS_WIN) return null;
  if (loginPathCache && Date.now() - loginPathCache.at < PATH_CACHE_TTL_MS) {
    return loginPathCache.value;
  }
  const shell = process.env.SHELL || '/bin/bash';
  const value = await new Promise<string | null>((resolve) => {
    // -i(대화형)까지 줘야 ~/.zshrc·~/.bashrc 의 PATH 추가가 반영된다. 다만
    // 일부 환경에서 멈출 수 있어 타임아웃으로 끊는다 (실패해도 commonBinDirs
    // 보강만으로 동작한다).
    execFile(shell, ['-ilc', 'env'], { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }, (_err, stdout) => {
      // 종료 코드가 0이 아니어도 출력이 있으면 쓴다 (rc 스크립트가 비정상
      // 종료 코드로 끝나는 환경이 흔하다).
      resolve(stdout ? parseEnvPath(stdout) : null);
    });
  });
  loginPathCache = { value, at: Date.now() };
  return value;
}

/** 중복 제거 + 빈 항목 제거로 PATH 문자열을 만든다. */
export function mergePaths(...sources: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    for (const p of src.split(delimiter)) {
      const dir = p.trim().replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '');
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

/** GUI 실행에서도 사용자 도구를 찾을 수 있는 PATH. */
export async function augmentedPath(): Promise<string> {
  const login = await loginShellPath();
  return mergePaths(login, process.env.PATH, commonBinDirs().join(delimiter));
}

/**
 * 자식 프로세스 환경을 만든다.
 *
 * Windows 의 환경변수는 **대소문자를 구분하지 않는데**, spawn 에 넘기는 객체는
 * 구분한다. `{...process.env}` 는 보통 `Path` 로 들어오므로 여기에 `PATH` 를
 * 더하면 키가 둘이 되고, 조회하는 쪽(cross-spawn 의 path-key)이 어느 쪽을
 * 집을지 알 수 없다 — 사용자가 서버 설정에서 PATH 를 직접 지정했는데 무시되는
 * 사고가 여기서 난다. 그래서 Windows 에서는 path 계열 키를 하나로 합친다.
 *
 * 우선순위: 서버 설정 env > 보강된 PATH > 현재 프로세스 env.
 */
export function buildChildEnv(
  pathStr: string,
  cfgEnv?: Record<string, string>,
  base: Record<string, string | undefined> = process.env as Record<string, string>,
): Record<string, string> {
  const isPathKey = (k: string) => k.toLowerCase() === 'path';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (IS_WIN && isPathKey(k)) continue; // 아래에서 한 번만 넣는다
    out[k] = v;
  }
  // 사용자가 PATH 를 직접 지정했으면 그 값을 존중한다.
  const userPathKey = Object.keys(cfgEnv || {}).find(isPathKey);
  const effectivePath = userPathKey ? (cfgEnv as Record<string, string>)[userPathKey] : pathStr;
  for (const [k, v] of Object.entries(cfgEnv || {})) {
    if (isPathKey(k)) continue; // PATH 는 아래에서 일괄 처리
    out[k] = v;
  }
  if (IS_WIN) {
    out.Path = effectivePath; // Windows 표기 관례 — 단 하나만 존재하게 한다
  } else {
    out.PATH = effectivePath;
  }
  return out;
}

// ── 실행 파일 탐색 ───────────────────────────────────────────────────

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (IS_WIN) return true; // Windows 는 확장자로 실행 가능성을 판단
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows 확장자 후보 (PATHEXT). npx/uvx 는 실제로 npx.cmd/uvx.exe 다. */
function winExtensions(): string[] {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  // PATHEXT 는 관례상 대문자지만 실제 파일은 uvx.cmd/node.exe 처럼 소문자다.
  // Windows 조회는 대소문자 무시라 어느 쪽이든 찾지만, 반환 경로가 실제
  // 파일명과 같아야 로그/오류가 헷갈리지 않는다.
  return raw.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/**
 * *command* 의 절대 경로를 찾는다. 경로 구분자가 들어 있으면 그대로 검증만
 * 한다. 못 찾으면 null.
 */
export function resolveExecutable(command: string, pathStr: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;
  const hasSep = cmd.includes('/') || (IS_WIN && cmd.includes('\\'));
  const candidates = (base: string): string[] =>
    IS_WIN ? [base, ...winExtensions().map((e) => base + e)] : [base];

  if (hasSep || isAbsolute(cmd)) {
    for (const c of candidates(cmd)) if (isExecutableFile(c)) return c;
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates(join(dir, cmd))) {
      if (isExecutableFile(c)) return c;
    }
  }
  return null;
}

// ── 진단 ─────────────────────────────────────────────────────────────

export interface ExecDiagnosis {
  /** 못 찾은 명령 */
  command: string;
  /** 한 줄 요약 (UI 본문) */
  summary: string;
  /** 해결 방법 — 설치 명령/링크 등 (UI 목록) */
  hints: string[];
}

/**
 * 못 찾은 명령을 진단한다. 알려진 런타임이면 설치 방법을, 아니면 경로 지정
 * 방법을 안내한다. 같은 런타임의 **형제 명령이 있는지**까지 봐서 더 정확한
 * 원인을 짚는다 (예: uv 는 있는데 uvx 가 없다 → uv 버전이 낮다).
 */
export function diagnoseMissing(command: string, pathStr: string): ExecDiagnosis {
  const rt = runtimeFor(command);
  const hints: string[] = [];
  const dirCount = pathStr.split(delimiter).filter(Boolean).length;

  const base = basename(command);
  if (rt) {
    const sibling = rt.commands.find((c) => c !== base && resolveExecutable(c, pathStr));
    if (sibling) {
      hints.push(
        `참고: 같은 런타임의 "${sibling}" 는 찾았습니다 — ${rt.label} 버전이 낮을 수 있습니다. ` +
          `최신으로 올리면 "${base}" 도 함께 설치됩니다.`,
      );
    }
    hints.push(...rt.install().map((cmd) => `설치: ${cmd}`));
    hints.push(`안내: ${rt.url}`);
  }
  // 절대 경로 예시는 **이 컴퓨터의 실제 홈 경로**로 보여준다 (플랫폼마다 다름).
  const example = IS_WIN
    ? join(homedir(), '.local', 'bin', `${base}.exe`)
    : join(homedir(), '.local', 'bin', base);
  hints.push(
    IS_WIN
      ? `또는 실행 명령에 절대 경로를 적으세요 (예: ${example}). PowerShell 에서 ` +
        `\`Get-Command ${base}\` 로 확인할 수 있습니다.`
      : `또는 실행 명령에 절대 경로를 적으세요 (예: ${example}). 터미널에서 ` +
        `\`which ${base}\` 로 확인할 수 있습니다.`,
  );
  hints.push('설치한 뒤 [테스트]를 다시 누르면 재검색합니다 (앱 재시작 불필요).');

  // 한국어 조사(이/가·을/를)는 명령 이름에 따라 달라진다 — 조사 없는 문장으로
  // 쓴다.
  const summary = rt
    ? `"${command}" — 실행 파일을 찾을 수 없습니다. ${rt.label} 설치가 필요합니다. ${rt.what}`
    : `"${command}" — 실행 파일을 찾을 수 없습니다 (PATH ${dirCount}개 경로 검색).`;
  return { command, summary, hints };
}

/** 진단 결과를 담아 던지는 오류 — 호출자가 hints 를 UI 로 전달한다. */
export class ExecNotFoundError extends Error {
  readonly hints: string[];
  readonly command: string;
  constructor(d: ExecDiagnosis) {
    super(d.summary);
    this.name = 'ExecNotFoundError';
    this.command = d.command;
    this.hints = d.hints;
  }
}
