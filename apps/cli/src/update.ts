import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `dex update` — 새 버전이 있으면 올리고, 아니면 최신이라고 말한다.
 *
 * 두 가지를 정직하게 다룬다:
 *
 * **어떻게 설치됐는지 모른 채 명령을 쏘지 않는다.** 전역 npm 설치가 아니면
 * `npm i -g` 는 엉뚱한 곳을 건드리거나 아무 일도 안 한다. 그럴 때는 지금 어디서
 * 돌고 있는지 알려 주고 무엇을 하면 되는지만 말한다.
 *
 * **실패를 성공처럼 말하지 않는다.** 권한이 없어 못 쓰는 경우(EACCES)가 흔한데,
 * npm 의 출력은 길고 진짜 원인이 묻힌다. 그건 따로 짚어 준다.
 */

const PACKAGE = 'xgen-dex-cli';
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;

export interface UpdateCheck {
  current: string;
  latest: string;
  /** 최신보다 낮은가. 같거나 더 높으면(로컬 빌드) false. */
  outdated: boolean;
}

/** 레지스트리에서 최신 버전을 읽는다. 네트워크 실패는 그대로 던진다 — 조용히
 *  "최신입니다" 라고 말하면 사용자는 업데이트가 없는 줄 안다. */
export async function fetchLatest(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(REGISTRY, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`npm 레지스트리 응답 ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    const version = String(body.version ?? '').trim();
    if (!version) throw new Error('레지스트리 응답에 version 이 없습니다.');
    return version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * semver 비교. `a` 가 `b` 보다 낮으면 음수.
 *
 * prerelease(`1.4.0-rc.1`)는 숫자 부분만 본다 — CLI 는 정식 판만 배포하므로
 * 그 이상 따질 것이 없고, 지나친 규칙은 틀렸을 때 조용히 업데이트를 막는다.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .split('-', 1)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdate(
  current: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheck> {
  const latest = await fetchLatest(fetchImpl);
  return { current, latest, outdated: compareVersions(current, latest) < 0 };
}

/**
 * 이 실행 파일이 **전역 npm 설치**에서 왔나.
 *
 * `npm root -g` 아래에 있으면 그렇다. 저장소에서 직접 돌리거나(`node dist/cli.js`)
 * 프로젝트 로컬 설치라면 `npm i -g` 로 고칠 수 있는 것이 아니다 — 그 경우 명령을
 * 쏘는 대신 지금 어디서 돌고 있는지 말해 준다.
 */
export async function globalInstallRoot(
  run: typeof runCommand = runCommand,
): Promise<string | null> {
  const result = await run('npm', ['root', '-g']);
  if (result.code !== 0) return null;
  const root = result.stdout.trim();
  if (!root) return null;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const globalRoot = realpathSync(root);
    return self.startsWith(globalRoot + sep) ? globalRoot : null;
  } catch {
    return null;
  }
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 명령 하나를 돌리고 결과를 모은다. 출력을 흘려보낼지는 부르는 쪽이 정한다. */
export function runCommand(
  file: string,
  args: string[],
  options: { stream?: (chunk: string) => void } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      out += text;
      options.stream?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      err += text;
      options.stream?.(text);
    });
    child.on('error', (error) => resolvePromise({ code: -1, stdout: out, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

/** npm 출력에서 사람이 읽을 진짜 원인을 골라낸다. 전문은 길고 대부분 소음이다. */
export function explainNpmFailure(output: string): string {
  if (/\bEACCES\b|permission denied/i.test(output)) {
    return [
      '전역 설치 폴더에 쓸 권한이 없습니다.',
      '  sudo 로 다시 실행하거나, npm 전역 폴더를 홈 아래로 옮기세요:',
      '    npm config set prefix ~/.npm-global',
      '    export PATH="$HOME/.npm-global/bin:$PATH"',
    ].join('\n');
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(output)) {
    return 'npm 레지스트리에 연결하지 못했습니다. 네트워크나 프록시 설정을 확인하세요.';
  }
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^npm (error|ERR!)/.test(l))
    .map((l) => l.replace(/^npm (error|ERR!)\s*/, ''))
    .find((l) => l.length > 0);
  return line || '업데이트에 실패했습니다.';
}
