import WebSocket from 'ws';
import { LocalToolProvider, LOCAL_TOOL_SERVER, type LocalToolSchema } from './local-tools';

export interface LocalToolBridgeStatus {
  running: boolean;
  connected: boolean;
  catalogSynced: boolean;
  advertisedTools: number;
  serverTools: number;
  profile?: string;
  serverUrl?: string;
  userId?: string;
  error?: string;
  lastCall?: {
    tool: string;
    ok: boolean;
    durationMs: number;
    at: string;
  };
}

interface BridgeOptions {
  profile: string;
  serverUrl: string;
  userId: string;
  getToken: () => Promise<string | null>;
  refreshAuth: () => Promise<string | null>;
}

const HEARTBEAT_MS = 20_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export class LocalToolBridge {
  private socket: WebSocket | undefined;
  private options: BridgeOptions | undefined;
  private stopped = true;
  private heartbeat: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private retryMs = RETRY_MIN_MS;
  private catalogSequence = 0;
  private pendingCatalogId = '';
  private statusValue: LocalToolBridgeStatus = {
    running: false,
    connected: false,
    catalogSynced: false,
    advertisedTools: 0,
    serverTools: 0,
  };
  private readonly listeners = new Set<(status: LocalToolBridgeStatus) => void>();

  constructor(
    private readonly tools: LocalToolProvider,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  status(): LocalToolBridgeStatus {
    return structuredClone(this.statusValue);
  }

  onStatus(listener: (status: LocalToolBridgeStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  start(options: BridgeOptions): void {
    const sameTarget =
      !this.stopped &&
      this.options?.serverUrl === options.serverUrl &&
      this.options?.userId === options.userId &&
      this.options?.profile === options.profile;
    this.options = options;
    this.stopped = false;
    this.patchStatus({
      running: true,
      profile: options.profile,
      serverUrl: options.serverUrl,
      userId: options.userId,
      advertisedTools: this.tools.schemas().length,
    });
    if (sameTarget && this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) this.sendCatalog();
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) return;
    }
    this.disconnectSocket();
    this.retryMs = RETRY_MIN_MS;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.retry = undefined;
    this.heartbeat = undefined;
    this.disconnectSocket();
    this.options = undefined;
    this.statusValue = {
      running: false,
      connected: false,
      catalogSynced: false,
      advertisedTools: 0,
      serverTools: 0,
    };
    this.emit();
  }

  refreshCatalog(): void {
    this.patchStatus({ advertisedTools: this.tools.schemas().length });
    this.sendCatalog();
  }

  async waitUntilReady(timeoutMs = 3_000): Promise<LocalToolBridgeStatus> {
    if (this.statusValue.catalogSynced) return this.status();
    return new Promise((resolve) => {
      let remove = (): void => undefined;
      const timer = setTimeout(() => {
        remove();
        resolve(this.status());
      }, Math.max(0, timeoutMs));
      remove = this.onStatus((status) => {
        if (!status.catalogSynced) return;
        clearTimeout(timer);
        remove();
        resolve(status);
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.options) return;
    const options = this.options;
    const token = await options.getToken().catch(() => null);
    if (this.stopped || this.options !== options) return;
    const url = `${options.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/tools/ws/connector-mcp/${encodeURIComponent(options.userId)}`;
    this.log(`local tools bridge connecting: ${url}`);
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      maxPayload: 2_000_000,
    });
    this.socket = socket;

    socket.on('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      this.patchStatus({ error: `handshake HTTP ${status}` });
      const refresh = status === 401 || status === 403 ? options.refreshAuth() : Promise.resolve(null);
      void refresh.finally(() => {
        if (this.socket === socket) this.socket = undefined;
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.close();
        this.scheduleRetry();
      });
    });
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.retryMs = RETRY_MIN_MS;
      this.patchStatus({ connected: true, error: undefined });
      this.sendCatalog();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
      }, HEARTBEAT_MS);
    });
    socket.on('message', (raw) => void this.onMessage(String(raw)));
    socket.on('error', (error) => {
      this.patchStatus({ error: error.message });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = undefined;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = undefined;
      this.patchStatus({ connected: false, catalogSynced: false, serverTools: 0 });
      this.scheduleRetry();
    });
  }

  private sendCatalog(): void {
    const schemas = this.tools.schemas();
    this.patchStatus({ advertisedTools: schemas.length });
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const catalogId = `${Date.now()}-${++this.catalogSequence}`;
    this.pendingCatalogId = catalogId;
    const tools = schemas.map((tool: LocalToolSchema) => ({
      server: LOCAL_TOOL_SERVER,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    this.socket.send(JSON.stringify({ type: 'hello', catalog_id: catalogId, tools }));
    this.patchStatus({ catalogSynced: false, serverTools: 0 });
  }

  private async onMessage(text: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === 'ready') {
      if (message.catalog_id !== this.pendingCatalogId) return;
      this.patchStatus({
        catalogSynced: true,
        serverTools: Number.isFinite(message.tool_count) ? Math.max(0, Math.trunc(Number(message.tool_count))) : 0,
      });
      return;
    }
    if (message.type === 'ping') {
      this.socket?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (message.type !== 'mcp_call') return;
    const requestId = typeof message.request_id === 'string' ? message.request_id : '';
    const server = typeof message.server === 'string' ? message.server : '';
    const tool = typeof message.tool === 'string' ? message.tool : '';
    const startedAt = Date.now();
    let payload: Record<string, unknown>;
    try {
      if (!requestId) throw new Error('request_id is required');
      if (server !== LOCAL_TOOL_SERVER) throw new Error(`unknown local tool server: ${server}`);
      const result = await this.tools.call(tool, message.args ?? {});
      payload = { request_id: requestId, ok: true, result };
      this.patchStatus({
        lastCall: { tool, ok: true, durationMs: Date.now() - startedAt, at: new Date().toISOString() },
      });
    } catch (error) {
      payload = { request_id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
      this.patchStatus({
        lastCall: { tool, ok: false, durationMs: Date.now() - startedAt, at: new Date().toISOString() },
      });
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'mcp_result', ...payload }));
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, Math.round(this.retryMs * 1.8));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, delay);
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.removeAllListeners();
    socket.on('error', () => undefined);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
  }

  private patchStatus(patch: Partial<LocalToolBridgeStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit();
  }

  private emit(): void {
    const value = this.status();
    for (const listener of this.listeners) listener(value);
  }
}
