import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:process';
import { CdpPageProxy } from './cdp-page-proxy';
import { diag } from './diag-log';

export const AGENT_BROWSER_VERSION = '0.27.3';
const DEFAULT_TIMEOUT = 30_000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

interface QueueState {
  tail: Promise<unknown>;
  active: ChildProcess | null;
  cancelled: boolean;
}

function binaryName(): string {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  const header = report?.header;
  const linux = platform === 'linux' && !header?.glibcVersionRuntime ? 'linux-musl' : 'linux';
  const os = platform === 'win32' ? 'win32' : platform === 'linux' ? linux : platform;
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  return `agent-browser-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`;
}

export function resolveAgentBrowserBinary(): string {
  const appPath = app.getAppPath();
  const roots = [
    join(
      appPath.replace(/app\.asar$/, 'app.asar.unpacked'),
      'node_modules',
      'agent-browser',
      'bin',
    ),
    join(appPath, 'node_modules', 'agent-browser', 'bin'),
    join(process.cwd(), 'node_modules', 'agent-browser', 'bin'),
  ];
  for (const root of roots) {
    const candidate = join(root, binaryName());
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next packaged/development location */
    }
  }
  throw new Error(
    `agent-browser ${AGENT_BROWSER_VERSION} 바이너리를 찾지 못했습니다 (${binaryName()}).`,
  );
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        /* agent-browser may print a diagnostic before the JSON line */
      }
    }
    return { text: trimmed };
  }
}

function agentBrowserFailure(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  if (record.success !== false) return null;
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error === 'object') {
    const error = record.error as Record<string, unknown>;
    if (typeof error.message === 'string') return error.message;
  }
  try {
    return JSON.stringify(record.error ?? result);
  } catch {
    return 'agent-browser command failed';
  }
}

function connectionRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|connection refused|os error (?:61|111|10061)|failed to connect[^\n]*(?:CDP|127\.0\.0\.1)/i.test(
    message,
  );
}

function usesSnapshotRef(command: string[]): boolean {
  return command.some((arg) => /^@e\d+$/.test(arg));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentBrowserRunner {
  private queues = new Map<string, QueueState>();
  private ports = new Map<string, number>();

  async run(
    pageId: string,
    proxy: CdpPageProxy,
    command: string[],
    timeoutMs = DEFAULT_TIMEOUT,
    onRecover: () => void = () => {},
  ): Promise<unknown> {
    let queue = this.queues.get(pageId);
    if (!queue) {
      queue = { tail: Promise.resolve(), active: null, cancelled: false };
      this.queues.set(pageId, queue);
    }
    const state = queue;
    state.cancelled = false;
    const task = state.tail.then(async () => {
      if (state.cancelled) throw new Error('browser_page_not_found: 페이지가 닫혔습니다.');
      const port = await proxy.start();
      const previousPort = this.ports.get(pageId);
      let invalidated = false;
      const invalidateRefs = () => {
        if (invalidated) return;
        invalidated = true;
        onRecover();
      };
      if (previousPort !== undefined && previousPort !== port) {
        diag(
          'browser-agent',
          `CDP 포트 교체 page=${pageId} old=${previousPort} new=${port}`,
        );
        await this.closeSession(pageId);
        invalidateRefs();
      }
      this.ports.set(pageId, port);
      if (invalidated && usesSnapshotRef(command)) {
        throw new Error('snapshot ref is stale after browser reconnect; take a new snapshot.');
      }
      try {
        return await this.spawnCommand(state, pageId, port, command, timeoutMs);
      } catch (error) {
        if (!connectionRefused(error) || state.cancelled) throw error;
        diag(
          'browser-agent',
          `CDP 연결 거부 자동 복구 page=${pageId} port=${port} command=${command[0] ?? ''}`,
        );
        await this.closeSession(pageId);
        invalidateRefs();
        if (usesSnapshotRef(command)) {
          throw new Error('snapshot ref is stale after browser reconnect; take a new snapshot.');
        }
        if (state.cancelled)
          throw new Error('browser_page_not_found: 페이지가 닫혔습니다.');
        const retryPort = await proxy.start();
        this.ports.set(pageId, retryPort);
        return this.spawnCommand(state, pageId, retryPort, command, timeoutMs);
      }
    });
    state.tail = task.catch(() => undefined);
    return task;
  }

  private spawnCommand(
    state: QueueState,
    pageId: string,
    port: number,
    command: string[],
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(
          resolveAgentBrowserBinary(),
          ['--session', `xgen-page-${pageId}`, '--cdp', String(port), '--json', ...command],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
      } catch (error) {
        reject(error);
        return;
      }
      state.active = child;
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.active === child) state.active = null;
        if (error) reject(error);
        else resolve(result ?? parseJsonOutput(stdout));
      };
      child.stdout?.on('data', (data) => {
        stdout = (stdout + String(data)).slice(-OUTPUT_LIMIT);
      });
      child.stderr?.on('data', (data) => {
        stderr = (stderr + String(data)).slice(-OUTPUT_LIMIT);
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(stderr.trim() || stdout.trim() || `agent-browser exited ${code}`));
          return;
        }
        const result = parseJsonOutput(stdout);
        const failure = agentBrowserFailure(result);
        if (failure) finish(new Error(failure));
        else finish(undefined, result);
      });
      const timer = setTimeout(
        () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already exited */
          }
          finish(new Error(`browser_timeout: 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`));
        },
        Math.max(1_000, Math.min(120_000, timeoutMs)),
      );
    });
  }

  async cancelPage(pageId: string): Promise<void> {
    const state = this.queues.get(pageId);
    if (!state) return;
    state.cancelled = true;
    try {
      state.active?.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    state.active = null;
    this.queues.delete(pageId);
    this.ports.delete(pageId);
    // The CLI process exits after each command, but its per-session native
    // helper remains alive. Start the close command synchronously so Electron's
    // will-quit path cannot exit between cancellation and cleanup spawning;
    // then wait for both the interrupted command and the cleanup command.
    const close = this.closeSession(pageId);
    await state.tail.catch(() => undefined);
    await close;
  }

  private closeSession(pageId: string): Promise<void> {
    // `agent-browser close` removes the session PID file before its daemon has
    // actually exited. Capture the owned PID first, then observe that process
    // directly so a deleted PID file cannot be mistaken for completed cleanup.
    const helperPid = this.helperPid(pageId);
    return new Promise<void>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(
          resolveAgentBrowserBinary(),
          ['--session', `xgen-page-${pageId}`, '--json', 'close'],
          { stdio: 'ignore', windowsHide: true },
        );
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 2_000);
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    }).then(async () => {
      if (!helperPid) return;
      if (await this.waitForHelperExit(helperPid, 3_000)) return;
      diag('browser-agent', `helper 종료 지연 page=${pageId} pid=${helperPid}; SIGTERM`);
      try {
        process.kill(helperPid, 'SIGTERM');
      } catch {
        return;
      }
      if (await this.waitForHelperExit(helperPid, 1_000)) return;
      diag('browser-agent', `helper 강제 종료 page=${pageId} pid=${helperPid}; SIGKILL`);
      try {
        process.kill(helperPid, 'SIGKILL');
      } catch {
        return;
      }
      await this.waitForHelperExit(helperPid, 1_000);
    });
  }

  private helperPid(pageId: string): number | null {
    try {
      const raw = readFileSync(
        join(app.getPath('home'), '.agent-browser', `xgen-page-${pageId}.pid`),
        'utf8',
      ).trim();
      const pid = Number(raw);
      return Number.isInteger(pid) && pid > 1 && pid !== process.pid ? pid : null;
    } catch {
      return null;
    }
  }

  private helperAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForHelperExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.helperAlive(pid)) return true;
      await delay(50);
    }
    return !this.helperAlive(pid);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.queues.keys()].map((pageId) => this.cancelPage(pageId)));
  }
}
