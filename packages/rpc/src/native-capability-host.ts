import {
  DexError,
  getLocalToolProvider,
  LOCAL_SERVER,
  NativeHostSession,
  nativeKeyScope,
  type ConfigStore,
  type NativeAgentSocketTransport,
  type NativeCapabilityController,
  type NativeCapabilityCallContext,
  type NativeCapabilitySnapshot,
  type NativeCapabilityTool,
  type NativeDeviceKeyStore,
} from '@dex/engine';
import type { NativeCapabilityNotification, NativeRpcResult } from './wire';

export interface TrustedNativeCapabilityTools {
  tools: readonly NativeCapabilityTool[] | (() => readonly NativeCapabilityTool[]);
  call(server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal,
    context: NativeCapabilityCallContext): Promise<unknown>;
}

export interface NativeCapabilityHostOptions {
  keys: NativeDeviceKeyStore;
  fetch?: typeof fetch;
  expectedUserId?: string;
  socket?: (origin: string) => NativeAgentSocketTransport;
  capabilityTools?: TrustedNativeCapabilityTools;
}

interface Connection {
  readonly generation: number;
  readonly profile: string;
  readonly origin: string;
  readonly userId: string;
  readonly control: AbortController;
  readonly controller: NativeCapabilityController;
  readonly consumed: Set<string>;
}
interface PendingConnection { control: AbortController; done: Promise<void>; finish(): void }

interface CapabilitySession {
  connectCapabilities: NativeHostSession['connectCapabilities'];
  settleProofOperations(): Promise<void>;
}

const CLOSED: NativeCapabilitySnapshot = Object.freeze({ state: 'closed', confirmation: null });

/** Owns long-lived native capability sockets without retaining the short RPC request guard. */
export class NativeCapabilityRpcHost {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingConnection>();
  private generation = 0;
  private closed = false;
  private draining: Promise<void> = Promise.resolve();

  constructor(private readonly configs: ConfigStore,
    private readonly notify: (value: NativeCapabilityNotification) => void,
    private readonly options: NativeCapabilityHostOptions,
    private readonly platform: 'vscode' | 'desktop',
    private readonly sessionFactory: (origin: string, socket?: NativeAgentSocketTransport) => CapabilitySession
      = (origin, socket) => new NativeHostSession(origin, platform, options.keys, options.fetch,
        options.expectedUserId, socket)) {}

  handles(method: string): boolean {
    return ['native/connect-capabilities', 'native/capability-status', 'native/confirm-capability',
      'native/disconnect-capabilities'].includes(method);
  }

  async request(method: string, params: Record<string, unknown>): Promise<NativeRpcResult> {
    if (this.closed) throw new DexError('auth_required', '네이티브 호스트가 종료되었습니다.');
    if (method === 'native/confirm-capability') return this.confirm(params);
    exactFields(params, ['profile', 'user_id']);
    const target = await this.target(params);
    if (method === 'native/connect-capabilities') return this.connect(target);
    if (method === 'native/capability-status') return this.result(target, this.connections.get(target.key)?.controller.snapshot() ?? CLOSED);
    if (method === 'native/disconnect-capabilities') {
      await this.disconnect(target.key);
      return this.result(target, CLOSED);
    }
    throw new DexError('usage_error', '지원하지 않는 native capability 요청입니다.');
  }

  cancel(): void { void this.stop(); }

  async stop(): Promise<void> {
    const pending = [...this.pending.values()];
    for (const item of pending) item.control.abort();
    this.pending.clear();
    const current = [...this.connections.values()];
    this.connections.clear();
    for (const connection of current) connection.control.abort();
    const closing = Promise.all([
      ...pending.map((item) => item.done),
      ...current.map((connection) => connection.controller.close().catch(() => undefined)),
    ]).then(() => undefined);
    this.draining = Promise.all([this.draining, closing]).then(() => undefined);
    await this.draining;
  }

  close(): void { this.closed = true; this.cancel(); }

  private async connect(target: Target): Promise<NativeRpcResult> {
    const socket = this.options.socket?.(target.origin);
    if (socket && !socket.openCapabilities) {
      throw new DexError('protocol_mismatch', '이 네이티브 호스트는 capability 연결을 지원하지 않습니다.');
    }
    await this.disconnect(target.key);
    const generation = ++this.generation;
    const control = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const pending: PendingConnection = { control, done, finish };
    this.pending.set(target.key, pending);
    const session = this.sessionFactory(target.origin, socket);
    let buffered: NativeCapabilitySnapshot | null = null;
    let controller: NativeCapabilityController | undefined;
    try {
      const tools = this.tools();
      controller = await session.connectCapabilities(target.userId, {
        tools: tools.tools,
        call: tools.call,
        onChange: (snapshot) => {
          const owned = this.connections.get(target.key);
          if (!owned || owned.generation !== generation) { buffered = snapshot; return; }
          this.notify(this.notice(owned, snapshot));
        },
      }, control.signal);
      control.signal.throwIfAborted();
      const current = await this.target({ profile: target.profile, user_id: target.userId });
      control.signal.throwIfAborted();
      if (current.key !== target.key || current.origin !== target.origin) throw new DexError('auth_required', 'capability 연결 중 프로필 범위가 바뀌었습니다.');
      const connection: Connection = { generation, profile: target.profile, origin: target.origin,
        userId: target.userId, control, controller, consumed: new Set() };
      this.connections.set(target.key, connection);
      if (buffered) this.notify(this.notice(connection, buffered));
      return this.result(target, controller.snapshot());
    } catch (error) {
      control.abort();
      if (controller) await controller.close().catch(() => undefined);
      throw error;
    } finally {
      pending.finish();
      if (this.pending.get(target.key) === pending) this.pending.delete(target.key);
      this.draining = Promise.all([this.draining, session.settleProofOperations()]).then(() => undefined);
    }
  }

  private async confirm(params: Record<string, unknown>): Promise<NativeRpcResult> {
    exactFields(params, ['request_id', 'confirmed']);
    const requestId = requiredText(params, 'request_id');
    if (typeof params.confirmed !== 'boolean') throw new DexError('usage_error', 'capability 확인 결정을 확인하세요.');
    const matches = [...this.connections.values()].filter((connection) => {
      const snapshot = connection.controller.snapshot();
      return snapshot.state === 'confirmation_required' && snapshot.confirmation?.requestId === requestId;
    });
    if (matches.length !== 1) throw new DexError('not_found', '현재 확인 중인 capability 요청을 찾을 수 없습니다.');
    const connection = matches[0]!;
    if (connection.consumed.has(requestId)) throw new DexError('not_found', '이미 처리한 capability 확인 요청입니다.');
    // Latch before any await: two concurrent UI decisions must never both reach the socket.
    connection.consumed.add(requestId);
    if (connection.consumed.size > 256) connection.consumed.delete(connection.consumed.values().next().value!);
    const target = await this.target({ profile: connection.profile, user_id: connection.userId });
    if (target.origin !== connection.origin || this.connections.get(target.key) !== connection) {
      throw new DexError('auth_required', 'capability 확인 요청의 현재 소유자를 확인할 수 없습니다.');
    }
    const confirmation = connection.controller.snapshot().confirmation;
    const confirmed = params.confirmed && !!confirmation && confirmation.expiresAt > Date.now() / 1000;
    await connection.controller.confirm(requestId, confirmed);
    return this.result(target, connection.controller.snapshot());
  }

  private async disconnect(key: string): Promise<void> {
    const pending = this.pending.get(key);
    pending?.control.abort(); this.pending.delete(key);
    if (pending) await pending.done;
    const connection = this.connections.get(key);
    if (!connection) return;
    this.connections.delete(key); connection.control.abort();
    const closing = connection.controller.close().catch(() => undefined);
    this.draining = Promise.all([this.draining, closing]).then(() => undefined);
    await closing;
  }

  private tools(): { tools: readonly NativeCapabilityTool[]; call: TrustedNativeCapabilityTools['call'] } {
    if (this.options.capabilityTools) {
      const trusted = this.options.capabilityTools;
      return { tools: typeof trusted.tools === 'function' ? trusted.tools() : trusted.tools,
        call: trusted.call.bind(trusted) };
    }
    const provider = getLocalToolProvider();
    const tools = provider.catalog().flatMap((tool): NativeCapabilityTool[] => {
      const schema = tool.inputSchema;
      if (!schema || schema.type !== 'object') return [];
      return [{ server: LOCAL_SERVER, name: tool.name, ...(tool.description ? { description: Array.from(tool.description).slice(0, 1200).join('') } : {}), inputSchema: schema }];
    });
    return { tools, call: async (server, tool, args, signal, context) => {
      if (server !== LOCAL_SERVER) throw new DexError('usage_error', '광고하지 않은 capability 서버입니다.');
      signal.throwIfAborted();
      return provider.callTool(tool, args, { interactionId: context.agentSessionId, remote: true,
        originName: 'XGEN Agent Session', signal });
    } };
  }

  private async target(params: Record<string, unknown>): Promise<Target> {
    const profile = requiredText(params, 'profile');
    const userId = requiredText(params, 'user_id');
    if (this.options.expectedUserId !== undefined && userId !== this.options.expectedUserId) {
      throw new DexError('auth_required', '현재 앱에 로그인한 계정만 사용할 수 있습니다.');
    }
    const config = await this.configs.read();
    const configured = config.profiles[profile];
    if (!configured) throw new DexError('not_found', 'HTTPS 서버 프로필을 먼저 설정하세요.');
    const origin = nativeKeyScope({ origin: configured.serverUrl, platform: this.platform, userId }).origin;
    return { key: `${profile}\u0000${userId}`, profile, userId, origin };
  }

  private result(target: Target, snapshot: NativeCapabilitySnapshot): NativeRpcResult {
    return { platform_type: this.platform, profile: target.profile, server_url: target.origin,
      user_id: target.userId, capability_connection: snapshot };
  }

  private notice(connection: Connection, snapshot: NativeCapabilitySnapshot): NativeCapabilityNotification {
    return { platform_type: this.platform, profile: connection.profile, server_url: connection.origin,
      user_id: connection.userId, view: 'capabilities', snapshot };
  }
}

interface Target { key: string; profile: string; origin: string; userId: string }

function requiredText(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value || value.length > 1024) {
    throw new DexError('usage_error', '네이티브 요청의 필수 문자열을 확인하세요.');
  }
  return value;
}

function exactFields(params: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(params).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in params))) {
    throw new DexError('usage_error', '지원하지 않는 네이티브 요청 항목입니다.');
  }
}
