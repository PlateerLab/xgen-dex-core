/**
 * CLI 로그인·상태·로그아웃 — XD 전용 홈에서, 파이프로(PTY 없이).
 *
 * 2026-10-02 실측(claude 2.1.285 · codex 0.160.0, 빈 홈):
 * - `claude auth login --claudeai` 는 파이프로도 로그인 주소를 내고 `Paste code here if prompted >` 에서 stdin 으로
 *   코드를 받는다. 자격은 CLAUDE_CONFIG_DIR(맥은 키체인)에 들고, 상태는 `claude auth status --json`.
 * - `codex login --device-auth` 는 주소(https://auth.openai.com/codex/device)와 일회용 코드(ABCD-12345)를 내고,
 *   사용자가 브라우저에서 마치면 스스로 끝난다. 상태는 `codex login status`(로그인 안 됐어도 종료 코드 0 — 글을 읽는다).
 *
 * XGEN 서버가 겪은 것(xgen-workflow claude_code_service): 출력에는 ANSI·상자 글자가 섞이므로 줄마다 주소를 찾는다
 * (한 덩어리로 공백을 지우면 프롬프트가 주소 끝에 붙는다). 코드와 Enter 를 한꺼번에 쓰면 일부 판이 붙여넣기로 보고
 * Enter 를 버린다 — 코드를 쓰고 잠시 뒤 Enter.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { CliName } from './detect';

/** CLI 가 늘 받는 환경 — 자동 업데이트·비필수 트래픽 끄기(런타임 CLI_QUIET_ENV 와 같은 뜻). */
export const CLI_QUIET_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CODEX_DISABLE_UPDATE_CHECK: '1',
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-B0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const URL_RE = /https?:\/\/[^\s"')\]<>`]+/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
/** 잘못된 코드·인증 실패 — 그대로 두면 CLI 가 "Enter 를 눌러 다시" 에서 끝없이 기다린다. */
const CLAUDE_FAILURES = ['oautherror', 'invalidcode', 'fullcodewascopied', 'authenticationfailed'];

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** 줄마다 첫 주소. 상자 글자(│ 등)는 지우되 공백은 지우지 않는다(프롬프트가 주소에 붙지 않게). */
export function findUrl(text: string): string | null {
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.replace(/[│┃║|╭╮╰╯─━]/g, ' ');
    const m = URL_RE.exec(line);
    if (m) return m[0];
  }
  return null;
}

export function findDeviceCode(text: string): string | null {
  return CODE_RE.exec(stripAnsi(text))?.[0] ?? null;
}

/** 붙여 넣은 코드 정리 — 공백·프롬프트 꼬리 제거. */
export function cleanCode(code: string): string {
  let c = code.replace(/\s+/g, '');
  const cut = c.toLowerCase().indexOf('pastecodehere');
  if (cut >= 0) c = c.slice(0, cut);
  return c.split(/[<>]/)[0];
}

export type LoginEvent =
  | { type: 'url'; url: string }
  | { type: 'code'; code: string }
  | { type: 'needs_code' }
  | { type: 'done'; ok: true }
  | { type: 'done'; ok: false; error: string };

export interface LoginSession {
  /** Claude: 브라우저가 보여 준 코드를 넣는다. */
  submit(code: string): void;
  cancel(): void;
  readonly finished: Promise<LoginEvent & { type: 'done' }>;
}

export interface CliEnv {
  binary: string;
  home: string;
  /** 기본 process.env. 시험이 바꾼다. */
  baseEnv?: NodeJS.ProcessEnv;
}

export function cliEnv(name: CliName, opts: CliEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env), ...CLI_QUIET_ENV };
  // 구독 로그인에 키·단순 모드를 섞지 않는다(2026-09-09 XGEN 사고: CLAUDE_CODE_SIMPLE 은 OAuth 를 읽지 않는다).
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.CLAUDE_CODE_SIMPLE;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (name === 'claude') env.CLAUDE_CONFIG_DIR = opts.home;
  else env.CODEX_HOME = opts.home;
  return env;
}

const isCmd = (p: string) => /\.(cmd|bat)$/i.test(p);

/** 로그인을 시작한다. 사건은 `onEvent` 로, 끝은 `finished`. */
export function startLogin(
  name: CliName,
  opts: CliEnv & { timeoutMs?: number; enterDelayMs?: number },
  onEvent: (event: LoginEvent) => void,
): LoginSession {
  mkdirSync(opts.home, { recursive: true });
  const argv = name === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth'];
  const child: ChildProcessWithoutNullStreams = spawn(opts.binary, argv, {
    env: cliEnv(name, opts),
    windowsHide: true,
    shell: isCmd(opts.binary),
  });
  let output = '';
  let urlSent = false;
  let codeSent = false;
  let settled = false;
  let resolveDone!: (e: LoginEvent & { type: 'done' }) => void;
  const finished = new Promise<LoginEvent & { type: 'done' }>((r) => (resolveDone = r));

  const finish = (event: LoginEvent & { type: 'done' }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onEvent(event);
    resolveDone(event);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish({ type: 'done', ok: false, error: 'timeout' });
  }, opts.timeoutMs ?? 15 * 60_000);

  const onData = (chunk: Buffer) => {
    output += chunk.toString('utf8');
    if (!urlSent) {
      const url = findUrl(output);
      if (url) {
        urlSent = true;
        onEvent({ type: 'url', url });
        if (name === 'claude') onEvent({ type: 'needs_code' });
      }
    }
    if (name === 'codex' && !codeSent) {
      const code = findDeviceCode(output);
      if (code) {
        codeSent = true;
        onEvent({ type: 'code', code });
      }
    }
    if (name === 'claude') {
      const flat = stripAnsi(output).toLowerCase().replace(/\s+/g, '');
      if (CLAUDE_FAILURES.some((m) => flat.includes(m))) {
        child.kill();
        finish({ type: 'done', ok: false, error: 'invalid_code' });
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => finish({ type: 'done', ok: false, error: err.message }));
  child.on('close', async (code) => {
    if (settled) return;
    if (code !== 0) {
      finish({ type: 'done', ok: false, error: `exit ${code}` });
      return;
    }
    // 끝났다고 다 된 것이 아니다 — 그 홈에서 실제로 로그인됐는지 CLI 에게 다시 묻는다.
    const status = await cliStatus(name, opts).catch(() => null);
    if (status?.loggedIn) finish({ type: 'done', ok: true });
    else finish({ type: 'done', ok: false, error: 'not_logged_in' });
  });

  return {
    finished,
    submit(code: string) {
      if (settled || name !== 'claude') return;
      child.stdin.write(cleanCode(code));
      setTimeout(() => {
        if (!settled) child.stdin.write('\n');
      }, opts.enterDelayMs ?? 400);
    },
    cancel() {
      if (settled) return;
      child.kill();
      finish({ type: 'done', ok: false, error: 'cancelled' });
    },
  };
}

export interface CliStatus {
  loggedIn: boolean;
  /** claude: claude.ai·console 등, codex: chatgpt·api_key */
  method: string | null;
  email: string | null;
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(binary, args, { env, timeout: timeoutMs, windowsHide: true, shell: isCmd(binary) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

/** 이 홈의 로그인 상태 — 그 CLI 에게 묻는다. */
export async function cliStatus(name: CliName, opts: CliEnv): Promise<CliStatus> {
  const env = cliEnv(name, opts);
  if (name === 'claude') {
    const { out } = await run(opts.binary, ['auth', 'status', '--json'], env);
    const start = out.indexOf('{');
    try {
      const parsed = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) as Record<string, unknown>;
      return {
        loggedIn: parsed.loggedIn === true,
        method: typeof parsed.authMethod === 'string' && parsed.authMethod !== 'none' ? parsed.authMethod : null,
        email: typeof parsed.email === 'string' ? parsed.email : null,
      };
    } catch {
      return { loggedIn: false, method: null, email: null };
    }
  }
  const { out } = await run(opts.binary, ['login', 'status'], env);
  const text = stripAnsi(out).toLowerCase();
  if (text.includes('not logged in') || !text.includes('logged in')) return { loggedIn: false, method: null, email: null };
  return { loggedIn: true, method: text.includes('api key') ? 'api_key' : 'chatgpt', email: null };
}

export async function cliLogout(name: CliName, opts: CliEnv): Promise<void> {
  await run(opts.binary, name === 'claude' ? ['auth', 'logout'] : ['logout'], cliEnv(name, opts));
}
