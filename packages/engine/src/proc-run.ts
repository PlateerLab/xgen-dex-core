/**
 * 짧게 끝나는 자식 프로세스 하나를 돌린다 — 런타임 시험 실행(`node -v`) · 카탈로그
 * 설치 직후의 setup 단계(`npx -y playwright install chromium`) 같은 것.
 *
 * 셸을 거치지 않는다(argv 그대로). 예외는 Windows 의 `.cmd`/`.bat` — Node 는 이것을
 * 셸 없이 띄울 수 없으므로 `cmd.exe /d /s /c` 로 넘기되, 인자마다 따옴표와 셸 메타문자를
 * 이스케이프한다(cross-spawn 과 같은 규칙). 변수 값이 `& calc` 여도 명령이 되지 않는다.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

export interface RunProcessOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 출력 줄이 들어올 때마다(출력 꼬리 전체). */
  onOutput?: (tail: string) => void;
  /** 모아 둘 출력 상한(앞부분부터 버린다). */
  maxOutputChars?: number;
}

export interface RunProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCommand(command: string): string {
  return command.replace(META, '^$1');
}

/** cross-spawn 의 escapeArgument(doubleEscape) 와 같은 규칙. */
export function escapeCmdArgument(arg: string, doubleEscape = true): string {
  let out = `${arg}`;
  out = out.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  out = out.replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(META, '^$1');
  if (doubleEscape) out = out.replace(META, '^$1');
  return out;
}

export function runProcess(
  file: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const maxChars = opts.maxOutputChars ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true });
      return;
    }
    const isWinScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
    const child = isWinScript
      ? spawn(
          process.env.ComSpec || 'cmd.exe',
          [
            '/d',
            '/s',
            '/c',
            `"${[escapeCommand(file), ...args.map((a) => escapeCmdArgument(a))].join(' ')}"`,
          ],
          {
            env: opts.env,
            cwd: opts.cwd ?? homedir(),
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        )
      : spawn(file, args, { env: opts.env, cwd: opts.cwd ?? homedir(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const take = (which: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (which === 'out') stdout = (stdout + text).slice(-maxChars);
      else stderr = (stderr + text).slice(-maxChars);
      opts.onOutput?.((stdout + stderr).slice(-8192));
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout, stderr, timedOut, aborted });
    });
  });
}
