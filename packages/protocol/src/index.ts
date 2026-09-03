/**
 * XgenClient — the single entry point for the XGen Dex transport layer.
 *
 * ```ts
 * const xgen = new XgenClient({ baseUrl: 'https://xgen.example.com' });
 * await xgen.login('me@corp.com', 'password');   // stores token in memory
 * const { items } = await xgen.agents.list();     // my agents (agent 목록)
 * for await (const ev of xgen.chat.stream({       // chat with one, streamed
 *   workflowId: items[0].workflowId,
 *   workflowName: items[0].workflowName,
 *   input: '안녕하세요',
 *   interactionId: 'conv-1',
 * })) {
 *   if (ev.kind === 'text') process.stdout.write(ev.content);
 * }
 * ```
 *
 * Node-agnostic: the same chat stream drives agent_geny, agent_xgen and
 * agent_harness agents. The class holds tokens in memory only — persistence
 * (keychain) and base-URL config are the host's concern (Electron main).
 */
import { AgentDataApi } from './agent-data';
import { FilestoreApi } from './filestore';
import { AgentsApi } from './agents';
import { AuthApi } from './auth';
import { AvatarsApi } from './avatars';
import { ChatApi } from './chat';
import { HistoryApi } from './history';
import { PreferencesApi } from './preferences';
import { SshApi } from './ssh';
import { TeamsApi } from './teams';
import { VoiceApi } from './voice';
import { HttpClient, type FetchLike } from './client';
import type { CurrentUser, LoginResult } from './types';

export interface XgenClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  accessToken?: string;
  refreshToken?: string;
  onAuthFailure?: () => void;
  /**
   * 액세스 토큰이 **회전**될 때마다 호출된다 (로그인 / restore 의 validate 회전 /
   * ensureFreshAuth). 게이트웨이는 회전 시 **이전 토큰의 세션 키를 삭제**하므로,
   * 호스트는 이 콜백으로 keychain 을 즉시 갱신해야 다른 소비자(WS 브릿지·
   * 워크스페이스 동기화)가 폐기된 토큰으로 접속하다 403 을 맞지 않는다.
   */
  onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
}

export class XgenClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly agents: AgentsApi;
  readonly chat: ChatApi;
  readonly history: HistoryApi;
  readonly preferences: PreferencesApi;
  readonly ssh: SshApi;
  readonly teams: TeamsApi;
  readonly avatars: AvatarsApi;
  readonly voice: VoiceApi;
  readonly agentData: AgentDataApi;
  readonly filestore: FilestoreApi;

  private refreshToken?: string;
  private readonly onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
  /** ensureFreshAuth 의 single-flight 가드 — 동시 401 들이 refresh 를 한 번만 태운다. */
  private refreshing: Promise<string | null> | null = null;
  user: CurrentUser | null = null;

  constructor(opts: XgenClientOptions) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      onAuthFailure: opts.onAuthFailure,
    });
    if (opts.accessToken) this.http.setToken(opts.accessToken);
    this.refreshToken = opts.refreshToken;
    this.onTokensRotated = opts.onTokensRotated;
    this.auth = new AuthApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.chat = new ChatApi(this.http);
    this.history = new HistoryApi(this.http);
    this.preferences = new PreferencesApi(this.http);
    this.ssh = new SshApi(this.http);
    this.teams = new TeamsApi(this.http);
    this.avatars = new AvatarsApi(this.http);
    this.voice = new VoiceApi(this.http);
    this.agentData = new AgentDataApi(this.http);
    this.filestore = new FilestoreApi(this.http);
  }

  setBaseUrl(baseUrl: string): void {
    this.http.setBaseUrl(baseUrl);
  }

  setTokens(accessToken: string | null, refreshToken?: string): void {
    this.http.setToken(accessToken);
    if (refreshToken !== undefined) this.refreshToken = refreshToken;
  }

  /** Log in and adopt the returned tokens. */
  async login(email: string, password: string): Promise<LoginResult> {
    return this.adoptLogin(await this.auth.login(email, password));
  }

  /** Adopt tokens returned by an external SSO bridge and resolve full identity. */
  async adoptLogin(res: LoginResult): Promise<LoginResult> {
    this.http.setToken(res.accessToken);
    this.refreshToken = res.refreshToken;
    this.onTokensRotated?.(res.accessToken, res.refreshToken);
    this.user = {
      userId: res.userId,
      username: res.username,
      isSuperuser: false,
      roles: [],
      permissions: [],
    };
    // Resolve full identity/permissions (best-effort).
    try {
      const { user } = await this.auth.validate(res.accessToken, res.refreshToken);
      if (user) this.user = user;
    } catch {
      /* keep the minimal identity */
    }
    return res;
  }

  /**
   * Validate the current session, rotating the access token if the gateway
   * returned a fresh one. Returns true if still/again authenticated.
   */
  async restore(accessToken: string, refreshToken?: string): Promise<boolean> {
    return (await this.restoreDetailed(accessToken, refreshToken)) === 'valid';
  }

  /**
   * restore() 의 판정 세분화 — 호출자가 토큰 폐기 여부를 올바르게 정할 수
   * 있게 한다 (geny-connector validateAndRefreshAuth 강건성 이식):
   *   'valid'   — 인증 성공 (토큰 회전 반영됨)
   *   'invalid' — 서버가 **응답으로** 거부 (토큰 폐기가 맞다)
   *   'network' — 서버 미응답/네트워크 오류 (토큰을 지우면 안 된다 — 일시
   *               장애 후 재시작에서 재로그인을 강요하게 된다)
   */
  async restoreDetailed(
    accessToken: string,
    refreshToken?: string,
  ): Promise<'valid' | 'invalid' | 'network'> {
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    let sawNetworkError = false;
    try {
      const { user, newAccessToken } = await this.auth.validate(accessToken, refreshToken);
      if (newAccessToken) {
        this.http.setToken(newAccessToken);
        this.onTokensRotated?.(newAccessToken, refreshToken);
      }
      if (user) {
        this.user = user;
        return 'valid';
      }
    } catch {
      sawNetworkError = true;
    }
    // Try an explicit refresh as a fallback.
    if (refreshToken) {
      try {
        const fresh = await this.auth.refresh(refreshToken);
        if (fresh) {
          this.http.setToken(fresh);
          this.onTokensRotated?.(fresh, refreshToken);
          const { user } = await this.auth.validate(fresh, refreshToken);
          if (user) {
            this.user = user;
            return 'valid';
          }
        }
        // 서버가 응답했고 거부했다 — 명시적 invalid.
        sawNetworkError = false;
      } catch {
        sawNetworkError = true;
      }
    }
    return sawNetworkError ? 'network' : 'invalid';
  }

  getAccessTokenAfterRotation(): string {
    // The HttpClient holds the current (possibly rotated) token.
    return (this.http as unknown as { accessToken: string }).accessToken ?? '';
  }

  /**
   * 인증 실패(401/403)를 맞은 소비자가 부르는 **자가치유** 경로: refresh 토큰으로
   * 액세스 토큰을 회전시키고 새 토큰을 돌려준다. 실패(refresh 토큰 없음/거부)면
   * null — 그때는 진짜 재로그인 대상이다.
   *
   * single-flight: WS 브릿지·워크스페이스 동기화·HTTP 가 동시에 401 을 맞아도
   * refresh 는 한 번만 나간다 (게이트웨이는 refresh 마다 이전 세션을 지우므로,
   * 동시 refresh 는 서로의 새 토큰을 폐기하는 경쟁이 된다).
   *
   * ``fallbackRefreshToken`` — 인메모리에 refresh 토큰이 없을 때(재시작 직후 등)
   * 호스트가 keychain 값을 넘겨줄 수 있다.
   */
  async ensureFreshAuth(fallbackRefreshToken?: string): Promise<string | null> {
    if (this.refreshing) return this.refreshing;
    const rt = this.refreshToken ?? fallbackRefreshToken;
    if (!rt) return null;
    this.refreshing = (async () => {
      try {
        const fresh = await this.auth.refresh(rt);
        if (!fresh) return null;
        this.http.setToken(fresh);
        this.refreshToken = rt;
        this.onTokensRotated?.(fresh, rt);
        return fresh;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** The current refresh token, so the host can persist it (e.g. keychain). */
  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  async logout(): Promise<void> {
    const token = this.getAccessTokenAfterRotation();
    if (token) await this.auth.logout(token);
    this.http.setToken(null);
    this.refreshToken = undefined;
    this.user = null;
  }
}

export * from './types';
export * from './agent-data';
export * from './filestore';
export * from './agent-trigger';
export * from './notifications';
export { ApiError } from './client';
export { SseParser } from './sse';
export { frameToChatEvent } from './chat';
export { sha256Hex } from './hash';
export type { StoreAvatar } from './avatars';
// Agent ↔ Teams 다리 — 컨텍스트 봉투와 공유 출처 표식. 렌더러와 메인이 같은
// 형식을 써야 하므로 core 를 통해서만 노출한다.
export {
  TEAMS_CONTEXT_START,
  TEAMS_CONTEXT_END,
  TEAMS_CONTEXT_MAX_CHARS,
  toContextEntries,
  buildTeamsContext,
  prependTeamsContext,
  stripTeamsContext,
  formatShareHeader,
  buildSharedMessage,
  parseSharedMessage,
  shareBodyOf,
} from './teams-bridge';
export {
  TEAMS_ATTACHMENT_EXTENSIONS,
  TEAMS_ATTACHMENT_MAX_BYTES,
  teamsAttachmentRejectReason,
  directRoomNameForViewer,
} from './teams';
// SSH — 웹 마이페이지 [SSH 연동 설정] 과 **같은 저장소**를 보는 타입들.
export { EMPTY_SSH_CONFIG } from './ssh';
export type { SshServer, SshServerInput, SshConfig, SshTestResult } from './ssh';
export type {
  TeamsContextEntry,
  TeamsContextRoom,
  TeamsContextEnvelope,
  TeamsShareRef,
  ParsedSharedMessage,
} from './teams-bridge';

// ── 다운로드 센터 · 클라우드 링크 · Teams 소켓 주소 ──
// 앱 안에 박혀 있던 경로들을 여기로 올렸다. 데스크톱만 쓰는 것도 있지만, 경로가
// 앱에 있으면 다음 앱이 그것을 **복사**한다 — 이 저장소가 없애려는 바로 그 일이다.
export { InstallersApi, installerListPath, installerDownloadPath } from './installers';
export type { InstallerPackage, InstallerListResponse } from './installers';
export { CloudLinksApi, CLOUD_LINKS_PATH, cloudLinkPath } from './cloud-links';
export type { CloudLink, CloudLinksResponse } from './cloud-links';
export {
  teamsUserSocketUrl,
  teamsRoomSocketUrl,
  TEAMS_USER_SOCKET_PATH,
  teamsRoomSocketPath,
} from './teams-ws';
