import { GeneratedContentApi } from './generated-content';
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
 * Node-agnostic: the same chat stream drives agent_geny and agent_xgen
 * agents. The class holds tokens in memory only — persistence
 * (keychain) and base-URL config are the host's concern (Electron main).
 */
import { AgentDataApi } from './agent-data';
import { ChatFilesApi } from './chat-files';
import { FilestoreApi } from './filestore';
import { ConnectorDevicesApi } from './connector-devices';
import { ConversationFoldersApi } from './conversation-folders';
import { ConversationModelApi } from './conversation-model';
import { DecisionApi } from './decision';
import { AgentsApi } from './agents';
import { AuthApi } from './auth';
import { AvatarsApi } from './avatars';
import { ChatApi } from './chat';
import { ChatGuardrailsApi } from './chat-guardrails';
import { FeedbackApi } from './feedback';
import { HistoryApi } from './history';
import { IdeApi } from './ide';
import { ChatSharesApi } from './shares';
import { PreferencesApi } from './preferences';
import { SshApi } from './ssh';
import { TeamsApi } from './teams';
import { VoiceApi } from './voice';
import { ApiError, HttpClient, type FetchLike, type HttpClientOptions } from './client';
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
   * 대화 소켓)가 폐기된 토큰으로 접속하다 403 을 맞지 않는다.
   */
  onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
  /** 조각 업로드의 이어 올리기 기록(재시작 후에도 이어 올린다). 없으면 프로세스 안에서만. */
  uploadStore?: HttpClientOptions['uploadStore'];
  /** React Native: `{ uri }` 파일을 범위로 읽는 소스로 바꾼다 — 있으면 큰 파일도 조각으로 올린다. */
  uriSource?: HttpClientOptions['uriSource'];
}

/**
 * 서버가 **응답으로** 거부했는가 — 만료·위조 토큰이면 게이트웨이가 401/403 으로 답한다.
 * 이것을 네트워크 오류로 치면 restore 가 'network' 를 돌려 앱이 오프라인으로 보고
 * 자동 로그인도 건너뛴다(2026-10-15 dev-xgen 만료 토큰에서 재현). 408·429·5xx 는
 * 일시 장애라 토큰을 지키도록 네트워크 쪽으로 둔다.
 */
function rejectedByServer(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

export class XgenClient {
  readonly http: HttpClient;
  readonly auth: AuthApi;
  readonly agents: AgentsApi;
  readonly chat: ChatApi;
  readonly generatedContent: GeneratedContentApi;
  readonly guardrails: ChatGuardrailsApi;
  readonly feedback: FeedbackApi;
  readonly history: HistoryApi;
  readonly preferences: PreferencesApi;
  readonly ssh: SshApi;
  readonly teams: TeamsApi;
  readonly avatars: AvatarsApi;
  readonly voice: VoiceApi;
  readonly agentData: AgentDataApi;
  readonly filestore: FilestoreApi;
  /** 답에 딸린 파일(파일 저장소의 결과물·API 응답 임시 파일) 받기. */
  readonly chatFiles: ChatFilesApi;
  readonly connectorDevices: ConnectorDevicesApi;
  /** 대화의 폴더 — 서버 사본(어느 화면에서든 보이고 쓰인다). */
  readonly conversationFolders: ConversationFoldersApi;
  /** 대화의 모델 — 채팅 입력창 옆 선택기(다음 답변부터, 세션 재시작 없음). */
  readonly conversationModel: ConversationModelApi;
  /** 채팅의 [IDE] 보기 — 편집기·터미널·찾기·소스 제어. */
  readonly ide: IdeApi;
  /** 채팅 공유: 대화를 그 시점까지 얼린 링크(/api/chat/shares). */
  readonly chatShares: ChatSharesApi;
  /** 판단 모델(System One) — 선택지별 확률만 돌려주는 빠른 판단. */
  readonly decision: DecisionApi;

  private refreshToken?: string;
  private readonly onTokensRotated?: (accessToken: string, refreshToken?: string) => void;
  /** ensureFreshAuth 의 single-flight 가드 — 동시 401 들이 refresh 를 한 번만 태운다. */
  private refreshing: Promise<string | null> | null = null;
  private restoring: {
    accessToken: string;
    refreshToken?: string;
    generation: number;
    promise: Promise<'valid' | 'invalid' | 'network'>;
  } | null = null;
  private authGeneration = 0;
  private loggedOut = false;
  private readonly fetch?: FetchLike;
  user: CurrentUser | null = null;

  constructor(opts: XgenClientOptions) {
    this.fetch = opts.fetch;
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      onAuthFailure: opts.onAuthFailure,
      uploadStore: opts.uploadStore,
      uriSource: opts.uriSource,
    });
    if (opts.accessToken) this.http.setToken(opts.accessToken);
    this.refreshToken = opts.refreshToken;
    this.onTokensRotated = opts.onTokensRotated;
    this.auth = new AuthApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.chat = new ChatApi(this.http);
    this.generatedContent = new GeneratedContentApi(this.http);
    this.guardrails = new ChatGuardrailsApi(this.http);
    this.feedback = new FeedbackApi(this.http);
    this.history = new HistoryApi(this.http);
    this.preferences = new PreferencesApi(this.http);
    this.ssh = new SshApi(this.http);
    this.teams = new TeamsApi(this.http);
    this.avatars = new AvatarsApi(this.http);
    this.voice = new VoiceApi(this.http);
    this.agentData = new AgentDataApi(this.http);
    this.filestore = new FilestoreApi(this.http);
    this.chatFiles = new ChatFilesApi(this.http);
    this.connectorDevices = new ConnectorDevicesApi(this.http);
    this.conversationFolders = new ConversationFoldersApi(this.http);
    this.conversationModel = new ConversationModelApi(this.http);
    this.ide = new IdeApi(this.http);
    this.chatShares = new ChatSharesApi(this.http);
    this.decision = new DecisionApi(this.http);
  }

  setBaseUrl(baseUrl: string): void {
    const previous = this.http.getBaseUrl();
    this.http.setBaseUrl(baseUrl);
    if (previous !== this.http.getBaseUrl()) {
      this.authGeneration++;
      this.refreshing = null;
    }
  }

  private beginAuth(): number {
    this.loggedOut = false;
    this.refreshing = null;
    return ++this.authGeneration;
  }

  /** Revocation must keep the original server even if this client is rebound. */
  private revoker(): AuthApi {
    return new AuthApi(new HttpClient({ baseUrl: this.http.getBaseUrl(), fetch: this.fetch }));
  }

  private supersededAuthError(): Error {
    const error = new Error('Authentication superseded');
    // Hosts preserve credentials for cancellation, rather than treating it as
    // a rejected password or an invalid server session.
    error.name = 'AbortError';
    return error;
  }

  setTokens(accessToken: string | null, refreshToken?: string): void {
    this.beginAuth();
    this.http.setToken(accessToken);
    if (refreshToken !== undefined) this.refreshToken = refreshToken;
  }

  /** Log in and adopt the returned tokens. */
  async login(email: string, password: string): Promise<LoginResult> {
    const generation = this.beginAuth();
    const revoker = this.revoker();
    const result = await revoker.login(email, password);
    return this.adopt(result, generation, revoker);
  }

  /** Adopt tokens returned by an external SSO bridge and resolve full identity. */
  async adoptLogin(res: LoginResult): Promise<LoginResult> {
    return this.adopt(res, this.beginAuth(), this.revoker());
  }

  private async adopt(res: LoginResult, generation: number, revoker: AuthApi): Promise<LoginResult> {
    if (generation !== this.authGeneration) {
      await revoker.logout(res.accessToken, res.refreshToken);
      throw this.supersededAuthError();
    }
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
      const { user } = await revoker.validate(res.accessToken, res.refreshToken);
      if (generation === this.authGeneration && user) this.user = user;
    } catch {
      /* keep the minimal identity */
    }
    if (generation !== this.authGeneration) {
      await revoker.logout(res.accessToken, res.refreshToken);
      throw this.supersededAuthError();
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
   *               장애 후 재시작에서 재로그인을 강요하게 된다). 다른 인증
   *               작업으로 취소된 복원도 이 보존 판정을 쓴다 — 서버 거부가 아니다.
   */
  async restoreDetailed(
    accessToken: string,
    refreshToken?: string,
  ): Promise<'valid' | 'invalid' | 'network'> {
    const pending = this.restoring;
    if (pending?.generation === this.authGeneration &&
      pending.accessToken === accessToken && pending.refreshToken === refreshToken) {
      return pending.promise;
    }
    const generation = this.beginAuth();
    const promise = this.restoreCurrent(accessToken, refreshToken, generation);
    this.restoring = { accessToken, refreshToken, generation, promise };
    try {
      return await promise;
    } finally {
      if (this.restoring?.promise === promise) this.restoring = null;
    }
  }

  private async restoreCurrent(
    accessToken: string,
    refreshToken: string | undefined,
    generation: number,
  ): Promise<'valid' | 'invalid' | 'network'> {
    const auth = this.revoker();
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    let sawNetworkError = false;
    try {
      const { user, newAccessToken } = await auth.validate(accessToken, refreshToken);
      if (generation !== this.authGeneration) return 'network';
      if (newAccessToken) {
        this.http.setToken(newAccessToken);
        this.onTokensRotated?.(newAccessToken, refreshToken);
      }
      if (user) {
        this.user = user;
        return 'valid';
      }
    } catch (err) {
      if (generation !== this.authGeneration) return 'network';
      sawNetworkError = !rejectedByServer(err);
    }
    // Try an explicit refresh as a fallback.
    if (refreshToken) {
      try {
        const fresh = await auth.refresh(refreshToken);
        if (generation !== this.authGeneration) return 'network';
        if (fresh) {
          this.http.setToken(fresh);
          this.onTokensRotated?.(fresh, refreshToken);
          const { user } = await auth.validate(fresh, refreshToken);
          if (generation !== this.authGeneration) return 'network';
          if (user) {
            this.user = user;
            return 'valid';
          }
        }
        // 서버가 응답했고 거부했다 — 명시적 invalid.
        sawNetworkError = false;
      } catch (err) {
        if (generation !== this.authGeneration) return 'network';
        sawNetworkError = !rejectedByServer(err);
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
   * single-flight: WS 브릿지·대화 소켓·HTTP 가 동시에 401 을 맞아도
   * refresh 는 한 번만 나간다 (게이트웨이는 refresh 마다 이전 세션을 지우므로,
   * 동시 refresh 는 서로의 새 토큰을 폐기하는 경쟁이 된다).
   *
   * ``fallbackRefreshToken`` — 인메모리에 refresh 토큰이 없을 때(재시작 직후 등)
   * 호스트가 keychain 값을 넘겨줄 수 있다.
   */
  async ensureFreshAuth(fallbackRefreshToken?: string): Promise<string | null> {
    if (this.loggedOut) return null;
    if (this.refreshing) return this.refreshing;
    const generation = this.authGeneration;
    const rt = this.refreshToken ?? fallbackRefreshToken;
    if (!rt) return null;
    this.refreshing = (async () => {
      try {
        const fresh = await this.auth.refresh(rt);
        if (!fresh || generation !== this.authGeneration) return null;
        this.http.setToken(fresh);
        this.refreshToken = rt;
        this.onTokensRotated?.(fresh, rt);
        return fresh;
      } catch {
        return null;
      } finally {
        if (generation === this.authGeneration) this.refreshing = null;
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
    const refreshToken = this.refreshToken;
    const revoker = this.revoker();
    this.authGeneration++;
    this.loggedOut = true;
    this.refreshing = null;
    this.http.setToken(null);
    this.refreshToken = undefined;
    this.user = null;
    await revoker.logout(token, refreshToken);
  }
}

export * from './errors';
export * from './types';
export * from './agent-data';
export * from './agent-inspect';
export * from './agent-workflow';
export * from './file-view';
export * from './chat-files';
export * from './turn-files';
export * from './workspace-copy';
export * from './resumable-upload';
export * from './sha256';
export * from './app-card';
export * from './shares';
export * from './filestore';
export * from './agent-trigger';
export * from './connector-devices';
export * from './conversation-folders';
export * from './conversation-folder-sync';
// 사용자 PC 접속(UserPc)의 기기 쪽 약속과 휴대폰·브라우저의 내장 셸.
export * from './user-pc-shell';
export * from './connector-deadline';
export * from './conversation-model';
// 대화 목록(2026-10-09): 마지막으로 말한 순서, 제목·꼬리표, 목록 규칙. 모든 앱이 같은 모양으로 그린다.
export * from './conversation-list';
export * from './conversation-search';
export * from './conversation-agents';
export * from './notifications';
// 도구 과정 표시 규칙(칩 단계 · 호출 한 건 한 행 · 건수) — 앱과 웹이 같은 답을 내도록.
export * from './tool-activity';
// 작업 과정 타임라인 규칙 — 데스크톱·웹이 같은 단계와 같은 도구 이름표를 그린다.
export * from './process-timeline';
// 답의 첫 글자 전 준비 단계(turn_phase). 모든 앱이 같은 줄을 같은 경계로 그린다.
export * from './turn-phases';
// 끝난 턴의 작업 과정을 기기에 남겨 두고 되붙이는 규칙 — 데스크톱·웹이 같은 대화를 같게 본다.
export * from './turn-process-memory';
// 답변 피드백(별점·문제 유형) — 웹 채팅과 같은 서버 계약.
export * from './feedback';
// 채팅 안전 장치 — 면책 문구 설정과 민감정보 검사(둘 다 서버가 정한다).
export * from './chat-guardrails';
export { ApiError } from './client';
export type { HttpClientOptions, UploadFileData, UploadFormPart, UploadOptions } from './client';
export { SseParser } from './sse';
export { frameToChatEvent, turnEventToChatEvent } from './chat';
export { STREAM_IDLE_MS, TURN_EVENT_NAMES, TURN_MESSAGE_TYPES, parseSubscribed } from './chat';
// 도는 턴에 넣은 사용자 메시지 — 결말(steer 이벤트)과 히스토리의 steers.
export { parseSteerOutcome, parseHistorySteers, splitBySteers } from './chat';
export type { SteerPart } from './chat';
export type { LiveTurnSnapshot, SubscribedState } from './chat';
// 다른 화면에서 도는 턴 — 질문 본문·첨부, 진행분의 작업 과정. 앱·웹이 같은 모양으로 그린다.
export { liveTurnFlow, liveTurnProcess } from './chat';
export type { LiveProcessItem } from './chat';
// 서버가 실행 기록에서 되살린 작업 과정 — 이력과 대화 소켓의 완결 행이 같은 모양으로 싣는다.
export { turnInputText, turnAttachments, toHistoryProcess, genyHistoryWorkspacePath } from './history';
export type { TurnAttachment } from './history';
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

// ── 다운로드 센터 · Teams 소켓 주소 ──
// 앱 안에 박혀 있던 경로들을 여기로 올렸다. 데스크톱만 쓰는 것도 있지만, 경로가
// 앱에 있으면 다음 앱이 그것을 **복사**한다 — 이 저장소가 없애려는 바로 그 일이다.
export { InstallersApi, installerListPath, installerDownloadPath } from './installers';
export type { InstallerPackage, InstallerListResponse } from './installers';
export { IdeApi, ideTerminalSocketPath, ideFailureOf, workspaceChangeSocketPath } from './ide';
export type {
  IdeSessionResponse,
  IdeFileResponse,
  IdeSaveRequest,
  IdeSaveResponse,
  IdeStorageEntry,
  IdeFailure,
} from './ide';
export {
  teamsUserSocketUrl,
  teamsRoomSocketUrl,
  TEAMS_USER_SOCKET_PATH,
  teamsRoomSocketPath,
} from './teams-ws';
export {
  DEFAULT_VOICE_REPLY_STYLE,
  VOICE_CONTEXT_END,
  VOICE_CONTEXT_START,
  prependVoiceContext,
  stripVoiceContext,
} from './voice-context';

export * from './generated-content';
