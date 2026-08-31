/**
 * MCPManager — hosts MCP CLIENTS to the user's LOCAL MCP servers so the XGEN
 * agents can use them THROUGH this connector (the conduit). Lives in the
 * Electron MAIN process (only main can spawn stdio subprocesses). The bridge
 * (mcp-bridge.ts) advertises the aggregated tool catalog to the XGEN backend over
 * the `/api/tools/ws/connector-mcp/{user_id}` WebSocket and answers `mcp_call`
 * frames by dispatching to `callTool` here.
 *
 * The @modelcontextprotocol/sdk is lazy-imported so a build that can't resolve
 * it still boots — MCP just reports unavailable. Ported from geny-connector.
 */
import type { McpServerConfig } from './mcp-types';
import { mcpSecretStore } from './host';
import { withResolvedSecrets } from './mcp-secrets';
import { oauthTransportOptions } from './mcp-oauth';
import { homedir } from 'os';
import {
  augmentedPath,
  buildChildEnv,
  diagnoseMissing,
  ExecNotFoundError,
  resetPathCache,
  resolveExecutable,
} from './exec-resolve';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** What we advertise to the backend (per configured, enabled server). */
export interface McpServerAdvert {
  name: string;
  connected: boolean;
  error?: string;
  tools: McpToolSchema[];
}

/** A flat tool entry advertised in the bridge `hello` frame. */
export interface AdvertisedTool {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP SDK의 Streamable HTTP 전송에 주입하는 fetch 형태. */
export type McpHttpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface McpNetworkOptions {
  httpFetch?: McpHttpFetch;
  allowPrivateCertificate?: boolean;
}

interface ServerState {
  config: McpServerConfig;
  /** 기동 중 진행 상황을 흘려보낼 곳 (테스트 화면 전용). */
  onProgress?: (lines: string[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any | null;
  tools: McpToolSchema[];
  error?: string;
  connecting?: Promise<void>;
}

/** Quote-aware split of a command line into [command, ...args]. */
function tokenize(cmd: string): string[] {
  const m = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return m.map((t) => t.replace(/^["']|["']$/g, ''));
}

/**
 * 자식 프로세스 stderr 의 마지막 몇 줄을 뽑는다.
 *
 * MCP 서버가 기동에 실패하면 SDK 는 `MCP error -32000: Connection closed` 만
 * 준다 — 진짜 원인(패키지 없음, ImportError, 인증 실패…)은 전부 자식의
 * stderr 에 있다. 그걸 버리면 사용자는 고칠 방법이 없다.
 */
export function tailLines(text: string, maxLines = 12, maxChars = 200): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .slice(-maxLines)
    .map((l) => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
}

/** 기동 실패 원인을 UI 로 실어 나르는 오류 (stderr 꼬리를 hints 로). */
export class McpStartError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[]) {
    super(message);
    this.name = 'McpStartError';
    this.hints = hints;
  }
}

/** stderr 수집기 — 꼬리 문자열 + 마지막 출력 시각(살아있음의 증거). */
interface StderrTap {
  text: () => string;
  /** 마지막으로 뭔가 출력한 시각 (Date.now). 출력이 없으면 생성 시각. */
  lastAt: () => number;
}

/**
 * transport.stderr 를 상한선(기본 64KB)까지만 모아 둔다.
 *
 * 꼬리 문자열뿐 아니라 **마지막 출력 시각**도 남긴다. 첫 실행 때 uvx/npx 는
 * 인터프리터·의존성을 수십 MB 내려받느라 오래 걸리는데, 그동안 진행 상황을
 * stderr 로 계속 뱉는다 — 이 시각이 "멈춘 게 아니라 일하는 중"의 증거다.
 */
function collectStderr(
  transport: { stderr?: NodeJS.ReadableStream | null },
  onData?: (tail: string[]) => void,
  cap = 64 * 1024,
): StderrTap {
  let buf = '';
  let last = Date.now();
  const stream = transport.stderr;
  stream?.on?.('data', (chunk: Buffer | string) => {
    buf += String(chunk);
    if (buf.length > cap) buf = buf.slice(-cap); // 무한 로그 서버 방어
    last = Date.now();
    onData?.(tailLines(buf));
  });
  return { text: () => buf, lastAt: () => last };
}

/** 진행 상황을 최대 `everyMs` 간격으로만 흘려보낸다 (다운로드 로그는 빠르다). */
export function throttle<T>(fn: (v: T) => void, everyMs: number): (v: T) => void {
  let at = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let latest: T;
  return (v: T) => {
    latest = v;
    const now = Date.now();
    if (now - at >= everyMs) {
      at = now;
      fn(latest);
      return;
    }
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      at = Date.now();
      fn(latest);
    }, everyMs - (now - at));
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSdk(): Promise<any> {
  if (_sdk) return _sdk;
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, sse, types] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      // 레거시 HTTP+SSE 전송 — 없는 빌드일 수 있어 안전하게 감싼다.
      import('@modelcontextprotocol/sdk/client/sse.js').catch(() => null),
      // tools/list_changed 알림 스키마 — 구버전 SDK 에 없을 수 있어 안전하게 감싼다.
      import('@modelcontextprotocol/sdk/types.js').catch(() => null),
    ]);
  _sdk = {
    Client,
    StdioClientTransport,
    StreamableHTTPClientTransport,
    SSEClientTransport:
      (sse as { SSEClientTransport?: unknown } | null)?.SSEClientTransport ?? null,
    ToolListChangedNotificationSchema:
      (types as { ToolListChangedNotificationSchema?: unknown } | null)
        ?.ToolListChangedNotificationSchema ?? null,
  };
  return _sdk;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

/** 진행이 멈춘 것으로 볼 무출력 시간, 그리고 그래도 넘지 않을 상한. */
export const IDLE_TIMEOUT_MS = 90_000;
export const MAX_START_MS = 15 * 60_000;

/**
 * *일하는 중이면 기다리고, 멈췄으면 끊는다.*
 *
 * 고정 20초로는 첫 실행이 절대 성공할 수 없었다 — `uvx mcp-atlassian` 은
 * CPython(24MB)과 lxml·cryptography 등을 처음 한 번 내려받는다. 그렇다고
 * 상수만 키우면 진짜 멈춘 서버를 몇 분씩 붙들게 된다.
 *
 * 그래서 **마지막 출력 시각**을 기준으로 판단한다: 뭔가 찍히고 있으면 계속
 * 기다리고(상한 `maxMs`), `idleMs` 동안 아무 출력이 없으면 멈춘 것으로 본다.
 */
export async function waitWhileProgressing<T>(
  p: Promise<T>,
  lastAt: () => number,
  label: string,
  idleMs = IDLE_TIMEOUT_MS,
  maxMs = MAX_START_MS,
): Promise<T> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, rej) => {
    const tick = () => {
      const idle = Date.now() - lastAt();
      const total = Date.now() - started;
      if (total >= maxMs) {
        return rej(new Error(`${label}: ${Math.round(maxMs / 60000)}분을 넘겨 중단했습니다`));
      }
      if (idle >= idleMs) {
        return rej(
          new Error(`${label}: ${Math.round(idleMs / 1000)}초 동안 아무 응답이 없어 중단했습니다`),
        );
      }
      // 남은 유휴 시간만큼만 자고 다시 확인한다 (출력이 오면 그만큼 밀린다).
      timer = setTimeout(tick, Math.max(250, Math.min(idleMs - idle, maxMs - total)));
    };
    timer = setTimeout(tick, Math.min(idleMs, maxMs));
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(timer!);
  }
}

export class MCPManager {
  private states = new Map<string, ServerState>();
  private httpFetch: McpHttpFetch | undefined;
  private allowPrivateCertificate = false;
  /** 서버가 도구 목록을 바꾸거나(list_changed) 죽었을 때(onclose) 카탈로그를 다시
   *  광고하도록 호출된다 (index 가 bridge.refreshCatalog 로 배선). */
  private onCatalogChange: (() => void) | undefined;

  /** 카탈로그 변경(도구 추가/제거/서버 종료) 시 재광고할 리스너를 등록한다. */
  setCatalogChangeListener(fn: (() => void) | undefined): void {
    this.onCatalogChange = fn;
  }

  /** Reconcile the configured server list into live state (drops removed,
   *  reconnects changed configs lazily). Does NOT connect yet. */
  configure(servers: McpServerConfig[] | undefined, options: McpNetworkOptions = {}): void {
    const certificatePolicyChanged =
      this.allowPrivateCertificate !== (options.allowPrivateCertificate === true);
    this.httpFetch = options.httpFetch;
    this.allowPrivateCertificate = options.allowPrivateCertificate === true;
    const next = new Map<string, McpServerConfig>();
    for (const s of servers || []) if (s && s.name) next.set(s.name, s);
    for (const [name, st] of [...this.states]) {
      const cfg = next.get(name);
      if (
        !cfg ||
        JSON.stringify(cfg) !== JSON.stringify(st.config) ||
        (certificatePolicyChanged && (st.config.transport === 'http' || st.config.transport === 'sse'))
      ) {
        void this.disconnect(name);
        this.states.delete(name);
      }
    }
    for (const [name, cfg] of next) {
      if (!this.states.has(name)) this.states.set(name, { config: cfg, client: null, tools: [] });
    }
  }

  private async connect(name: string): Promise<void> {
    const st = this.states.get(name);
    if (!st) throw new Error(`unknown MCP server: ${name}`);
    if (st.client) return;
    // 오류 문구에 내부 임시 이름(__test__…)이 새어 나가면 안 된다.
    const label = name.replace(/^__test__/, '');
    if (st.connecting) return st.connecting;
    st.connecting = (async () => {
      const {
        Client,
        StdioClientTransport,
        StreamableHTTPClientTransport,
        SSEClientTransport,
        ToolListChangedNotificationSchema,
      } = await loadSdk();
      // G8a: rehydrate secret env/headers from the encrypted keychain (config.json
      // only holds redacted values). Falls back to config for pre-migration users.
      const secrets = await mcpSecretStore.get(name).catch(() => null);
      const cfg = withResolvedSecrets(st.config, secrets);
      let transport;
      let tap: StderrTap | null = null;
      if (cfg.transport === 'stdio') {
        if (!cfg.command) throw new Error('stdio server has no command');
        // args 가 있으면(표준 JSON 가져오기) command 는 실행 파일 그 자체다 —
        // 재분해하지 않아야 공백/따옴표가 든 인자가 그대로 전달된다.
        const [command, ...args] = cfg.args?.length
          ? [cfg.command.trim(), ...cfg.args]
          : tokenize(cfg.command);
        if (!command) throw new Error('empty command');
        // GUI 로 실행된 앱은 로그인 셸 PATH 를 상속하지 않는다 → uvx/npx 를
        // 못 찾아 'spawn uvx ENOENT'. PATH 를 보강하고 실행 파일을 **절대
        // 경로로 해석**해 넘긴다 (Windows 는 .cmd/.exe 확장자까지).
        let pathStr = await augmentedPath();
        let resolved = resolveExecutable(command, pathStr);
        if (!resolved) {
          // 방금 설치했을 수 있다 — 캐시를 버리고 한 번 더 (앱 재시작 불필요).
          resetPathCache();
          pathStr = await augmentedPath();
          resolved = resolveExecutable(command, pathStr);
        }
        if (!resolved) throw new ExecNotFoundError(diagnoseMissing(command, pathStr));
        transport = new StdioClientTransport({
          command: resolved,
          args,
          env: buildChildEnv(pathStr, cfg.env),
          // 작업 디렉터리를 홈으로 고정한다. 안 정하면 앱을 어떻게 띄웠는지에
          // 따라(터미널 vs Finder/시작 메뉴) `/` 나 `C:\Windows\System32` 가
          // 되어 상대 경로 인자와 캐시 위치가 플랫폼마다 달라진다.
          cwd: homedir(),
          // 기동 실패 원인을 읽으려면 파이프여야 한다 (기본 'inherit' 는
          // Electron 콘솔로 흘려보내 사용자에게 안 보인다).
          stderr: 'pipe',
        });
        // 첫 실행은 인터프리터·의존성 내려받기로 오래 걸린다 — 진행 상황을
        // 화면으로 흘려보내야 사용자가 '멈췄나?' 하지 않는다.
        const notify = st.onProgress ? throttle(st.onProgress, 300) : undefined;
        tap = collectStderr(transport as { stderr?: NodeJS.ReadableStream | null }, notify);
      } else if (cfg.transport === 'sse') {
        if (!cfg.url) throw new Error('sse server has no url');
        if (!SSEClientTransport) throw new Error('이 빌드에서 SSE 전송을 사용할 수 없습니다.');
        transport = new SSEClientTransport(
          new URL(cfg.url),
          oauthTransportOptions(cfg, {
            requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
            fetch: this.httpFetch,
          }) as ConstructorParameters<typeof SSEClientTransport>[1],
        );
      } else {
        if (!cfg.url) throw new Error('http server has no url');
        transport = new StreamableHTTPClientTransport(
          new URL(cfg.url),
          oauthTransportOptions(cfg, {
            requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
            fetch: this.httpFetch,
          }) as ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
        );
      }
      const client = new Client({ name: 'xgen-dex', version: '1.0.0' }, { capabilities: {} });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let listed: any;
      try {
        if (tap) {
          // stdio: 출력이 계속 나오면 계속 기다린다 (첫 실행 다운로드).
          await waitWhileProgressing(client.connect(transport), tap.lastAt, `${label} 연결`);
        } else {
          await withTimeout(client.connect(transport), 20000, `${label} 연결`);
        }
        listed = await withTimeout(client.listTools(), 30000, `${label} 도구 목록`);
      } catch (e) {
        // 'Connection closed' 만으로는 고칠 수 없다 — 서버가 stderr 에 남긴
        // 진짜 원인을 함께 올린다.
        const tail = tap ? tailLines(tap.text()) : [];
        if (tail.length) {
          throw new McpStartError(
            `${(e as Error).message} — 서버가 기동하지 못했습니다. 아래 출력을 확인하세요.`,
            tail,
          );
        }
        throw e;
      }
      st.client = client;
      st.tools = (listed?.tools || []).map((t: McpToolSchema) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      st.error = undefined;

      // G5 — 서버가 런타임에 도구를 바꾸면(list_changed) 재조회 후 카탈로그를 다시
      // 광고한다. 이전에는 한 번 붙으면 도구 목록이 영구 캐시라 반영되지 않았다.
      if (ToolListChangedNotificationSchema) {
        try {
          client.setNotificationHandler(
            ToolListChangedNotificationSchema,
            async (): Promise<void> => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const relisted: any = await withTimeout(client.listTools(), 30000, `${label} 도구 재조회`);
                if (st.client !== client) return;
                st.tools = (relisted?.tools || []).map((t: McpToolSchema) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: t.inputSchema,
                }));
                this.onCatalogChange?.();
              } catch {
                /* 재조회 실패는 다음 호출에서 회복된다. */
              }
            },
          );
        } catch {
          /* 알림 핸들러를 지원하지 않는 SDK — 무시. */
        }
      }

      // G11 — 서버가 조용히 죽으면(stdio 프로세스 exit / http 종료) 상태를 무효화하고
      // 카탈로그를 다시 광고한다. 유령 도구가 카탈로그에 남아 계속 광고되던 문제를 막는다.
      client.onclose = (): void => {
        if (st.client !== client) return;
        st.client = null;
        st.tools = [];
        this.onCatalogChange?.();
      };
    })();
    try {
      await st.connecting;
    } catch (e) {
      st.error = String((e as Error).message);
      st.client = null;
      throw e;
    } finally {
      st.connecting = undefined;
    }
  }

  private async disconnect(name: string): Promise<void> {
    const st = this.states.get(name);
    if (!st) return;
    const c = st.client;
    st.client = null;
    st.tools = [];
    try {
      await c?.close?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * Connect every enabled server + return their tool catalogs.
   *
   * **병렬로** 붙는다. 순차로 붙이면 첫 실행이라 의존성을 내려받는 서버 하나가
   * 나머지 전부를 막는다 (기동 대기가 진행 상황 기반이라 몇 분까지 갈 수 있다).
   * 결과 순서는 설정 순서를 유지한다.
   */
  async advertise(): Promise<McpServerAdvert[]> {
    const targets = [...this.states].filter(([, st]) => st.config.enabled !== false);
    return Promise.all(
      targets.map(async ([name, st]): Promise<McpServerAdvert> => {
        try {
          await this.connect(name);
          return { name, connected: true, tools: st.tools };
        } catch (e) {
          return { name, connected: false, error: String((e as Error).message), tools: [] };
        }
      }),
    );
  }

  /** Flat catalog for the bridge `hello` frame (only connected servers' tools). */
  async advertisedTools(): Promise<AdvertisedTool[]> {
    const adverts = await this.advertise();
    const flat: AdvertisedTool[] = [];
    for (const a of adverts) {
      if (!a.connected) continue;
      for (const t of a.tools) {
        flat.push({ server: a.name, name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
    }
    return flat;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(name: string, tool: string, args: any): Promise<any> {
    // 턴이 도는 도중에 사용자가 이 서버를 지웠거나 로컬 MCP 스위치를 껐을 수 있다
    // (그러면 configure() 가 상태를 통째로 비운다). 그때 connect() 의
    // "unknown MCP server" 는 모델에게 **자기가 이름을 잘못 지어냈다**는 신호로
    // 읽힌다 — 같은 호출을 이름만 바꿔 반복하게 만든다. 무엇이 바뀌었는지 말해 준다.
    if (!this.states.has(name)) {
      throw new Error(
        `로컬 MCP 서버 '${name}' 가 지금은 커넥터에 없습니다 ` +
          `(설정에서 제거됐거나 로컬 MCP 스위치가 꺼졌습니다). 도구 이름 문제가 아니므로 ` +
          `재시도해도 같습니다 — 이 서버 없이 진행하거나 사용자에게 확인하세요.`,
      );
    }
    await this.connect(name);
    const st = this.states.get(name);
    if (!st?.client) throw new Error(`MCP server ${name} not connected`);
    try {
      return await withTimeout(
        st.client.callTool({ name: tool, arguments: args || {} }),
        120000,
        `callTool ${name}.${tool}`,
      );
    } catch (e) {
      // The server may have died mid-call; drop the client so the NEXT call
      // reconnects fresh instead of hanging on a stale transport.
      await this.disconnect(name);
      throw e;
    }
  }

  /** One-shot connect → list → disconnect, for the settings "테스트" button. */
  async test(
    config: McpServerConfig,
    onProgress?: (lines: string[]) => void,
  ): Promise<{ ok: boolean; tools?: McpToolSchema[]; error?: string; hints?: string[] }> {
    const tmp = `__test__${config.name || 'srv'}`;
    this.states.set(tmp, { config: { ...config, name: tmp }, client: null, tools: [], onProgress });
    try {
      await this.connect(tmp);
      const tools = this.states.get(tmp)?.tools || [];
      return { ok: true, tools };
    } catch (e) {
      const err = e as Error & { hints?: string[] };
      // 런타임 미설치(ExecNotFoundError) 는 설치 안내를, 기동 실패
      // (McpStartError) 는 서버 stderr 꼬리를 함께 돌려준다.
      const hints = Array.isArray(err.hints) && err.hints.length ? err.hints : undefined;
      return { ok: false, error: String(err.message), hints };
    } finally {
      await this.disconnect(tmp);
      this.states.delete(tmp);
    }
  }

  listServers(): McpServerConfig[] {
    return [...this.states.values()].map((s) => s.config);
  }

  async closeAll(): Promise<void> {
    for (const name of [...this.states.keys()]) await this.disconnect(name);
  }
}

let _manager: MCPManager | null = null;
export function getMcpManager(): MCPManager {
  if (!_manager) _manager = new MCPManager();
  return _manager;
}
