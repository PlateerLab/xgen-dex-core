/**
 * 사용자 PC 접속(UserPc)의 기기 쪽 약속 — 서버가 보내는 내부 호출 `_UserPcRun`·`_UserPcJob` 의 이름·스키마·
 * 결과 모양, 그리고 프로세스를 띄울 수 없는 기기(휴대폰·웹 브라우저)의 내장 셸.
 *
 * 에이전트는 `UserPc` 도구 하나로 사용자 기기에 접속한다(서버 런타임 host.user_pc). 원격 셸로 대화에
 * 연결된 폴더에 들어간 것처럼 명령을 보내고 결과(종료 코드·출력)를 받는다. `_` 로 시작하는 도구는 서버가
 * 모델에게 숨긴다 — 그 실행 통로다. 데스크톱(엔진)은 실제 bash 를 띄우고, 휴대폰·브라우저는 여기의
 * {@link FolderShell} 이 bash 해석기(just-bash)로 명령을 해석한다. 연결 폴더는 `/<폴더 이름>` 으로 붙고,
 * 파일·글 명령(ls·find·grep·sed·awk·jq·…)이 돈다.
 *
 * just-bash 는 이 패키지의 의존이 아니다(의존 0) — 쓰는 쪽이 `just-bash/browser` 모듈을 넘긴다.
 * 폴더는 기기마다 다른 API(안드로이드 문서 제공자, iOS 파일, 브라우저 File System Access)라
 * {@link ShellFolderOps} 로 받는다.
 */

export const USER_PC_RUN_TOOL = '_UserPcRun';
export const USER_PC_JOB_TOOL = '_UserPcJob';
export const USER_PC_TOOL_NAMES: ReadonlySet<string> = new Set([USER_PC_RUN_TOOL, USER_PC_JOB_TOOL]);

/** 기본으로 기다리는 시간과 상한(ms). 서버가 보낸 값을 이 안으로 자른다. */
export const USER_PC_DEFAULT_WAIT_MS = 60_000;
export const USER_PC_MAX_WAIT_MS = 600_000;
export const USER_PC_DEFAULT_MAX_RUNTIME_MS = 60 * 60_000;
export const USER_PC_MAX_RUNTIME_MS = 6 * 60 * 60_000;

/** 이 기기의 셸 — 모델에게 보이는 이름과 덧붙일 사실 한 줄. 서버가 턴 안내에 적는다. */
export interface UserPcShellInfo {
  label: string;
  note: string;
}

/** 결과 — 서버가 structuredContent 로 읽는다. */
export interface UserPcOutcome {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  running: boolean;
  job_id: string | null;
  cwd: string;
  shell: string;
  truncated: boolean;
}

/** 카탈로그 항목 — 실행 도구의 `meta` 로 셸을 서버에 알린다. */
export function userPcToolSchemas(shell: UserPcShellInfo) {
  return [
    {
      name: USER_PC_RUN_TOOL,
      description:
        'Internal: run one command line in a folder connected to this conversation (UserPc run). ' +
        'Not for direct use by the model.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          wait_ms: { type: 'integer' },
          max_runtime_ms: { type: 'integer' },
        },
        required: ['command'],
      },
      meta: { shell: shell.label, shell_note: shell.note },
    },
    {
      name: USER_PC_JOB_TOOL,
      description: 'Internal: check or stop a UserPc job.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          action: { type: 'string', enum: ['poll', 'stop'] },
          wait_ms: { type: 'integer' },
        },
        required: ['job_id'],
      },
    },
  ];
}

/** 사람이 읽는 한 덩어리(서버가 structuredContent 를 못 읽는 옛 경로를 위해서도). */
export function outcomeText(o: UserPcOutcome): string {
  const head = o.running ? `still running as job ${o.job_id}` : `exit ${o.exit_code ?? 0}`;
  const parts = [`[${o.shell}] ${head}`];
  if (o.stdout) parts.push(o.stdout);
  if (o.stderr) parts.push(`STDERR:\n${o.stderr}`);
  return parts.join('\n');
}

export function clampMs(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 붙일 이름 — 겹치면 번호를 붙인다. 슬래시·역슬래시는 이름에 쓸 수 없다. */
export function uniqueMountNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = String(raw || '').replace(/[\\/]/g, '_').trim() || `folder${i + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base} (${n++})`;
    used.add(name);
    return name;
  });
}

// ── 폴더 → 해석기의 파일시스템 ─────────────────────────────────────────

export interface ShellFolderEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** 수정 시각(ms). 모르면 없다. */
  modified?: number;
}

/**
 * 연결 폴더 하나의 파일 조작 — 경로는 폴더 기준 상대 경로('' 는 폴더 자신, 'a/b.txt').
 * 기기가 못 하는 조작은 비워 둔다(해석기가 그 명령에 "지원하지 않음" 으로 답한다).
 */
export interface ShellFolderOps {
  list(rel: string): Promise<ShellFolderEntry[]>;
  stat(rel: string): Promise<{ exists: boolean; isDir: boolean; size: number; modified?: number }>;
  /** 파일 내용. 바이트를 줄 수 없는 기기는 글(UTF-8)로 준다. */
  read(rel: string): Promise<Uint8Array | string>;
  /** 쓰기(부모 폴더는 만든다). 바이트를 받을 수 없는 기기는 글로 바꿔 쓴다. */
  write(rel: string, data: Uint8Array | string, append: boolean): Promise<void>;
  /** 파일이나 폴더(안의 것까지)를 지운다. */
  remove(rel: string): Promise<void>;
  mkdir?(rel: string): Promise<void>;
  /** 바이트를 그대로 옮기는 복사(같은 폴더 안). 없으면 읽어서 쓴다. */
  copy?(from: string, to: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
}

type FsStat = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
};

type FileContent = string | Uint8Array;
type Encoding = string | { encoding?: string | null } | undefined;

function fsError(code: string, text: string, op: string, path: string): Error {
  const error = new Error(`${code}: ${text}, ${op} '${path}'`) as Error & { code?: string };
  error.code = code;
  return error;
}

function encodingOf(options: Encoding): string {
  const value = typeof options === 'string' ? options : options?.encoding;
  return (value || 'utf8').toLowerCase();
}

const utf8Encoder = new TextEncoder();

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function latin1Text(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 해석기가 넘긴 내용 → 기기에 쓸 것. 'binary'/'latin1' 글은 한 글자가 한 바이트다. */
function contentBytes(content: FileContent, options: Encoding): Uint8Array | string {
  if (typeof content !== 'string') return content;
  const encoding = encodingOf(options);
  return encoding === 'binary' || encoding === 'latin1' ? latin1Bytes(content) : content;
}

function asBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8Encoder.encode(data) : data;
}

function posixNormalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * {@link ShellFolderOps} 를 just-bash 의 파일시스템(IFileSystem)으로 — MountableFs 가 `/<폴더 이름>` 아래에
 * 붙인다. 링크·권한은 없는 파일시스템이다(chmod·utimes 는 아무것도 하지 않고, 링크는 지원하지 않는다).
 *
 * 한 번 실행하는 동안 목록에서 본 크기·종류를 기억해 둔다 — 휴대폰의 문서 제공자는 파일마다 묻는 일이
 * 느리다(`find`·`ls -l` 이 파일마다 stat 을 부른다). 쓰기·지우기가 있으면 잊는다.
 */
export class FolderOpsFs {
  private seen = new Map<string, ShellFolderEntry & { exists: boolean }>();

  constructor(private readonly ops: ShellFolderOps) {}

  private rel(path: string): string {
    return posixNormalize(path).slice(1);
  }

  private forget(): void {
    this.seen.clear();
  }

  private async info(path: string): Promise<{ exists: boolean; isDir: boolean; size: number; modified?: number }> {
    const rel = this.rel(path);
    if (!rel) return { exists: true, isDir: true, size: 0 };
    const known = this.seen.get(rel);
    if (known) return known;
    const stat = await this.ops.stat(rel);
    this.seen.set(rel, { name: rel.split('/').pop() ?? rel, ...stat });
    return stat;
  }

  private toStat(info: { isDir: boolean; size: number; modified?: number }): FsStat {
    return {
      isFile: !info.isDir,
      isDirectory: info.isDir,
      isSymbolicLink: false,
      mode: info.isDir ? 0o755 : 0o644,
      size: info.size,
      mtime: new Date(info.modified ?? 0),
    };
  }

  private async entries(path: string): Promise<ShellFolderEntry[]> {
    const info = await this.info(path);
    if (!info.exists) throw fsError('ENOENT', 'no such file or directory', 'scandir', path);
    if (!info.isDir) throw fsError('ENOTDIR', 'not a directory', 'scandir', path);
    const rel = this.rel(path);
    const list = await this.ops.list(rel);
    for (const entry of list) {
      this.seen.set(rel ? `${rel}/${entry.name}` : entry.name, { ...entry, exists: true });
    }
    return [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  private async bytes(path: string): Promise<Uint8Array | string> {
    const info = await this.info(path);
    if (!info.exists) throw fsError('ENOENT', 'no such file or directory', 'open', path);
    if (info.isDir) throw fsError('EISDIR', 'illegal operation on a directory', 'read', path);
    return this.ops.read(this.rel(path));
  }

  async readFile(path: string, options?: Encoding): Promise<string> {
    const data = await this.bytes(path);
    const encoding = encodingOf(options);
    if (encoding === 'binary' || encoding === 'latin1') return latin1Text(asBytes(data));
    return typeof data === 'string' ? data : utf8Text(data);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return asBytes(await this.bytes(path));
  }

  private async put(path: string, content: FileContent, options: Encoding, append: boolean): Promise<void> {
    const rel = this.rel(path);
    if (!rel) throw fsError('EISDIR', 'illegal operation on a directory', 'open', path);
    const info = await this.info(path);
    if (info.exists && info.isDir) throw fsError('EISDIR', 'illegal operation on a directory', 'open', path);
    this.forget();
    await this.ops.write(rel, contentBytes(content, options), append);
  }

  writeFile(path: string, content: FileContent, options?: Encoding): Promise<void> {
    return this.put(path, content, options, false);
  }

  appendFile(path: string, content: FileContent, options?: Encoding): Promise<void> {
    return this.put(path, content, options, true);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.info(path)).exists;
  }

  async stat(path: string): Promise<FsStat> {
    const info = await this.info(path);
    if (!info.exists) throw fsError('ENOENT', 'no such file or directory', 'stat', path);
    return this.toStat(info);
  }

  lstat(path: string): Promise<FsStat> {
    return this.stat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const info = await this.info(path);
    if (info.exists) {
      if (info.isDir && options?.recursive) return;
      throw fsError('EEXIST', 'file already exists', 'mkdir', path);
    }
    if (!this.ops.mkdir) throw fsError('ENOTSUP', 'operation not supported on this device', 'mkdir', path);
    const parent = posixNormalize(`${path}/..`);
    if (!options?.recursive && !(await this.info(parent)).exists) {
      throw fsError('ENOENT', 'no such file or directory', 'mkdir', path);
    }
    this.forget();
    await this.ops.mkdir(this.rel(path));
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.entries(path)).map((e) => e.name);
  }

  async readdirWithFileTypes(path: string) {
    return (await this.entries(path)).map((e) => ({
      name: e.name,
      isFile: !e.isDir,
      isDirectory: e.isDir,
      isSymbolicLink: false,
    }));
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const rel = this.rel(path);
    if (!rel) throw fsError('EPERM', 'the connected folder itself cannot be removed', 'rm', path);
    const info = await this.info(path);
    if (!info.exists) {
      if (options?.force) return;
      throw fsError('ENOENT', 'no such file or directory', 'rm', path);
    }
    if (info.isDir && !options?.recursive && (await this.ops.list(rel)).length) {
      throw fsError('ENOTEMPTY', 'directory not empty', 'rm', path);
    }
    this.forget();
    await this.ops.remove(rel);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const info = await this.info(src);
    if (!info.exists) throw fsError('ENOENT', 'no such file or directory', 'cp', src);
    if (info.isDir) {
      if (!options?.recursive) throw fsError('EISDIR', 'illegal operation on a directory', 'cp', src);
      await this.mkdir(dest, { recursive: true });
      for (const entry of await this.entries(src)) {
        await this.cp(`${src}/${entry.name}`, `${dest}/${entry.name}`, options);
      }
      return;
    }
    this.forget();
    if (this.ops.copy) await this.ops.copy(this.rel(src), this.rel(dest));
    else await this.ops.write(this.rel(dest), await this.ops.read(this.rel(src)), false);
  }

  async mv(src: string, dest: string): Promise<void> {
    if (!this.rel(src)) throw fsError('EPERM', 'the connected folder itself cannot be moved', 'mv', src);
    if (this.ops.rename) {
      if (!(await this.info(src)).exists) throw fsError('ENOENT', 'no such file or directory', 'mv', src);
      this.forget();
      await this.ops.rename(this.rel(src), this.rel(dest));
      return;
    }
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true, force: true });
  }

  resolvePath(base: string, path: string): string {
    return posixNormalize(path.startsWith('/') ? path : `${base}/${path}`);
  }

  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string): Promise<void> {
    if (!(await this.info(path)).exists) throw fsError('ENOENT', 'no such file or directory', 'chmod', path);
  }

  async utimes(path: string): Promise<void> {
    if (!(await this.info(path)).exists) throw fsError('ENOENT', 'no such file or directory', 'utime', path);
  }

  async symlink(_target: string, linkPath: string): Promise<void> {
    throw fsError('ENOTSUP', 'links are not supported on this device', 'symlink', linkPath);
  }

  async link(_existing: string, newPath: string): Promise<void> {
    throw fsError('ENOTSUP', 'links are not supported on this device', 'link', newPath);
  }

  async readlink(path: string): Promise<string> {
    throw fsError('EINVAL', 'invalid argument', 'readlink', path);
  }

  async realpath(path: string): Promise<string> {
    if (!(await this.info(path)).exists) throw fsError('ENOENT', 'no such file or directory', 'realpath', path);
    return posixNormalize(path);
  }
}

// ── 내장 셸 ─────────────────────────────────────────────────────────

/** 쓰는 쪽이 넘기는 just-bash 모듈(`just-bash/browser`)의 필요한 부분. */
export interface JustBashModule {
  Bash: new (options: Record<string, unknown>) => {
    exec(
      command: string,
      options?: { signal?: AbortSignal },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  MountableFs: new (options?: { base?: unknown }) => { mount(point: string, filesystem: unknown): void };
  InMemoryFs: new () => unknown;
  getCommandNames?: () => string[];
}

export interface ShellMount {
  /** 폴더 이름 — 해석기에서 `/<이름>` 이 된다(겹치면 {@link uniqueMountNames}). */
  name: string;
  ops: ShellFolderOps;
}

export interface FolderShellRunRequest {
  command: string;
  /** 해석기 안의 시작 위치(`/<폴더 이름>/…`). 비면 첫 폴더. */
  cwd?: string;
  mounts: ShellMount[];
  /** 대화 — 작업은 그 대화에서만 보인다. */
  key: string;
  waitMs?: number;
  maxRuntimeMs?: number;
  signal?: AbortSignal;
}

/** 스트림마다 앞쪽·뒤쪽에 남기는 글자 수 — 데스크톱과 같다. */
const HEAD_CHARS = 40_000;
const TAIL_CHARS = 160_000;
const MAX_RUNNING_JOBS = 25;
const MAX_KEPT_JOBS = 200;

function capped(text: string): { text: string; truncated: boolean } {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return { text, truncated: false };
  const dropped = text.length - HEAD_CHARS - TAIL_CHARS;
  return {
    text: `${text.slice(0, HEAD_CHARS)}\n... (${dropped} characters omitted) ...\n${text.slice(-TAIL_CHARS)}`,
    truncated: true,
  };
}

interface ShellJob {
  id: string;
  key: string;
  mounts: string[];
  cwd: string;
  running: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  abort: AbortController;
  done: Promise<void>;
}

/**
 * 프로세스를 띄울 수 없는 기기의 UserPc 실행기 — 명령마다 해석기를 새로 만들어(폴더 목록이 그 호출의
 * 것이 되게) 연결 폴더를 붙이고 돌린다. `wait_ms` 안에 끝나지 않으면 작업으로 넘긴다.
 *
 * 해석기는 붙인 폴더 밖을 보지 못한다(`cd /` 해도 붙인 폴더와 해석기의 빈 디렉터리뿐이다). 네트워크·
 * JavaScript·Python 은 켜지 않는다. just-bash 의 전역 보호(Function·eval 등을 실행 중에 바꿔 끼움)는
 * 끈다 — 이 기기들에서는 앱 화면과 같은 영역에서 돌아 앱 전체에 걸린다.
 */
export class FolderShell {
  private jobs = new Map<string, ShellJob>();
  private seq = 0;

  /**
   * @param leaveOut 이 기기에서 돌지 않는 명령(부르는 패키지를 싣지 않았다) — 등록하지 않으므로 `which` 가
   *   없다고 정직하게 답한다.
   */
  constructor(
    private readonly jb: () => Promise<JustBashModule>,
    readonly info: UserPcShellInfo,
    private readonly leaveOut: readonly string[] = [],
  ) {}

  private outcome(job: ShellJob): UserPcOutcome {
    const out = capped(job.stdout);
    const err = capped(job.stderr);
    return {
      exit_code: job.running ? null : job.code,
      stdout: out.text,
      stderr: err.text,
      running: job.running,
      job_id: job.running ? job.id : null,
      cwd: job.cwd,
      shell: this.info.label,
      truncated: out.truncated || err.truncated,
    };
  }

  private evict(): void {
    if (this.jobs.size <= MAX_KEPT_JOBS) return;
    const finished = [...this.jobs.values()].filter((j) => !j.running).sort((a, b) => a.startedAt - b.startedAt);
    for (const job of finished) {
      if (this.jobs.size <= MAX_KEPT_JOBS) break;
      this.jobs.delete(job.id);
    }
  }

  private async wait(job: ShellJob, ms: number, signal?: AbortSignal): Promise<void> {
    if (!job.running || ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      job.done,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      new Promise<void>((resolve) => {
        if (!signal) return;
        onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }

  async run(req: FolderShellRunRequest): Promise<UserPcOutcome> {
    if (!req.mounts.length) throw new Error('No folder is connected to this conversation.');
    const running = [...this.jobs.values()].filter((j) => j.key === req.key && j.running).length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new Error(`${running} commands are still running in this conversation; stop some with job stop first.`);
    }
    const waitMs = clampMs(req.waitMs, USER_PC_DEFAULT_WAIT_MS, 1_000, USER_PC_MAX_WAIT_MS);
    const maxRuntimeMs = clampMs(req.maxRuntimeMs, USER_PC_DEFAULT_MAX_RUNTIME_MS, waitMs, USER_PC_MAX_RUNTIME_MS);
    if (req.signal?.aborted) throw new Error('cancelled');

    const jb = await this.jb();
    const names = uniqueMountNames(req.mounts.map((m) => m.name));
    const fs = new jb.MountableFs({ base: new jb.InMemoryFs() });
    req.mounts.forEach((mount, i) => fs.mount(`/${names[i]}`, new FolderOpsFs(mount.ops)));
    const cwd = req.cwd ? posixNormalize(req.cwd) : `/${names[0]}`;
    if (!names.some((name) => cwd === `/${name}` || cwd.startsWith(`/${name}/`))) {
      throw new Error(`PATH_DOMAIN_MISMATCH: ${cwd} is not inside a connected folder.`);
    }
    const commands =
      this.leaveOut.length && jb.getCommandNames
        ? jb.getCommandNames().filter((name) => !this.leaveOut.includes(name))
        : undefined;
    const bash = new jb.Bash({
      fs,
      cwd,
      env: { HOME: `/${names[0]}`, PWD: cwd },
      ...(commands ? { commands } : {}),
      defenseInDepth: false,
      executionLimits: { maxExecutionTimeMs: maxRuntimeMs },
    });

    this.seq += 1;
    const abort = new AbortController();
    const job: ShellJob = {
      id: `pc-${Date.now().toString(36)}-${this.seq}`,
      key: req.key,
      mounts: names,
      cwd,
      running: true,
      code: null,
      stdout: '',
      stderr: '',
      startedAt: Date.now(),
      abort,
      done: Promise.resolve(),
    };
    job.done = bash.exec(req.command, { signal: abort.signal }).then(
      (r) => {
        job.stdout = r.stdout;
        job.stderr = r.stderr;
        job.code = abort.signal.aborted ? 130 : r.exitCode;
      },
      (e: unknown) => {
        job.stderr = `${e instanceof Error ? e.message : String(e)}\n`;
        job.code = abort.signal.aborted ? 130 : 1;
      },
    ).finally(() => {
      job.running = false;
      if (abort.signal.aborted && !job.stderr.includes('stopped')) job.stderr += 'stopped\n';
    });
    this.jobs.set(job.id, job);
    this.evict();

    const onAbort = () => abort.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.wait(job, waitMs, req.signal);
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
    if (req.signal?.aborted) await job.done;
    if (!job.running) this.jobs.delete(job.id);
    return this.outcome(job);
  }

  /** 작업을 확인하거나 멈춘다. */
  async job(jobId: string, key: string, action: 'poll' | 'stop', waitMs?: number, signal?: AbortSignal): Promise<UserPcOutcome> {
    const job = this.jobs.get(String(jobId || '').trim());
    if (!job || job.key !== key) throw new Error(`No job ${jobId} in this conversation.`);
    if (action === 'stop') {
      job.abort.abort();
      await Promise.race([job.done, new Promise((r) => setTimeout(r, 3_000))]);
    } else {
      await this.wait(job, clampMs(waitMs, 10_000, 0, 120_000), signal);
    }
    return this.outcome(job);
  }

  /** 연결이 끊긴 폴더에서 돌던 그 대화의 작업을 멈춘다 — 멈춘 수. */
  stopOutside(key: string, keepNames: string[]): number {
    let stopped = 0;
    for (const job of this.jobs.values()) {
      if (job.key !== key || !job.running) continue;
      if (job.mounts.every((name) => keepNames.includes(name))) continue;
      job.abort.abort();
      stopped += 1;
    }
    return stopped;
  }

  /** 앱을 닫거나 계정을 나갈 때. */
  stopAll(): void {
    for (const job of this.jobs.values()) if (job.running) job.abort.abort();
  }
}
