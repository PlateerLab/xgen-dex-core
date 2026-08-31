import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { DEX_PROTOCOL_VERSION, type InitializeResult, type RpcNotification } from './wire';

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface RpcProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DexRpcClientOptions {
  process: RpcProcessSpec;
  clientVersion: string;
  requestTimeoutMs?: number;
  log?: (message: string) => void;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

export type RpcClientState = 'stopped' | 'starting' | 'ready' | 'stopping';

export class DexRpcError extends Error {
  constructor(
    message: string,
    readonly rpcCode?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }

  get engineCode(): string | undefined {
    if (!this.data || typeof this.data !== 'object') return undefined;
    const code = (this.data as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  }
}

export class DexRpcClient {
  private readonly requestTimeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly spawnProcess: NonNullable<DexRpcClientOptions['spawnProcess']>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: RpcNotification) => void>();
  private readonly stateListeners = new Set<(state: RpcClientState) => void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private lineReader: ReadlineInterface | undefined;
  private nextId = 1;
  private startPromise: Promise<InitializeResult> | undefined;
  private initializeResult: InitializeResult | undefined;
  private currentState: RpcClientState = 'stopped';

  constructor(private readonly options: DexRpcClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.log = options.log ?? (() => undefined);
    this.spawnProcess = options.spawnProcess ?? ((command, args, processOptions) =>
      spawn(command, args, { ...processOptions, stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  get state(): RpcClientState {
    return this.currentState;
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onStateChange(listener: (state: RpcClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  async start(): Promise<InitializeResult> {
    if (this.currentState === 'ready' && this.initializeResult) return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    return this.sendRequest<T>(method, params);
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.start();
    this.write({ jsonrpc: '2.0', method, params });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.setState('stopped');
      return;
    }
    this.setState('stopping');
    try {
      await this.sendRequest('shutdown', {}, 1500);
    } catch {
      // A process may exit immediately after acknowledging shutdown.
    }
    if (child.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    if (child.exitCode === null && !child.killed) child.kill();
    this.cleanupProcess(child, new DexRpcError('dex-cli engine stopped'));
  }

  async restart(processSpec?: RpcProcessSpec): Promise<InitializeResult> {
    await this.stop();
    if (processSpec) this.options.process = processSpec;
    return this.start();
  }

  private async startProcess(): Promise<InitializeResult> {
    this.setState('starting');
    const spec = this.options.process;
    this.log(`Starting dex-cli: ${spec.command} ${spec.args.join(' ')}`);
    const child = this.spawnProcess(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      windowsHide: true,
    });
    this.child = child;
    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on('line', (line) => this.handleLine(line));
    child.stdin.on('error', (error) => this.cleanupProcess(child, error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.trimEnd().split(/\r?\n/)) {
        if (line) this.log(`[engine] ${line}`);
      }
    });
    child.once('close', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${String(code)}`;
      this.cleanupProcess(child, new DexRpcError(`dex-cli engine exited with ${suffix}`));
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.cleanupProcess(child, new DexRpcError(`dex-cli를 시작할 수 없습니다: ${message}`));
      throw new DexRpcError(`dex-cli를 시작할 수 없습니다: ${message}`);
    });

    try {
      const initialized = await this.sendRequest<InitializeResult>('initialize', {
        protocolVersion: DEX_PROTOCOL_VERSION,
        client: { name: 'xgen-dex-vscode', version: this.options.clientVersion },
      });
      this.initializeResult = initialized;
      this.setState('ready');
      this.log(`Connected to ${initialized.server.name} ${initialized.server.version}`);
      return initialized;
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill();
      this.cleanupProcess(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new DexRpcError(`RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.exitCode !== null) {
      throw new DexRpcError('dex-cli engine is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.log('[protocol] Ignored malformed JSON stdout frame');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const record = message as Record<string, unknown>;
    if (typeof record.method === 'string' && !Object.prototype.hasOwnProperty.call(record, 'id')) {
      const notification = message as RpcNotification;
      for (const listener of this.notificationListeners) listener(notification);
      return;
    }
    if (typeof record.id !== 'number') return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    clearTimeout(pending.timeout);
    const response = message as RpcResponse;
    if (response.error) {
      pending.reject(new DexRpcError(response.error.message, response.error.code, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private cleanupProcess(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.lineReader?.close();
    this.lineReader = undefined;
    this.child = undefined;
    this.initializeResult = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new DexRpcError(`${error.message} (${request.method})`));
    }
    this.pending.clear();
    this.setState('stopped');
  }

  private setState(state: RpcClientState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
