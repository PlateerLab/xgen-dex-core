/**
 * MCP OAuth 2.1 (PKCE) support (G8b).
 *
 * An http/sse MCP server with `auth: 'oauth'` gets an OAuthClientProvider wired
 * into its transport. The provider stores tokens/client-info/PKCE-verifier in the
 * encrypted keychain (mcpOAuthStore). Two modes:
 *
 *   • SILENT (regular connect, mcp-manager): loads existing tokens and lets the
 *     SDK auto-refresh them. If interactive authorization is required, it does
 *     NOT pop a browser — the connect simply fails with "authorization required"
 *     and the UI shows an "Authorize" button.
 *   • INTERACTIVE (authorizeMcpServer, user clicks Authorize): opens the system
 *     browser to the authorization URL, runs a loopback HTTP server to catch the
 *     redirect, and completes the code exchange via transport.finishAuth().
 *
 * The SDK (@modelcontextprotocol/sdk) does discovery, dynamic client
 * registration, PKCE, code exchange and refresh; we only provide storage + the
 * browser/loopback glue.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig } from './config';
import { mcpOAuthStore } from './keychain';
import type { McpHttpFetch } from './mcp-manager';

// The SDK's OAuth types are structural; we keep them loose to avoid a hard
// compile dep on deep SDK type paths (the runtime shapes are what matter).
type OAuthClientProviderLike = {
  get redirectUrl(): string;
  get clientMetadata(): Record<string, unknown>;
  state?(): string | undefined;
  clientInformation(): Promise<unknown> | unknown;
  saveClientInformation(info: unknown): Promise<void> | void;
  tokens(): Promise<unknown> | unknown;
  saveTokens(tokens: unknown): Promise<void> | void;
  redirectToAuthorization(url: URL): Promise<void> | void;
  saveCodeVerifier(v: string): Promise<void> | void;
  codeVerifier(): Promise<string> | string;
  invalidateCredentials?(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> | void;
};

const CLIENT_NAME = 'XGen Dex';
const AUTH_TIMEOUT_MS = 5 * 60_000;

/** An OAuthClientProvider backed by the encrypted keychain. */
export class ConnectorOAuthProvider implements OAuthClientProviderLike {
  constructor(
    private readonly server: string,
    private readonly port: number,
    private readonly interactive: boolean,
    private readonly onRedirect?: (url: URL) => Promise<void> | void,
    private readonly stateValue?: string,
  ) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  /** OAuth2 state (CSRF) — only the interactive flow sets one; verified at the
   *  loopback callback before the code is accepted. */
  state(): string | undefined {
    return this.stateValue;
  }

  get clientMetadata(): Record<string, unknown> {
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async clientInformation(): Promise<unknown> {
    return (await mcpOAuthStore.load(this.server)).clientInformation;
  }
  async saveClientInformation(info: unknown): Promise<void> {
    await mcpOAuthStore.patch(this.server, { clientInformation: info });
  }
  async tokens(): Promise<unknown> {
    return (await mcpOAuthStore.load(this.server)).tokens;
  }
  async saveTokens(tokens: unknown): Promise<void> {
    await mcpOAuthStore.patch(this.server, { tokens });
  }
  async saveCodeVerifier(v: string): Promise<void> {
    await mcpOAuthStore.patch(this.server, { codeVerifier: v });
  }
  async codeVerifier(): Promise<string> {
    const s = await mcpOAuthStore.load(this.server);
    if (!s.codeVerifier) throw new Error('PKCE code_verifier 가 없습니다 (재인증이 필요합니다).');
    return s.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    // Silent connects must never pop a browser; failing with UnauthorizedError
    // (thrown by the SDK after this returns) is the intended "needs auth" signal.
    if (!this.interactive) return;
    if (this.onRedirect) await this.onRedirect(url);
  }

  /** SDK self-heal: on InvalidGrant/registration errors the SDK asks us to drop
   *  the stale credential so the next attempt re-registers / re-authorizes. */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    if (scope === 'all') {
      await mcpOAuthStore.clear(this.server);
      return;
    }
    await mcpOAuthStore.patch(this.server, {
      ...(scope === 'client' ? { clientInformation: undefined } : {}),
      ...(scope === 'tokens' ? { tokens: undefined } : {}),
      ...(scope === 'verifier' ? { codeVerifier: undefined } : {}),
    });
  }
}

/** A silent provider for regular connects (loads tokens, auto-refresh, no UI). */
export function makeSilentOAuthProvider(server: string): ConnectorOAuthProvider {
  return new ConnectorOAuthProvider(server, 0, false);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

interface Loopback {
  server: http.Server;
  port: number;
  code: Promise<string>;
  cancel: () => void;
}

/** Loopback listener that resolves with the authorization code once the browser
 *  redirects back. `expectedState` is verified (CSRF / code-injection guard). */
function startLoopback(expectedState: string): Promise<Loopback> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    let settled = false;
    const code = new Promise<string>((res, rej) => {
      resolveCode = (c) => {
        settled = true;
        res(c);
      };
      rejectCode = (e) => {
        settled = true;
        rej(e);
      };
    });
    // Never leave this promise unhandled (early-return paths don't await it).
    code.catch(() => {});
    const server = http.createServer((req, res) => {
      let u: URL;
      try {
        u = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const authCode = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state') || '';
      // CSRF / auth-code injection: the state must match what we issued.
      const stateOk = gotState === expectedState;
      const ok = !!authCode && !err && stateOk;
      const message = ok
        ? '이 창을 닫고 XGen Dex로 돌아가세요.'
        : !stateOk
          ? '보안 검증(state)에 실패했습니다. 다시 시도하세요.'
          : escapeHtml(err || '인가 코드가 없습니다.');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">` +
          `<h2>${ok ? '인증 완료' : '인증 실패'}</h2><p>${message}</p></body></html>`,
      );
      if (ok) resolveCode(authCode as string);
      else if (!stateOk) rejectCode(new Error('OAuth state 불일치 (CSRF 방지).'));
      else rejectCode(new Error(err || '인가 코드가 없습니다.'));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const timer = setTimeout(() => {
        if (!settled) rejectCode(new Error('인증 시간 초과 (5분).'));
      }, AUTH_TIMEOUT_MS);
      void code.finally(() => clearTimeout(timer));
      const cancel = () => {
        clearTimeout(timer);
        if (!settled) rejectCode(new Error('인증이 취소되었습니다.'));
      };
      resolve({ server, port, code, cancel });
    });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 시간 초과 (${Math.round(ms / 1000)}초).`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function loadTransportsAndError(): Promise<{
  SSEClientTransport: any;
  StreamableHTTPClientTransport: any;
  UnauthorizedError: any;
  Client: any;
}> {
  const [{ Client }, { StreamableHTTPClientTransport }, sse, auth] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/client/sse.js').catch(() => null),
    import('@modelcontextprotocol/sdk/client/auth.js').catch(() => null),
  ]);
  return {
    Client,
    StreamableHTTPClientTransport,
    SSEClientTransport: (sse as { SSEClientTransport?: unknown } | null)?.SSEClientTransport ?? null,
    UnauthorizedError: (auth as { UnauthorizedError?: unknown } | null)?.UnauthorizedError ?? Error,
  };
}

/** Attach an OAuth provider to a transport option bag when the server uses OAuth. */
export function oauthTransportOptions(
  cfg: McpServerConfig,
  base: { requestInit?: RequestInit; fetch?: McpHttpFetch },
): { requestInit?: RequestInit; fetch?: McpHttpFetch; authProvider?: unknown } {
  if (cfg.auth !== 'oauth') return base;
  return { ...base, authProvider: makeSilentOAuthProvider(cfg.name) as unknown };
}

/** Run the interactive OAuth authorization for a server. Opens the browser, runs
 *  a loopback listener, and completes the token exchange. */
/** Map cryptic SDK OAuth errors to actionable Korean guidance (no-DCR, discovery). */
function friendlyOAuthError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const low = msg.toLowerCase();
  if (low.includes('registration') || low.includes('register client') || low.includes('dynamic client')) {
    return `이 서버는 동적 클라이언트 등록(DCR)을 지원하지 않는 것으로 보입니다. 사전 등록된 client_id 를 요구하는 서버는 현재 커넥터로 자동 인가할 수 없습니다. (원인: ${msg})`;
  }
  if (low.includes('.well-known') || low.includes('metadata') || low.includes('discover')) {
    return `OAuth 메타데이터(.well-known)를 찾지 못했습니다 — 이 URL 이 OAuth 를 지원하는 MCP 엔드포인트가 맞는지 확인하세요. (원인: ${msg})`;
  }
  return msg;
}

export async function authorizeMcpServer(
  cfg: McpServerConfig,
  opts: { fetch?: McpHttpFetch; openExternal?: (url: string) => Promise<void> } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (cfg.transport !== 'sse' && cfg.transport !== 'http') {
    return { ok: false, error: 'OAuth 는 http/sse 서버에서만 지원됩니다.' };
  }
  if (!cfg.url) return { ok: false, error: '서버 URL 이 없습니다.' };

  const openExternal =
    opts.openExternal ??
    (async (url: string) => {
      const { shell } = await import('electron');
      await shell.openExternal(url);
    });

  const state = randomBytes(24).toString('base64url');
  const loop = await startLoopback(state);
  try {
    const { SSEClientTransport, StreamableHTTPClientTransport, UnauthorizedError, Client } =
      await loadTransportsAndError();
    // Fresh authorization: drop old PKCE/tokens AND client registration so DCR
    // re-runs with THIS session's loopback redirect_uri (avoids a stale port).
    await mcpOAuthStore.patch(cfg.name, {
      codeVerifier: undefined,
      tokens: undefined,
      clientInformation: undefined,
    });

    const provider = new ConnectorOAuthProvider(
      cfg.name,
      loop.port,
      true,
      (url) => openExternal(url.toString()),
      state,
    );
    const url = new URL(cfg.url);
    const mkTransport = () =>
      cfg.transport === 'sse'
        ? SSEClientTransport
          ? new SSEClientTransport(url, { authProvider: provider, fetch: opts.fetch })
          : null
        : new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: opts.fetch });

    const transport = mkTransport();
    if (!transport) return { ok: false, error: '이 빌드에서 SSE 전송을 사용할 수 없습니다.' };

    const client = new Client({ name: 'xgen-dex', version: '1.0.0' }, { capabilities: {} });
    try {
      // If we already have valid/refreshable tokens, this connects straight away.
      // Bounded so a stalled discovery/registration can't hang forever.
      await withTimeout(client.connect(transport), 60_000, 'OAuth 연결');
      await client.close();
      return { ok: true };
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) {
        return { ok: false, error: friendlyOAuthError(e) };
      }
      // The browser was opened by redirectToAuthorization — wait for the code.
    }

    const code = await loop.code; // already bounded by the loopback 5-min timer
    await withTimeout(transport.finishAuth(code), 60_000, 'OAuth 토큰 교환');
    // Verify with a fresh transport that now has tokens.
    const verifyTransport = mkTransport();
    const verifyClient = new Client({ name: 'xgen-dex', version: '1.0.0' }, { capabilities: {} });
    try {
      if (verifyTransport) {
        await withTimeout(verifyClient.connect(verifyTransport), 60_000, 'OAuth 검증');
        await verifyClient.close();
      }
    } catch {
      /* token saved; a verify hiccup shouldn't fail the authorization */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyOAuthError(e) };
  } finally {
    loop.cancel();
    loop.server.close();
  }
}

/** Whether a server currently has stored OAuth tokens. */
export async function hasOAuthTokens(server: string): Promise<boolean> {
  const s = await mcpOAuthStore.load(server);
  return !!s.tokens;
}

/** Forget a server's OAuth tokens/registration (user "sign out"). */
export async function clearOAuth(server: string): Promise<void> {
  await mcpOAuthStore.clear(server);
}
