/**
 * 엔진 데몬 관리 — 동봉 Python 으로 `xd_engine` 을 띄우고 stdio JSON 줄(프로토콜 v1)로 말한다.
 *
 * - 필요할 때 띄운다(첫 턴). `ready` 를 받으면 위험 명령 규칙(Dex 의 것)을 `configure` 로 넘긴다.
 * - 사건은 턴 id 로 나눠 그 턴의 듣는 이에게 준다. 턴마다 종결 사건은 하나다(엔진의 약속). 엔진이 죽으면
 *   도는 턴을 이쪽에서 `error{code: engine_exited}` 로 끝내고, 다음 턴에 다시 띄운다.
 * - stderr 는 `<루트>/.xd/logs/engine.log` 로(크기가 넘치면 하나 돌려 둔다).
 * - 창 없이(windowsHide), 로그인 셸의 PATH 로 띄운다 — Finder·시작 메뉴로 켠 앱은 그 PATH 를 모른다.
 *
 * 설계: apps/xd/DESIGN.md §5.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { dangerousPatternSpecs } from '@dex/engine/dangerous-commands';
import { augmentedPath, buildChildEnv } from '@dex/engine/exec-resolve';

export const PROTOCOL_VERSION = 1;

/** 엔진이 내는 사건(프로토콜 v1). 필드는 사건마다 다르다. */
export interface EngineEvent {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export type TurnTerminal =
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; code: string; message: string }
  | { type: 'cancelled'; id: string };

const TERMINALS = new Set(['done', 'error', 'cancelled']);

export interface TurnCommand {
  id: string;
  conversation: string;
  text: unknown;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  agent: {
    id: string;
    name: string;
    workspace: string;
    system_prompt?: string;
    folders?: string[];
    memory?: boolean;
  };
  config: Record<string, unknown>;
}

/** 동봉 Python 의 자리. 개발 실행은 `scripts/bundle-engine.mjs` 가 만든 것을 쓴다. */
export function enginePythonPath(opts: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = opts.env ?? process.env;
  if (env.XD_ENGINE_PYTHON) return env.XD_ENGINE_PYTHON;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const base = opts.packaged
    ? join(opts.resourcesPath, 'engine', 'python')
    : join(opts.appPath, 'engine', 'dist', `${platform}-${arch}`, 'python');
  return platform === 'win32' ? join(base, 'python.exe') : join(base, 'bin', 'python3');
}

/** 로그 한 파일의 상한 — 넘치면 `.1` 로 돌리고 새로 쓴다. */
const LOG_LIMIT = 5 * 1024 * 1024;

export interface EngineServiceOptions {
  python: string;
  root: string;
  logDir: string;
  /** 엔진 프로세스 환경의 바탕(기본 process.env). 시험이 바꾼다. */
  baseEnv?: NodeJS.ProcessEnv;
  /** `ready` 를 기다리는 시간. */
  readyTimeoutMs?: number;
  /** 시험용 — 실제 python 대신 띄울 명령(첫 칸이 실행 파일). */
  command?: string[];
}

type Listener = (event: EngineEvent) => void;

interface PendingTurn {
  listener: Listener;
  resolve: (terminal: TurnTerminal) => void;
}

export class EngineService {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<EngineEvent> | null = null;
  private readyInfo: EngineEvent | null = null;
  private turns = new Map<string, PendingTurn>();
  private stopping = false;
  private readonly logFile: string;

  constructor(private readonly opts: EngineServiceOptions) {
    mkdirSync(opts.logDir, { recursive: true });
    this.logFile = join(opts.logDir, 'engine.log');
  }

  /** 엔진이 떠 있으면 그 `ready`, 아니면 띄우고 기다린다. */
  ensure(): Promise<EngineEvent> {
    if (this.child && this.readyInfo) return Promise.resolve(this.readyInfo);
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  get info(): EngineEvent | null {
    return this.readyInfo;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** 턴 하나 — 사건은 `listener` 로, 종결 사건으로 끝난다(거부되지 않는다). */
  async turn(cmd: TurnCommand, listener: Listener): Promise<TurnTerminal> {
    if (this.turns.has(cmd.id)) throw new Error(`turn ${cmd.id} is already running`);
    try {
      await this.ensure();
    } catch (err) {
      return { type: 'error', id: cmd.id, code: 'engine_unavailable', message: String((err as Error).message ?? err) };
    }
    return new Promise<TurnTerminal>((resolve) => {
      this.turns.set(cmd.id, { listener, resolve });
      if (!this.send({ type: 'turn', ...cmd })) {
        this.finish(cmd.id, { type: 'error', id: cmd.id, code: 'engine_exited', message: 'The engine stopped.' });
      }
    });
  }

  cancel(turnId: string): void {
    if (this.turns.has(turnId)) this.send({ type: 'cancel', id: turnId });
  }

  approvalReply(turnId: string, request: string, answer: 'once' | 'session' | 'deny'): void {
    this.send({ type: 'approval_reply', id: turnId, request, answer });
  }

  /** 정리까지 기다렸다가 끝낸다. 도는 턴은 엔진이 취소로 마무리한다. */
  async stop(timeoutMs = 15_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    // 'exit' 는 stdout 이 다 읽히기 전에 올 수 있다 — 마지막 사건(취소)까지 받은 뒤인 'close' 를 기다린다.
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.send({ type: 'shutdown' });
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    await exited;
    clearTimeout(timer);
    this.stopping = false;
  }

  // ── 내부 ─────────────────────────────────────────────────────────────
  private async start(): Promise<EngineEvent> {
    const path = await augmentedPath();
    const env = buildChildEnv(path, undefined, (this.opts.baseEnv ?? process.env) as Record<string, string>);
    const [file, ...args] = this.opts.command ?? [this.opts.python, '-I', '-m', 'xd_engine', '--root', this.opts.root];
    if (!this.opts.command && !existsSync(file)) {
      throw new Error(`engine not found: ${file}`);
    }
    const child = spawn(file, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.readyInfo = null;
    this.log(`--- engine start ${new Date().toISOString()} ${file}\n`);

    child.stderr.on('data', (chunk: Buffer) => this.log(chunk.toString('utf8')));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

    const ready = new Promise<EngineEvent>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the engine did not become ready in time')),
        this.opts.readyTimeoutMs ?? 60_000,
      );
      const onLine = (line: string) => {
        const event = this.parse(line);
        if (!event) return;
        if (!this.readyInfo && (event.type === 'ready' || event.type === 'fatal')) {
          clearTimeout(timer);
          if (event.type === 'fatal') {
            reject(new Error(String(event.message ?? 'engine failed to start')));
            return;
          }
          if (event.protocol !== PROTOCOL_VERSION) {
            reject(new Error(`engine protocol ${String(event.protocol)} is not ${PROTOCOL_VERSION}`));
            child.kill();
            return;
          }
          this.readyInfo = event;
          resolve(event);
          return;
        }
        this.route(event);
      };
      lines.on('line', onLine);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`the engine exited before it was ready (${code ?? signal})`));
      });
    });

    // 'close' — 프로세스가 끝나고 stdout 도 다 읽은 뒤. 그 전에 끝난 턴의 사건을 놓치지 않는다.
    child.once('close', (code, signal) => {
      this.log(`--- engine exit ${new Date().toISOString()} code=${code} signal=${signal}\n`);
      if (this.child === child) {
        this.child = null;
        this.readyInfo = null;
      }
      // 끝나지 못한 턴은 여기서 끝낸다 — 화면이 영원히 "실행 중" 으로 남지 않게.
      for (const id of [...this.turns.keys()]) {
        this.finish(id, {
          type: 'error',
          id,
          code: 'engine_exited',
          message: this.stopping ? 'The app is closing.' : 'The engine stopped unexpectedly.',
        });
      }
    });

    try {
      const info = await ready;
      this.send({ type: 'configure', dangerous: dangerousPatternSpecs() });
      return info;
    } catch (err) {
      if (this.child === child) {
        child.kill();
        this.child = null;
      }
      throw err;
    }
  }

  private parse(line: string): EngineEvent | null {
    const text = line.trim();
    if (!text) return null;
    try {
      const value = JSON.parse(text) as EngineEvent;
      return value && typeof value === 'object' && typeof value.type === 'string' ? value : null;
    } catch {
      // 프로토콜 밖의 줄 — 엔진이 stdout 을 지키므로 생기면 버그다. 기록만 하고 넘어간다.
      this.log(`[non-protocol stdout] ${text}\n`);
      return null;
    }
  }

  private route(event: EngineEvent): void {
    const id = typeof event.id === 'string' ? event.id : '';
    const pending = id ? this.turns.get(id) : undefined;
    if (!pending) {
      if (event.type === 'protocol_error') this.log(`[protocol_error] ${String(event.message)}\n`);
      return;
    }
    if (TERMINALS.has(event.type)) {
      this.finish(id, event as unknown as TurnTerminal);
      return;
    }
    try {
      pending.listener(event);
    } catch (err) {
      this.log(`[listener error] ${String(err)}\n`);
    }
  }

  private finish(id: string, terminal: TurnTerminal): void {
    const pending = this.turns.get(id);
    if (!pending) return;
    this.turns.delete(id);
    try {
      pending.listener(terminal as unknown as EngineEvent);
    } catch (err) {
      this.log(`[listener error] ${String(err)}\n`);
    }
    pending.resolve(terminal);
  }

  private send(command: Record<string, unknown>): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  private log(text: string): void {
    try {
      if (existsSync(this.logFile) && statSync(this.logFile).size > LOG_LIMIT) {
        renameSync(this.logFile, `${this.logFile}.1`);
      }
      appendFileSync(this.logFile, text);
    } catch {
      /* 로그 실패가 엔진을 멈추지 않는다 */
    }
  }
}
