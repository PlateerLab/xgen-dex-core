import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { DexEngine, DexError, publicError } from '@dex/engine';
import type {
  AgentListQuery,
  ChatInput,
  LocalToolsConfig,
  ResolvedChatInput,
} from '@dex/engine';
import { DEX_PROTOCOL_VERSION } from './wire';

type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: unknown;
}

class RpcFailure extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function objectParams(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new RpcFailure(-32602, 'params must be an object');
  }
  return params as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new RpcFailure(-32602, `${key} is required`);
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new RpcFailure(-32602, `${key} must be a string`);
  return value;
}

function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new RpcFailure(-32602, `${key} must be a positive integer`);
  }
  return Number(value);
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RpcFailure(-32602, `${key} must be a boolean`);
  return value;
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new RpcFailure(-32602, `${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function isRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === '2.0' && typeof request.method === 'string';
}

export interface RpcServerOptions {
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
  version?: string;
}

export class DexRpcServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly log: (message: string) => void;
  private readonly version: string;
  private readonly activeChats = new Map<string, AbortController>();
  private readline: ReadlineInterface | null = null;
  private initialized = false;
  private closed = false;
  private readonly removeLocalToolsListener: () => void;

  constructor(
    private readonly engine: DexEngine,
    options: RpcServerOptions = {},
  ) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.version = options.version ?? '0.1.0';
    this.removeLocalToolsListener = engine.onLocalToolsStatus((status) => {
      if (this.initialized && !this.closed) this.notify('localTools/status', status);
    });
  }

  start(): void {
    if (this.readline) return;
    this.readline = createInterface({ input: this.input, crlfDelay: Infinity });
    this.readline.on('line', (line) => void this.onLine(line));
    this.readline.on('close', () => this.close());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeChats.values()) controller.abort();
    this.activeChats.clear();
    this.engine.stopLocalTools();
    this.removeLocalToolsListener();
    if (this.readline) {
      const readline = this.readline;
      this.readline = null;
      readline.close();
    }
    this.input.pause();
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim() || this.closed) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.writeError(null, -32700, 'Parse error');
      return;
    }
    if (!isRequest(value)) {
      this.writeError(null, -32600, 'Invalid Request');
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, 'id');
    try {
      if (!this.initialized && value.method !== 'initialize' && value.method !== 'exit') {
        throw new RpcFailure(-32002, 'initialize must be called first');
      }
      const result = await this.dispatch(value.method, value.params);
      if (hasId) this.write({ jsonrpc: '2.0', id: value.id ?? null, result });
      if (value.method === 'shutdown' || value.method === 'exit') setImmediate(() => this.close());
    } catch (error) {
      if (!hasId) {
        this.log(`notification ${value.method} failed: ${publicError(error).message}`);
        return;
      }
      if (error instanceof RpcFailure) {
        this.writeError(value.id ?? null, error.rpcCode, error.message, error.data);
        return;
      }
      const exposed = publicError(error);
      this.writeError(value.id ?? null, -32000, exposed.message, exposed);
    }
  }

  private async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    const params = objectParams(rawParams);
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        if (requested !== DEX_PROTOCOL_VERSION) {
          throw new DexError(
            'protocol_mismatch',
            `지원하지 않는 protocolVersion입니다: ${String(requested)}`,
            { supported: DEX_PROTOCOL_VERSION },
          );
        }
        this.initialized = true;
        setImmediate(() => {
          void this.engine.startLocalTools().catch((error: unknown) =>
            this.log(`local tools: ${publicError(error).message}`),
          );
        });
        return {
          protocolVersion: DEX_PROTOCOL_VERSION,
          server: { name: 'dex-cli', version: this.version },
          capabilities: {
            profiles: true,
            authentication: ['password'],
            agents: true,
            chatStreaming: true,
            chatCancellation: true,
            history: true,
            localTools: true,
            ssh: true,
          },
        };
      }
      case 'shutdown':
      case 'exit':
        this.engine.stopLocalTools();
        return null;
      case 'health':
        return { ok: true, activeChats: this.activeChats.size };
      case 'profile/list':
        return this.engine.listProfiles();
      case 'profile/set':
        return this.engine.setProfile(requiredString(params, 'name'), requiredString(params, 'serverUrl'));
      case 'profile/use': {
        const profile = await this.engine.useProfile(requiredString(params, 'name'));
        void this.engine.startLocalTools(profile.name).catch((error: unknown) => this.log(`local tools: ${publicError(error).message}`));
        return profile;
      }
      case 'auth/login': {
        const auth = await this.engine.login(
          requiredString(params, 'email'),
          requiredString(params, 'password'),
          optionalString(params, 'profile'),
        );
        void this.engine.startLocalTools(auth.profile).catch((error: unknown) => this.log(`local tools: ${publicError(error).message}`));
        return auth;
      }
      case 'auth/status':
        return this.engine.authStatus(optionalString(params, 'profile'));
      case 'auth/logout':
        await this.engine.logout(optionalString(params, 'profile'));
        return { ok: true };
      // ── SSH ──
      // 프로토콜에는 Teams · 음성 · 알림도 있지만 RPC 로 열지 않는다. CLI 와
      // 편집기에서 쓸 일이 아직 없고, 열어 두면 "되는 줄 알고" 부르는 경로가
      // 생긴다. 타입은 @dex/protocol 에 그대로 있으므로 여는 것은 한 줄이다.
      case 'ssh/config':
        return this.engine.sshConfig(optionalString(params, 'profile'));
      case 'ssh/setEnabled':
        return this.engine.setSshEnabled(
          params.enabled === true,
          optionalString(params, 'profile'),
        );
      case 'ssh/createServer':
        return this.engine.createSshServer(
          objectParams(params.server),
          optionalString(params, 'profile'),
        );
      case 'ssh/updateServer':
        return this.engine.updateSshServer(
          requiredString(params, 'name'),
          objectParams(params.server),
          optionalString(params, 'profile'),
        );
      case 'ssh/deleteServer':
        return this.engine.deleteSshServer(
          requiredString(params, 'name'),
          optionalString(params, 'profile'),
        );
      case 'ssh/testServer':
        return this.engine.testSshServer(
          requiredString(params, 'name'),
          optionalString(params, 'profile'),
        );

      case 'localTools/status':
        return this.engine.localToolsStatus();
      case 'localTools/list':
        return (await this.engine.localToolsStatus()).tools;
      case 'localTools/configure': {
        const patch: Partial<LocalToolsConfig> = {};
        const enabled = optionalBoolean(params, 'enabled');
        const shellEnabled = optionalBoolean(params, 'shellEnabled');
        const cwd = optionalString(params, 'cwd');
        const timeoutMs = optionalInteger(params, 'timeoutMs');
        const allowedRoots = optionalStringArray(params, 'allowedRoots');
        const blockedCommands = optionalStringArray(params, 'blockedCommands');
        const allowDangerous = optionalBoolean(params, 'allowDangerous');
        if (enabled !== undefined) patch.enabled = enabled;
        if (shellEnabled !== undefined) patch.shellEnabled = shellEnabled;
        if (cwd !== undefined) patch.cwd = cwd;
        if (timeoutMs !== undefined) patch.timeoutMs = timeoutMs;
        if (allowedRoots !== undefined) patch.allowedRoots = allowedRoots;
        if (blockedCommands !== undefined) patch.blockedCommands = blockedCommands;
        if (allowDangerous !== undefined) patch.allowDangerous = allowDangerous;
        const status = await this.engine.configureLocalTools(patch);
        if (status.config.enabled) {
          void this.engine.startLocalTools(optionalString(params, 'profile')).catch((error: unknown) =>
            this.log(`local tools: ${publicError(error).message}`),
          );
        }
        return status;
      }
      case 'localTools/run':
        return this.engine.runLocalTool(requiredString(params, 'tool'), params.args ?? {});
      case 'localTools/start':
        return this.engine.startLocalTools(optionalString(params, 'profile'), optionalInteger(params, 'waitMs') ?? 0);
      case 'localTools/stop':
        this.engine.stopLocalTools();
        return this.engine.localToolsStatus();
      case 'agents/list': {
        const owner = optionalString(params, 'owner');
        if (owner && owner !== 'personal' && owner !== 'shared') {
          throw new RpcFailure(-32602, 'owner must be personal or shared');
        }
        const query: AgentListQuery = {
          page: optionalInteger(params, 'page'),
          pageSize: optionalInteger(params, 'pageSize'),
          search: optionalString(params, 'search'),
          status: optionalString(params, 'status'),
          owner: owner as AgentListQuery['owner'],
          includeHarness: params.includeHarness === true,
        };
        return this.engine.listAgents(query, optionalString(params, 'profile'));
      }
      case 'history/conversations':
        return this.engine.listConversations(optionalString(params, 'profile'));
      case 'history/turns':
        return this.engine.historyTurns(
          requiredString(params, 'workflowId'),
          requiredString(params, 'interactionId'),
          optionalString(params, 'workflowName'),
          optionalString(params, 'profile'),
        );
      case 'chat/start':
        return this.startChat(params);
      case 'chat/watch': {
        // 대화 소켓 감시 — 서버 주입 턴(트리거 반응)이 chat/serverTurn
        // notification 으로 실시간 흐른다 (새로고침 불필요).
        this.engine.onConversationTurn = (turn) => this.notify('chat/serverTurn', turn);
        await this.engine.watchConversation(
          requiredString(params, 'workflowId'),
          optionalString(params, 'workflowName') ?? requiredString(params, 'workflowId'),
          requiredString(params, 'interactionId'),
          optionalString(params, 'profile'),
        );
        return { ok: true };
      }
      case 'chat/unwatch':
        this.engine.unwatchConversation(requiredString(params, 'interactionId'));
        return { ok: true };
      case 'chat/cancel': {
        const streamId = requiredString(params, 'streamId');
        const controller = this.activeChats.get(streamId);
        if (!controller) return { cancelled: false };
        controller.abort();
        return { cancelled: true };
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${method}`);
    }
  }

  private async startChat(params: Record<string, unknown>): Promise<{
    streamId: string;
    interactionId: string;
    workflowId: string;
    workflowName: string;
  }> {
    const rawInput = params.input;
    if (
      typeof rawInput !== 'string' &&
      !Array.isArray(rawInput) &&
      (!rawInput || typeof rawInput !== 'object')
    ) {
      throw new RpcFailure(-32602, 'input must be a string, object, or array');
    }
    const input: ChatInput = {
      profile: optionalString(params, 'profile'),
      workflowId: requiredString(params, 'workflowId'),
      workflowName: optionalString(params, 'workflowName'),
      interactionId: optionalString(params, 'interactionId'),
      input: rawInput as ChatInput['input'],
    };
    const resolved = await this.engine.resolveChatInput(input);
    const streamId = optionalString(params, 'streamId') ?? randomUUID();
    if (this.activeChats.has(streamId)) throw new RpcFailure(-32602, `streamId already exists: ${streamId}`);
    const controller = new AbortController();
    this.activeChats.set(streamId, controller);
    // start response가 notification보다 반드시 먼저 나가야 client가 streamId를 등록할 수 있다.
    setImmediate(() => void this.runChat(streamId, resolved, controller));
    return {
      streamId,
      interactionId: resolved.interactionId,
      workflowId: resolved.workflowId,
      workflowName: resolved.workflowName,
    };
  }

  private async runChat(
    streamId: string,
    input: ResolvedChatInput,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (const event of this.engine.chat(input, controller.signal)) {
        this.notify('chat/event', { streamId, event });
      }
      this.notify('chat/complete', { streamId, interactionId: input.interactionId });
    } catch (error) {
      const exposed = publicError(error);
      this.notify('chat/error', { streamId, error: exposed });
    } finally {
      this.activeChats.delete(streamId);
    }
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private writeError(id: RpcId, code: number, message: string, data?: unknown): void {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  private write(value: unknown): void {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(value)}\n`);
  }
}
