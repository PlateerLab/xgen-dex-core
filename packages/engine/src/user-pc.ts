/**
 * 사용자 PC 접속(UserPc)의 기기 쪽 — 서버가 보내는 내부 호출 `_UserPcRun`·`_UserPcJob` 을 이 기기의
 * 셸로 실행한다.
 *
 * 에이전트는 `UserPc` 도구 하나로 사용자 기기에 접속한다(서버 런타임 host.user_pc). 원격 셸로 대화에
 * 연결된 폴더에 들어간 것처럼 명령을 보내고, 결과(종료 코드·출력)를 받는다. 이 모듈은 모델에게 보이지
 * 않는 그 실행 통로다(`_` 로 시작하는 도구는 서버가 모델에게 숨긴다).
 *
 * 셸은 기기마다 bash 하나다 — 에이전트가 sandbox 에서 쓰던 셸 지식이 그대로 통하게.
 *
 *   macOS·Linux  bash(없으면 사용자 셸). 지금의 Shell 과 같은 가두기를 쓴다(macOS sandbox-exec,
 *                Linux bwrap 이 될 때) — 쓰기는 연결 폴더 안으로. 지원 probe 실패 시 실행하지 않는다.
 *   Windows      native OS 격리 backend가 없어 명시적 unavailable을 반환한다.
 *                Git Bash·내장 해석기로 host program을 대신 실행하지 않는다.
 *
 * 어떤 셸인지는 카탈로그 항목의 `meta`(shell·shell_note)로 서버에 알린다 — 서버가 턴 안내에 적는다.
 *
 * 수명: 명령이 `wait_ms` 안에 끝나면 결과를, 아니면 작업(job)으로 넘겨 job_id 를 돌려준다. 작업은
 * `max_runtime_ms` 를 넘기면 끊는다. 취소 신호(서버의 `mcp_cancel`·사용자 [정지])가 오면 프로세스 트리를
 * 끊는다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  USER_PC_JOB_TOOL,
  USER_PC_RUN_TOOL,
  USER_PC_DEFAULT_MAX_RUNTIME_MS,
  USER_PC_DEFAULT_WAIT_MS,
  USER_PC_MAX_RUNTIME_MS,
  USER_PC_MAX_WAIT_MS,
  clampMs,
  userPcToolSchemas as userPcSchemasFor,
  type UserPcOutcome,
} from '@dex/protocol/user-pc-shell';
import type { McpToolAnnotations } from './mcp-manager';
import { buildChildEnv, commonBinDirs } from './exec-resolve';
import {
  gitIdentityEnv,
  prepareWorkspaceShell,
  userToolchains,
  workspaceShellSupported,
  requireWorkspaceShellSupport,
} from './workspace-shell';

// 도구 이름·스키마·결과 모양은 휴대폰·브라우저와 같은 약속이다(@dex/protocol/user-pc-shell).
export {
  USER_PC_JOB_TOOL,
  USER_PC_RUN_TOOL,
  USER_PC_TOOL_NAMES,
  outcomeText,
  type UserPcOutcome,
} from '@dex/protocol/user-pc-shell';

const IS_WIN = process.platform === 'win32';

/** 스트림마다 앞쪽·뒤쪽에 남기는 글자 수. 긴 빌드 로그는 끝이 중요하고, 오류는 앞에 있을 때가 많다. */
const HEAD_CHARS = 40_000;
const TAIL_CHARS = 160_000;
/** 대화마다 동시에 도는 작업 상한. */
const MAX_RUNNING_JOBS = 25;
const MAX_KEPT_JOBS = 200;

// ── 셸 고르기 ────────────────────────────────────────────────────────

export interface UserPcShell {
  /** posix: 실제 bash/사용자 셸, git-bash: Windows Git Bash, builtin: 내장 bash 해석기. */
  kind: 'posix' | 'git-bash' | 'builtin';
  file?: string;
  /** 모델에게 보이는 셸 이름. */
  label: string;
  /** 모델에게 덧붙일 사실 한 줄(없으면 빈 문자열). */
  note: string;
}

/** Windows 에서 Git Bash 를 찾는다 — WSL 의 `System32\bash.exe` 는 다른 파일시스템이라 쓰지 않는다. */
export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const roots = [
    env.ProgramFiles && join(env.ProgramFiles, 'Git'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git'),
    env.ProgramW6432 && join(env.ProgramW6432, 'Git'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git'),
    'C:\\Program Files\\Git',
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);
  if (env.XGEN_GIT_BASH && exists(env.XGEN_GIT_BASH)) return env.XGEN_GIT_BASH;
  for (const root of roots) {
    const candidate = join(root, 'bin', 'bash.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

let shellCache: UserPcShell | null = null;

/** 이 기기의 셸 — 프로세스마다 한 번 정한다(설치가 바뀌면 앱을 다시 켜면 된다). */
export function detectUserPcShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): UserPcShell {
  if (platform === 'win32') {
    const gitBash = findGitBash(env, exists);
    if (gitBash) {
      return {
        kind: 'git-bash',
        file: gitBash,
        label: 'Git Bash',
        note: 'Native command execution is unavailable: an OS filesystem confinement backend is required; Git Bash is not a confinement backend. Use the scoped file tools.',
      };
    }
    return {
      kind: 'builtin',
      label: 'bash (built in: file and text commands)',
      note: 'Native command execution is unavailable: an OS filesystem confinement backend is required; the builtin interpreter cannot replace it. Use the scoped file tools.',
    };
  }
  const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find((p) => exists(p));
  const file = bash ?? env.SHELL ?? '/bin/sh';
  const confinedMac = platform === 'darwin' && exists('/usr/bin/sandbox-exec');
  return {
    kind: 'posix',
    file,
    label: basename(file),
    note: confinedMac
      ? 'commands can write only inside the connected folders after the OS confinement probe succeeds'
      : 'commands require a successful OS filesystem confinement probe; unavailable otherwise',
  };
}

export function userPcShell(): UserPcShell {
  if (!shellCache) shellCache = detectUserPcShell();
  return shellCache;
}

/** Tests only — force the shell (`null` re-detects). */
export function setUserPcShellForTest(shell: UserPcShell | null): void {
  shellCache = shell;
}

/** 사용자 PC 셸 실행 · 작업 제어는 기기의 Shell · ShellJob 과 같은 성격이다: 읽기 전용이 아니고 바깥과 닿는다. */
const USER_PC_ANNOTATIONS: Record<string, McpToolAnnotations> = {
  [USER_PC_RUN_TOOL]: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  [USER_PC_JOB_TOOL]: { readOnlyHint: false, openWorldHint: true },
};

export function userPcToolSchemas(shell: UserPcShell = userPcShell()) {
  return userPcSchemasFor(shell).map((t) => ({ ...t, annotations: USER_PC_ANNOTATIONS[t.name] }));
}

// ── 출력 ───────────────────────────────────────────────────────────

/** 앞쪽과 뒤쪽을 남기는 출력 버퍼. 바이트 경계에서 글자가 깨지지 않게 디코더를 거친다. */
class Capture {
  private head = '';
  private tail = '';
  private dropped = 0;
  private decoder = new StringDecoder('utf8');

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.add(text);
  }

  end(): void {
    this.add(this.decoder.end());
  }

  private add(text: string): void {
    if (!text) return;
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
      if (!text) return;
    }
    this.tail += text;
    if (this.tail.length > TAIL_CHARS) {
      this.dropped += this.tail.length - TAIL_CHARS;
      this.tail = this.tail.slice(-TAIL_CHARS);
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n... (${this.dropped} characters omitted) ...\n${this.tail}`;
  }
}

// ── 작업 ───────────────────────────────────────────────────────────

type JobState = 'running' | 'exited' | 'killed' | 'error';

interface Job {
  id: string;
  key: string;
  roots: string[];
  cwd: string;
  shell: string;
  out: Capture;
  err: Capture;
  state: JobState;
  code: number | null;
  startedAt: number;
  endedAt?: number;
  stop: () => void;
  done: Promise<void>;
}

const jobs = new Map<string, Job>();
let jobSeq = 0;

function newJobId(): string {
  jobSeq += 1;
  return `pc-${Date.now().toString(36)}-${jobSeq}`;
}

function evictFinished(): void {
  if (jobs.size <= MAX_KEPT_JOBS) return;
  const finished = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt - b.startedAt);
  for (const job of finished) {
    if (jobs.size <= MAX_KEPT_JOBS) break;
    jobs.delete(job.id);
  }
}

function outcome(job: Job): UserPcOutcome {
  const running = job.state === 'running';
  return {
    exit_code: running ? null : job.code,
    stdout: job.out.text(),
    stderr: job.err.text() + (job.state === 'killed' && !running ? (job.err.text() ? '\n' : '') + '(stopped)' : ''),
    running,
    job_id: running ? job.id : null,
    cwd: job.cwd,
    shell: job.shell,
    truncated: job.out.truncated || job.err.truncated,
  };
}

/** 대화의 폴더 목록이 바뀌었다 — 빠진 폴더에서 돌던 작업을 멈춘다. 멈춘 수를 돌려준다. */
export function stopUserPcJobsOutside(key: string, roots: string[]): number {
  const kept = new Set(roots);
  let stopped = 0;
  for (const job of jobs.values()) {
    if (job.key !== key || job.state !== 'running') continue;
    if (job.roots.every((root) => kept.has(root))) continue;
    job.stop();
    stopped += 1;
  }
  return stopped;
}

/** 앱을 닫는다 — 돌던 작업을 모두 끝낸다. */
export function stopAllUserPcJobs(): number {
  let stopped = 0;
  for (const job of jobs.values()) {
    if (job.state !== 'running') continue;
    job.stop();
    stopped += 1;
  }
  return stopped;
}

// ── 실행 ───────────────────────────────────────────────────────────

export interface UserPcRunRequest {
  command: string;
  /** 실제 경로 — 호출부가 연결 폴더 안인지 이미 확인했다. */
  cwd: string;
  /** 이 대화의 연결 폴더(실제 경로). */
  roots: string[];
  /** 연결 폴더 이름(roots 와 같은 순서) — 내장 해석기가 `/<이름>` 으로 붙인다. */
  names: string[];
  /** 대화 id — 작업은 대화마다 보인다. */
  key: string;
  waitMs?: number;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
}

function killTree(child: ChildProcess, group: boolean): void {
  try {
    if (IS_WIN) {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    } else if (group && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

interface Launch {
  file: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

async function posixLaunch(shell: UserPcShell, command: string, cwd: string, roots: string[]): Promise<Launch> {
  const file = shell.file ?? '/bin/sh';
  const args = ['-c', command];
  if (await workspaceShellSupported()) {
    const toolchains = await userToolchains();
    const pathStr = [...toolchains.bins, process.env.PATH || '', ...commonBinDirs()].filter(Boolean).join(delimiter);
    const env = { ...buildChildEnv(pathStr), ...toolchains.env, ...(await gitIdentityEnv()) };
    const real = (await Promise.all(roots.map((r) => realpath(r).catch(() => null)))).filter(
      (r): r is string => r !== null,
    );
    return prepareWorkspaceShell(file, args, env, cwd, real, toolchains.mounts);
  }
  throw new Error('[WORKSPACE_SHELL_UNAVAILABLE] OS filesystem confinement is unavailable; the command was not started.');
}

/** OS-confined process runner; no native host fallback. */
async function startProcessJob(shell: UserPcShell, req: UserPcRunRequest, maxRuntimeMs: number): Promise<Job> {
  const launch = await posixLaunch(shell, req.command, req.cwd, req.roots);
  const group = !IS_WIN;
  const job: Job = {
    id: newJobId(),
    key: req.key,
    roots: [...req.roots],
    cwd: req.cwd,
    shell: shell.label,
    out: new Capture(),
    err: new Capture(),
    state: 'running',
    code: null,
    startedAt: Date.now(),
    stop: () => {},
    done: Promise.resolve(),
  };
  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      cwd: req.cwd,
      env: launch.env,
      windowsHide: true,
      detached: group,
      // stdin 은 닫는다 — 입력을 기다리는 프로그램은 바로 끝나고, 시한까지 매달리지 않는다.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    void launch.cleanup();
    job.state = 'error';
    job.err.push(`could not start the shell: ${(e as Error).message}`);
    job.endedAt = Date.now();
    return job;
  }
  let runtimeTimer: NodeJS.Timeout | null = null;
  job.stop = () => {
    if (job.state !== 'running') return;
    job.state = 'killed';
    job.endedAt = Date.now();
    killTree(child, group);
  };
  job.done = new Promise<void>((resolve) => {
    child.stdout?.on('data', (d: Buffer) => job.out.push(d));
    child.stderr?.on('data', (d: Buffer) => job.err.push(d));
    child.on('error', (e) => {
      job.err.push(`\n${e.message}`);
      if (job.state === 'running') job.state = 'error';
      job.endedAt ??= Date.now();
    });
    child.on('close', (code, signal) => {
      if (runtimeTimer) clearTimeout(runtimeTimer);
      job.out.end();
      job.err.end();
      job.code = code ?? (signal ? 137 : null);
      if (job.state === 'running') job.state = 'exited';
      job.endedAt ??= Date.now();
      // 임시 폴더는 사용자 폴더 밖에 있다 — 결과가 지우기를 기다리지 않는다.
      void launch.cleanup();
      resolve();
    });
  });
  runtimeTimer = setTimeout(() => {
    if (job.state !== 'running') return;
    job.err.push(`\nmaximum runtime ${Math.round(maxRuntimeMs / 1000)}s exceeded; stopped`);
    job.stop();
  }, maxRuntimeMs);
  // 앱을 닫을 때 파이프가 이벤트 루프를 붙잡지 않게.
  child.unref();
  (child.stdout as unknown as { unref?: () => void })?.unref?.();
  (child.stderr as unknown as { unref?: () => void })?.unref?.();
  return job;
}

function waitFor(job: Job, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (job.state !== 'running') return resolve();
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal?.addEventListener('abort', onAbort, { once: true });
    void job.done.then(finish);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

/** 명령 하나를 실행한다 — `waitMs` 안에 끝나면 결과, 아니면 작업으로 넘긴다. */
export async function runUserPcCommand(req: UserPcRunRequest, shell: UserPcShell = userPcShell()): Promise<UserPcOutcome> {
  // The builtin interpreter can delegate to native programs, and Git Bash is a
  // host process. Neither is an OS confinement backend for Windows.
  if (shell.kind !== 'posix') {
    throw new Error('[WORKSPACE_SHELL_UNAVAILABLE] OS filesystem confinement is unavailable; the command was not started.');
  }
  await requireWorkspaceShellSupport();
  const running = [...jobs.values()].filter((j) => j.key === req.key && j.state === 'running').length;
  if (running >= MAX_RUNNING_JOBS) {
    throw new Error(`${running} commands are still running in this conversation; stop some with job stop first.`);
  }
  const waitMs = clampMs(req.waitMs, USER_PC_DEFAULT_WAIT_MS, 1_000, USER_PC_MAX_WAIT_MS);
  const maxRuntimeMs = clampMs(req.maxRuntimeMs, USER_PC_DEFAULT_MAX_RUNTIME_MS, waitMs, USER_PC_MAX_RUNTIME_MS);
  if (req.signal?.aborted) throw new Error('cancelled');
  const job = await startProcessJob(shell, req, maxRuntimeMs);
  jobs.set(job.id, job);
  evictFinished();
  const onAbort = () => job.stop();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await waitFor(job, waitMs, req.signal);
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
  }
  if (job.state !== 'running') {
    await job.done;
    jobs.delete(job.id);
  }
  return outcome(job);
}

/** 작업을 확인하거나 멈춘다. */
export async function userPcJob(
  jobId: string,
  key: string,
  action: 'poll' | 'stop',
  waitMs?: number,
  signal?: AbortSignal,
): Promise<UserPcOutcome> {
  const job = jobs.get(String(jobId || '').trim());
  if (!job || job.key !== key) throw new Error(`No job ${jobId} in this conversation.`);
  if (action === 'stop') {
    job.stop();
    await Promise.race([job.done, new Promise((r) => setTimeout(r, 3_000))]);
  } else {
    await waitFor(job, clampMs(waitMs, 10_000, 0, 120_000), signal);
    if (job.state !== 'running') await job.done;
  }
  return outcome(job);
}

/** 연결 폴더 안의 상대 경로 → 실제 경로(경계 확인은 호출부가 한다). */
export function joinInside(root: string, rel: string): string {
  if (!rel) return root;
  return isAbsolute(rel) ? rel : join(root, rel);
}

/** 실제 경로가 폴더 안인가(정규화된 문자열 비교). */
export function isInside(path: string, root: string): boolean {
  const r = relative(root, path);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r) && !r.startsWith(`..${sep}`));
}
