/**
 * 워크스페이스 브리지 도구 — 서버의 에이전트 런타임이 **이 PC 를 실행 환경으로**
 * 쓰게 하는 내부 도구 4종.
 *
 * 핵심 설계: 에이전트에게는 "추가 도구"가 아니다. 에이전트는 sandbox 세션에서와
 * 똑같이 `Bash`/`Read`/`Write` 를 부르고, 서버의 ConnectorLocalSandbox 어댑터가
 * 그 호출을 여기(_Exec/_ReadBytes/_WriteBytes)로 라우팅한다. 이 도구들의 이름이
 * `_` 로 시작하는 이유 — 서버 injector 가 `_` 접두 도구를 **LLM 노출에서 제외**
 * 하므로, 모델은 이것들의 존재조차 모른다. 순수한 배관이다.
 *
 * ── 가상 경로 규약 ────────────────────────────────────────────────────
 *
 * 서버 런타임의 경로 가드는 POSIX 전제다. Windows 실경로(D:\…)를 서버로 보내면
 * 가드가 깨지므로, 와이어에는 **가상 POSIX 경로**만 흐른다:
 *
 *     /ws     → <기본 작업 폴더>/<에이전트 폴더>   (local-sync 가 서버와 동기화)
 *     /cloud  → 마운트된 XGen-Cloud 드라이브       (마운트돼 있을 때만)
 *
 * 실경로 변환은 전부 이 파일 안에서 끝난다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { augmentedPath, buildChildEnv } from '@dex/engine/exec-resolve';
import type { LocalToolResult, LocalToolSchema } from '@dex/engine/local-tools';

export const WORKSPACE_INFO_TOOL = '_WorkspaceInfo';
export const EXEC_TOOL = '_Exec';
export const READ_BYTES_TOOL = '_ReadBytes';
export const WRITE_BYTES_TOOL = '_WriteBytes';
export const FLUSH_SYNC_TOOL = '_FlushSync';

export const VIRTUAL_WS = '/ws';
export const VIRTUAL_CLOUD = '/cloud';

const IS_WIN = platform() === 'win32';
/** exec 출력 상한 (스트림당). 서버 쪽 도구가 어차피 더 작게 자른다. */
const EXEC_STREAM_CAP = 2 * 1024 * 1024;
/** 파일 바이트 상한 — Read/Write 가 이걸 넘으면 도구가 아니라 동기화의 몫이다. */
const FILE_CAP = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;

/**
 * 가상 경로 → [루트 종류, 상대 경로]. 규약 밖 경로는 null (밖으로 나갈 수 없다).
 * 순수 함수 — 단위 테스트 대상.
 */
export function splitVirtualPath(virtual: string): { root: 'ws' | 'cloud'; rel: string } | null {
  const v = String(virtual ?? '').trim();
  if (!v.startsWith('/') || v.includes('\\')) return null;
  const segs = v.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  if (segs.some((s) => s === '.' || s === '..')) return null;
  const head = segs[0];
  const rel = segs.slice(1).join('/');
  if (head === 'ws') return { root: 'ws', rel };
  if (head === 'cloud') return { root: 'cloud', rel };
  return null;
}

/** 이 브리지가 실행 환경으로 내줄 워크스페이스 하나. */
export interface BridgeWorkspaceInfo {
  /** 로컬 실경로 (동기화 폴더). */
  dir: string;
  /** 에이전트 라벨 (프롬프트 표기용). */
  label: string;
}

export interface WorkspaceBridgeDeps {
  /**
   * workflowId → 이 에이전트의 로컬 실행 폴더. 로컬 실행이 불가하면 null.
   * workflowName 은 폴더를 처음 만들 때 이름으로 쓴다 (_WorkspaceInfo 만 넘긴다).
   */
  infoFor(workflowId: string, workflowName?: string): BridgeWorkspaceInfo | null;
  /**
   * 턴 시작 — 폴더를 확보하고 **인덱스에서 하이드레이트가 끝날 때까지** 기다린다.
   * 웹에서 만든 파일이 로컬에 내려온 뒤 에이전트가 돌게 한다 (빈 워크스페이스
   * 오판 방지). synced=false 여도 dir 은 준다 (남은 동기화는 백그라운드).
   */
  ensureSynced(
    workflowId: string,
    workflowName?: string,
  ): Promise<{ info: BridgeWorkspaceInfo | null; synced: boolean }>;
  /**
   * 턴 종료 — 로컬 변경을 인덱스로 **밀어 넣고 끝날 때까지** 기다린다. 이 PC 에서
   * 만든 파일이 인덱스에 반영된 뒤에야 웹(sandbox)이 그것을 본다 (커넥터→웹).
   */
  flushSync(workflowId: string): Promise<boolean>;
  /** 마운트된 XGen-Cloud 드라이브의 실경로 (미마운트면 null). */
  cloudDir(): string | null;
  /** 에이전트가 파일을 만졌다 — 동기화를 곧 돌려 서버 인덱스에 반영하라. */
  poke(workflowId: string): void;
}

function jsonResult(obj: unknown, isError = false): LocalToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], isError };
}

function killTree(child: ChildProcess, detachedGroup: boolean): void {
  try {
    if (IS_WIN) {
      if (child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGKILL');
    } else if (detachedGroup && child.pid) {
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

export class WorkspaceBridge {
  constructor(private deps: WorkspaceBridgeDeps) {}

  owns(tool: string): boolean {
    return (
      tool === WORKSPACE_INFO_TOOL ||
      tool === EXEC_TOOL ||
      tool === READ_BYTES_TOOL ||
      tool === WRITE_BYTES_TOOL ||
      tool === FLUSH_SYNC_TOOL
    );
  }

  /**
   * 카탈로그 광고 — 서버 어댑터가 존재를 확인하는 데 쓴다. 설명에 INTERNAL 을
   * 못박고, 이름의 `_` 접두 덕에 LLM 도구 목록에서는 걸러진다.
   */
  advertise(): LocalToolSchema[] {
    const internal = (name: string, description: string): LocalToolSchema => ({
      name,
      description: `INTERNAL (not for the model): ${description}`,
      inputSchema: { type: 'object' },
    });
    return [
      internal(WORKSPACE_INFO_TOOL, 'local workspace availability + hydrate for a workflow'),
      internal(EXEC_TOOL, 'run argv in the synced local workspace'),
      internal(READ_BYTES_TOOL, 'read file bytes from the local workspace'),
      internal(WRITE_BYTES_TOOL, 'write file bytes into the local workspace'),
      internal(FLUSH_SYNC_TOOL, 'flush local changes to the server index'),
    ];
  }

  async callTool(tool: string, args: unknown): Promise<LocalToolResult> {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const workflowId = String(a.workflowId ?? '').trim();
    const workflowName = typeof a.workflowName === 'string' ? a.workflowName : undefined;
    // 턴 시작 — 폴더 확보 + 하이드레이트 대기 (웹→커넥터 일관성).
    if (tool === WORKSPACE_INFO_TOOL) return this.workspaceInfo(workflowId, workflowName);
    // 턴 종료 — 로컬 변경을 인덱스로 밀어 넣고 대기 (커넥터→웹 일관성).
    if (tool === FLUSH_SYNC_TOOL) {
      if (!workflowId) return jsonResult({ flushed: false });
      const flushed = await this.deps.flushSync(workflowId);
      return jsonResult({ flushed });
    }
    // exec/read/write 는 _WorkspaceInfo 뒤에 오므로 폴더는 이미 확보돼 있다.
    const info = workflowId ? this.deps.infoFor(workflowId, workflowName) : null;
    if (!info) {
      return jsonResult(
        { error: '이 에이전트의 로컬 워크스페이스가 동기화되고 있지 않습니다.' },
        true,
      );
    }
    if (tool === EXEC_TOOL) return this.exec(workflowId, info, a);
    if (tool === READ_BYTES_TOOL) return this.readBytes(info, a);
    if (tool === WRITE_BYTES_TOOL) return this.writeBytes(workflowId, info, a);
    return jsonResult({ error: `unknown bridge tool: ${tool}` }, true);
  }

  /** 가상 경로 → 실경로. 규약 밖이거나 클라우드 미마운트면 null. */
  private realPath(info: BridgeWorkspaceInfo, virtual: string): string | null {
    const split = splitVirtualPath(virtual);
    if (!split) return null;
    const base = split.root === 'ws' ? info.dir : this.deps.cloudDir();
    if (!base) return null;
    return split.rel ? join(base, ...split.rel.split('/')) : base;
  }

  private async workspaceInfo(workflowId: string, workflowName?: string): Promise<LocalToolResult> {
    if (!workflowId) return jsonResult({ enabled: false });
    // 하이드레이트가 끝날 때까지 기다린 뒤에야 실행 환경이 '준비됨'이다 —
    // 웹에서 만든 파일이 로컬에 내려온 상태로 첫 도구가 돈다.
    const { info, synced } = await this.deps.ensureSynced(workflowId, workflowName);
    if (!info) return jsonResult({ enabled: false });
    const cloud = this.deps.cloudDir();
    return jsonResult({
      enabled: true,
      synced, // false 면 서버가 프롬프트로 '동기화 진행 중'을 알린다
      virtualRoot: VIRTUAL_WS,
      dir: info.dir,
      label: info.label,
      cloudMounted: !!cloud,
      cloudVirtualRoot: cloud ? VIRTUAL_CLOUD : undefined,
      cloudDir: cloud ?? undefined,
      platform: platform(),
    });
  }

  private async exec(
    workflowId: string,
    info: BridgeWorkspaceInfo,
    a: Record<string, unknown>,
  ): Promise<LocalToolResult> {
    const argv = Array.isArray(a.argv) ? a.argv.map((x) => String(x)) : [];
    if (argv.length === 0) return jsonResult({ error: 'argv 가 비어 있습니다.' }, true);
    const cwdVirtual = String(a.cwd ?? '').trim() || VIRTUAL_WS;
    const cwd = this.realPath(info, cwdVirtual);
    if (!cwd)
      return jsonResult({ error: `실행 폴더가 워크스페이스 밖입니다: ${cwdVirtual}` }, true);
    await mkdir(cwd, { recursive: true }).catch(() => undefined);

    const timeoutS = Math.max(1, Math.min(MAX_TIMEOUT_S, Number(a.timeoutS) || DEFAULT_TIMEOUT_S));
    const stdin =
      typeof a.stdinB64 === 'string' && a.stdinB64 ? Buffer.from(a.stdinB64, 'base64') : null;
    const extraEnv =
      a.env && typeof a.env === 'object'
        ? Object.fromEntries(
            Object.entries(a.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : {};
    // Shell 도구와 같은 환경 규약 — PATH 보강(brew/Git 경로 등) 위에 요청 env.
    const childEnv = buildChildEnv(await augmentedPath(), extraEnv);

    const run = (
      file: string,
    ): Promise<{ code: number; out: Buffer; err: Buffer; spawnErr?: NodeJS.ErrnoException }> =>
      new Promise((resolve) => {
        const detachedGroup = !IS_WIN;
        let child: ChildProcess;
        const chunksOut: Buffer[] = [];
        const chunksErr: Buffer[] = [];
        let outLen = 0;
        let errLen = 0;
        let settled = false;
        const done = (code: number, spawnErr?: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code, out: Buffer.concat(chunksOut), err: Buffer.concat(chunksErr), spawnErr });
        };
        try {
          child = spawn(file, argv.slice(1), {
            cwd,
            env: childEnv,
            windowsHide: true,
            detached: detachedGroup,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (e) {
          done(127, e as NodeJS.ErrnoException);
          return;
        }
        const timer = setTimeout(() => {
          killTree(child, detachedGroup);
          chunksErr.push(Buffer.from(`\n[timeout] ${timeoutS}s 를 넘겨 종료했습니다.\n`));
          done(124);
        }, timeoutS * 1000);
        child.stdout?.on('data', (d: Buffer) => {
          if (outLen < EXEC_STREAM_CAP) {
            chunksOut.push(d.subarray(0, EXEC_STREAM_CAP - outLen));
            outLen += d.length;
          }
        });
        child.stderr?.on('data', (d: Buffer) => {
          if (errLen < EXEC_STREAM_CAP) {
            chunksErr.push(d.subarray(0, EXEC_STREAM_CAP - errLen));
            errLen += d.length;
          }
        });
        child.on('error', (e: NodeJS.ErrnoException) => done(127, e));
        child.on('close', (code, signal) => done(signal ? 128 : (code ?? 0)));
        if (stdin) child.stdin?.write(stdin);
        child.stdin?.end();
      });

    let r = await run(argv[0]);
    // Windows: 서버 런타임은 항상 ['bash','-lc',…] 를 보낸다. bash 가 PATH 에
    // 없으면(Git Bash 미설치) 흔한 설치 경로를 한 번 더 짚는다 — PowerShell 로
    // 바꿔치기하지 않는다. 문법이 달라 조용히 이상하게 도는 것이 최악이다.
    if (r.spawnErr?.code === 'ENOENT' && IS_WIN && argv[0] === 'bash') {
      for (const candidate of [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      ]) {
        r = await run(candidate);
        if (r.spawnErr?.code !== 'ENOENT') break;
      }
      if (r.spawnErr?.code === 'ENOENT') {
        return jsonResult({
          code: 127,
          stdoutB64: '',
          stderrB64: Buffer.from(
            'bash 를 찾을 수 없습니다. 이 PC 에서 에이전트 명령을 실행하려면 ' +
              'Git for Windows(Git Bash) 를 설치하세요: https://git-scm.com/download/win',
          ).toString('base64'),
        });
      }
    }
    if (r.spawnErr && r.spawnErr.code === 'ENOENT') {
      return jsonResult({
        code: 127,
        stdoutB64: '',
        stderrB64: Buffer.from(`명령을 찾을 수 없습니다: ${argv[0]}`).toString('base64'),
      });
    }
    // 파일을 만들었을 수 있다 — 동기화를 곧 돌려 서버 인덱스(=sandbox)에 반영.
    this.deps.poke(workflowId);
    return jsonResult({
      code: r.code,
      stdoutB64: r.out.toString('base64'),
      stderrB64: r.err.toString('base64'),
    });
  }

  private async readBytes(
    info: BridgeWorkspaceInfo,
    a: Record<string, unknown>,
  ): Promise<LocalToolResult> {
    const abs = this.realPath(info, String(a.path ?? ''));
    if (!abs)
      return jsonResult({ error: `경로가 워크스페이스 밖입니다: ${String(a.path ?? '')}` }, true);
    try {
      const st = await stat(abs);
      if (st.size > FILE_CAP) {
        return jsonResult({ error: `파일이 너무 큽니다 (${st.size}B > ${FILE_CAP}B).` }, true);
      }
      const data = await readFile(abs);
      return jsonResult({ dataB64: data.toString('base64') });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return jsonResult({ notFound: true });
      return jsonResult({ error: (e as Error).message }, true);
    }
  }

  private async writeBytes(
    workflowId: string,
    info: BridgeWorkspaceInfo,
    a: Record<string, unknown>,
  ): Promise<LocalToolResult> {
    const abs = this.realPath(info, String(a.path ?? ''));
    if (!abs)
      return jsonResult({ error: `경로가 워크스페이스 밖입니다: ${String(a.path ?? '')}` }, true);
    const data = typeof a.dataB64 === 'string' ? Buffer.from(a.dataB64, 'base64') : Buffer.alloc(0);
    if (data.length > FILE_CAP) {
      return jsonResult({ error: `파일이 너무 큽니다 (${data.length}B > ${FILE_CAP}B).` }, true);
    }
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, data);
      this.deps.poke(workflowId);
      return jsonResult({ bytes: data.length });
    } catch (e) {
      return jsonResult({ error: (e as Error).message }, true);
    }
  }
}
