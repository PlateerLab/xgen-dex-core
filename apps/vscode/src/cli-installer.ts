import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

/**
 * `dex` 를 찾고, 없으면 깔아 준다.
 *
 * 확장은 대화를 직접 하지 않는다 — CLI 엔진을 자식 프로세스로 띄워 쓴다. 그래서
 * CLI 가 없으면 아무것도 안 되는데, 예전에는 `spawn dex ENOENT` 라는 말만 나왔다.
 * 무엇을 하라는 말이 없으니 막힌다.
 *
 * 찾는 일도 그냥 PATH 만 보면 안 된다. **VS Code 의 PATH 는 사용자의 셸 PATH 와
 * 다르다** — 특히 macOS 와 리눅스에서, 로그인 셸이 `.zshrc` 에서 붙인 npm 전역
 * bin 은 GUI 로 띄운 VS Code 에 없다. 그래서 멀쩡히 깔린 `dex` 를 못 찾는 일이
 * 실제로 흔하다. npm 이 말하는 전역 폴더를 직접 물어봐서 절대 경로로 쓴다.
 */

export const CLI_PACKAGE = 'xgen-dex-cli';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: string[]) => Promise<CommandResult>;

export function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', (error) => resolvePromise({ code: -1, stdout: out, stderr: String(error) }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout: out, stderr: err }));
  });
}

export interface LocateOptions {
  run?: RunCommand;
  exists?: (candidate: string) => boolean;
  platform?: NodeJS.Platform;
}

/**
 * npm 전역 폴더 안에서 실행 파일이 있을 만한 자리들.
 *
 * 유닉스는 `<prefix>/bin/dex`, 윈도우는 `<prefix>\dex.cmd` 다. 둘을 한 규칙으로
 * 묶으려다 한쪽을 놓치느니 그냥 둘 다 본다.
 */
export function globalBinCandidates(prefix: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [path.join(prefix, 'dex.cmd'), path.join(prefix, 'dex.exe'), path.join(prefix, 'dex')];
  }
  return [path.join(prefix, 'bin', 'dex'), path.join(prefix, 'dex')];
}

export interface CliLocation {
  command: string;
  /** 어디서 찾았는지. 사용자에게 무엇을 고치면 되는지 말해 줄 때 쓴다. */
  source: 'setting' | 'path' | 'npm-global';
}

/**
 * `dex` 를 찾는다. 못 찾으면 `undefined`.
 *
 * 순서에 뜻이 있다. 사용자가 직접 지정한 경로가 가장 세고, 그다음이 PATH(자기가
 * 관리하는 설치본), 마지막이 npm 이 말하는 전역 폴더 — PATH 에 없더라도 깔려는
 * 있는 경우다.
 */
export async function locateCli(
  configuredPath: string,
  options: LocateOptions = {},
): Promise<CliLocation | undefined> {
  const run = options.run ?? runCommand;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;

  const configured = configuredPath.trim();
  if (configured && configured !== 'dex') return { command: configured, source: 'setting' };

  const which = platform === 'win32' ? 'where' : 'which';
  const found = await run(which, ['dex']);
  const first = found.stdout.split('\n').map((line) => line.trim()).find(Boolean);
  if (found.code === 0 && first) return { command: first, source: 'path' };

  const prefix = await run('npm', ['prefix', '-g']);
  const root = prefix.stdout.trim();
  if (prefix.code === 0 && root) {
    for (const candidate of globalBinCandidates(root, platform)) {
      if (exists(candidate)) return { command: candidate, source: 'npm-global' };
    }
  }
  return undefined;
}

/** npm 출력에서 사람이 읽을 진짜 원인을 골라낸다. 전문은 길고 대부분 소음이다. */
export function explainNpmFailure(output: string): string {
  if (/\bEACCES\b|permission denied/i.test(output)) {
    return [
      'npm 전역 폴더에 쓸 권한이 없습니다.',
      'npm 전역 폴더를 홈 아래로 옮기면 관리자 권한 없이 설치할 수 있습니다:',
      '  npm config set prefix ~/.npm-global',
      '  export PATH="$HOME/.npm-global/bin:$PATH"',
    ].join('\n');
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network/i.test(output)) {
    return 'npm 레지스트리에 연결하지 못했습니다. 네트워크나 프록시 설정을 확인하세요.';
  }
  if (/\bENOENT\b.*\bnpm\b|spawn npm/i.test(output)) {
    return 'npm 을 찾지 못했습니다. Node.js 20 이상을 설치한 뒤 VS Code 를 다시 시작하세요.';
  }
  const line = output
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => /^npm (error|ERR!)/.test(text))
    .map((text) => text.replace(/^npm (error|ERR!)\s*/, ''))
    .find((text) => text.length > 0);
  return line || '설치에 실패했습니다.';
}

export type InstallOutcome =
  | { ok: true; location: CliLocation }
  | { ok: false; reason: string; output: string };

/**
 * CLI 를 전역으로 깐다.
 *
 * 확장과 **같은 버전**을 콕 집는다. 둘은 한 태그에서 함께 검증된 조합이라, 아무
 * 최신이나 끌어오면 확장이 모르는 엔진과 말하게 된다.
 */
export async function installCli(
  version: string,
  options: LocateOptions & { log?: (line: string) => void } = {},
): Promise<InstallOutcome> {
  const run = options.run ?? runCommand;
  const target = `${CLI_PACKAGE}@${version}`;
  options.log?.(`npm i -g ${target}`);
  const result = await run('npm', ['i', '-g', target]);
  const output = `${result.stdout}\n${result.stderr}`;
  options.log?.(output.trim());

  if (result.code !== 0) {
    return { ok: false, reason: explainNpmFailure(output), output };
  }
  // 깔았다고 끝이 아니다. VS Code 의 PATH 에는 없을 수 있으므로 다시 찾아 절대
  // 경로를 쥔다 — 그러지 않으면 방금 깐 것을 또 못 찾는다.
  const located = await locateCli('', options);
  if (!located) {
    return {
      ok: false,
      reason: '설치는 끝났지만 실행 파일을 찾지 못했습니다. VS Code 를 다시 시작해 보세요.',
      output,
    };
  }
  return { ok: true, location: located };
}
