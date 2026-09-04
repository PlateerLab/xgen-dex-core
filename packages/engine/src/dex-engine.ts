import { randomUUID } from 'node:crypto';
import type { ConnectorDevice } from '@dex/protocol';
import { hostname } from 'node:os';
import { ConversationWatchHub, type ConversationTurn } from './conversation-watch';
import { XgenClient } from '@dex/protocol';
import type { ConfigStore } from './config-store';
import { validateProfileName, validateServerUrl } from './config-store';
import type { CredentialStore } from './credential-store';
import { DexError, isUnauthorized } from './errors';
import { getMcpBridge, type McpBridge, type McpBridgeStatus } from './mcp-bridge';
import {
  getLocalToolProvider,
  type LocalToolProvider,
  type LocalToolResult,
  type LocalToolSchema,
} from './local-tools';
import {
  dangerousApprovalFromConfig,
  normalizeLocalToolsConfig,
  toShellConfig,
  type LocalToolsConfig,
} from './local-tools-config';
import { hostPorts, bindHost, isHostBound } from './host';
import type {
  Agent,
  AgentCreateOptions,
  AgentListQuery,
  AgentListResult,
  CreateAgentInput,
  AuthStatus,
  ChatEvent,
  ChatInput,
  Conversation,
  DexProfile,
  HistoryTurn,
  ResolvedChatInput,
  StoredSession,
} from './contract';
import type {
  SshConfig,
  SshServer,
  SshServerInput,
  SshTestResult,
} from '@dex/protocol/ssh';

interface ClientRecord {
  profile: string;
  serverUrl: string;
  client: XgenClient;
  authenticated: boolean;
  persisting: Promise<void>;
}

export interface ProfileSummary extends DexProfile {
  name: string;
  current: boolean;
}

export interface LocalToolsStatus {
  config: LocalToolsConfig;
  /** 지금 **에이전트에게 노출되는** 도구. 꺼져 있으면 비어 있다. */
  tools: LocalToolSchema[];
  /** 이 기기가 제공할 수 있는 전체 목록 — 켜짐 여부와 무관. 사용자가
   *  "뭘 할 수 있지"를 물을 때의 답이다. */
  catalog: LocalToolSchema[];
  bridge: McpBridgeStatus;
}

export interface DexEngineOptions {
  localToolProvider?: LocalToolProvider;
  localToolBridge?: McpBridge;
  log?: (message: string) => void;
}

export class DexEngine {
  private clients = new Map<string, ClientRecord>();
  private readonly localTools: LocalToolProvider;
  private readonly localToolBridge: McpBridge;

  constructor(
    private readonly configs: ConfigStore,
    private readonly credentials: CredentialStore,
    options: DexEngineOptions = {},
  ) {
    this.localTools = options.localToolProvider ?? getLocalToolProvider();
    this.localToolBridge = options.localToolBridge ?? getMcpBridge();
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const config = await this.configs.read();
    return Object.entries(config.profiles)
      .map(([name, profile]) => ({ name, ...profile, current: name === config.currentProfile }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  onLocalToolsStatus(listener: (status: McpBridgeStatus) => void): () => void {
    this.localToolBridge.setStatusListener(listener);
    return () => this.localToolBridge.setStatusListener(() => undefined);
  }

  /**
   * 설정을 도구 제공자에 반영한다.
   *
   * `allowDangerous` 는 여기서 승인 포트로 바뀐다 — 물을 사람이 없는 실행에서
   * "설정으로 미리 승인했다"를 표현하는 유일한 자리다. 이미 호스트가 붙어 있으면
   * 그 포트를 유지한 채 승인 답만 덮는다(데스크톱에서 물을 수 있는 능력을
   * 설정 하나로 잃지 않게).
   */
  private applyToolConfig(config: LocalToolsConfig): void {
    this.localTools.configure(toShellConfig(config));
    const preApproved = dangerousApprovalFromConfig(config);
    if (!preApproved) return;
    const current = isHostBound() ? hostPorts() : null;
    if (!current) return;
    bindHost({
      ...current,
      interaction: { ...(current.interaction ?? {}), confirmDangerous: preApproved },
    });
  }

  async localToolsStatus(): Promise<LocalToolsStatus> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.applyToolConfig(config);
    const tools = this.localTools.advertise();
    // 상태는 브릿지가 말하는 그대로 쓴다 — 예전 CLI 는 여기서 advertisedTools 를
    // 손으로 채웠는데, 그러면 "서버가 확인한 수"와 "우리가 가진 수"가 같은 필드에
    // 섞여 카탈로그가 아직 안 붙었는데 붙은 것처럼 보였다.
    const bridge = this.localToolBridge.status();
    return { config, tools, catalog: this.localTools.catalog(), bridge };
  }

  async configureLocalTools(patch: Partial<LocalToolsConfig>): Promise<LocalToolsStatus> {
    const config = await this.configs.read();
    const current = normalizeLocalToolsConfig(config.localTools);
    config.localTools = normalizeLocalToolsConfig({
      ...current,
      ...patch,
      allowedRoots: patch.allowedRoots ?? current.allowedRoots,
      blockedCommands: patch.blockedCommands ?? current.blockedCommands,
    });
    await this.configs.write(config);
    this.applyToolConfig(config.localTools);
    if (!config.localTools.enabled) this.localToolBridge.stop();
    else this.localToolBridge.refreshCatalog();
    return this.localToolsStatus();
  }

  async runLocalTool(tool: string, args: unknown): Promise<LocalToolResult> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.applyToolConfig(config);
    return this.localTools.callTool(tool, args);
  }

  async startLocalTools(requestedProfile?: string, waitMs = 0): Promise<LocalToolsStatus> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.applyToolConfig(config);
    if (!config.enabled) {
      this.localToolBridge.stop();
      return this.localToolsStatus();
    }
    const record = await this.authenticatedRecord(requestedProfile);
    const userId = record.client.user?.userId?.trim();
    if (!userId) throw new DexError('auth_invalid', '로컬 도구 연결에 필요한 사용자 ID가 없습니다.');
    this.localToolBridge.start({
      serverUrl: record.serverUrl,
      userId,
      // CLI 는 사내 인증서를 아직 설정으로 받지 않는다 — 기본은 검증이다.
      allowPrivateCertificate: false,
      // 멀티 디바이스 — 데스크톱 앱과 같은 계정으로 붙어도 서로를 밀어내지 않는다.
      deviceId: await this.ensureDeviceId(),
      deviceName: `${hostname()} · CLI`,
      getToken: async () => {
        await this.flush(record);
        return record.client.getAccessTokenAfterRotation() || (await this.credentials.get(record.profile))?.accessToken || null;
      },
      refreshAuth: async () => {
        const session = await this.credentials.get(record.profile);
        const token = await record.client.ensureFreshAuth(session?.refreshToken);
        await this.flush(record);
        return token;
      },
    });
    if (waitMs > 0) await this.localToolBridge.waitUntilReady(waitMs);
    return this.localToolsStatus();
  }

  /** 이 설치의 안정적 기기 id — 커넥터 멀티 디바이스 슬롯 키. 설정에 영속. */
  private async ensureDeviceId(): Promise<string> {
    const config = await this.configs.read();
    if (config.deviceId) return config.deviceId;
    const id = randomUUID();
    await this.configs.write({ ...config, deviceId: id });
    return id;
  }

  /** 연결된 커넥터 기기 목록 — Local PC MCP 상태 대시보드. */
  async listConnectorDevices(requestedProfile?: string): Promise<ConnectorDevice[]> {
    const record = await this.authenticatedRecord(requestedProfile);
    return record.client.connectorDevices.list();
  }

  stopLocalTools(): void {
    this.localToolBridge.stop();
  }

  // ── 대화 소켓 감시 (서버 주입 턴 실시간 수신) ────────────────────

  /** 호스트(rpc 서버/TUI)가 설정 — 감시 중인 대화의 서버 push 완결 턴. */
  onConversationTurn: ((turn: ConversationTurn) => void) | null = null;
  private conversationHub: ConversationWatchHub | null = null;

  /** 대화 소켓 감시 시작 — Job/sub-agent 트리거의 반응 턴이 실시간으로
   *  onConversationTurn 에 흐른다 (새로고침 불필요). */
  async watchConversation(
    workflowId: string,
    workflowName: string,
    interactionId: string,
    requestedProfile?: string,
  ): Promise<void> {
    const record = await this.authenticatedRecord(requestedProfile);
    if (!this.conversationHub) {
      this.conversationHub = new ConversationWatchHub((turn) => {
        this.onConversationTurn?.(turn);
      });
    }
    this.conversationHub.setDeps({
      baseUrl: () => record.serverUrl,
      token: async () => {
        await this.flush(record);
        return (
          record.client.getAccessTokenAfterRotation() ||
          (await this.credentials.get(record.profile))?.accessToken ||
          null
        );
      },
      allowPrivateCertificate: () => false,
    });
    this.conversationHub.watch(workflowId, workflowName, interactionId);
  }

  unwatchConversation(interactionId: string): void {
    this.conversationHub?.unwatch(interactionId);
  }

  // ── SSH ───────────────────────────────────────────────────────────
  //
  // 개인 SSH 서버 목록은 XGEN 계정에 있고 접속은 서버가 연다 — 이 기기에서
  // 닿는지는 에이전트에게 아무 의미가 없다. 그래서 여기는 얇은 통과 계층이고,
  // 검증(이름 규칙 · 점프 그래프 · 자격증명 유무)은 전부 서버가 한다.
  //
  // 비밀번호와 개인키는 응답에 실리지 않는다. 쓰기는 부분 수정이라 보내지 않은
  // 자격증명은 유지되고 빈 문자열로만 지워진다 — 설명만 고치려던 저장이 접속을
  // 끊으면 안 된다.

  async sshConfig(profile?: string): Promise<SshConfig> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.getConfig();
  }

  async setSshEnabled(enabled: boolean, profile?: string): Promise<SshConfig> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.setEnabled(enabled);
  }

  async createSshServer(input: SshServerInput, profile?: string): Promise<SshServer> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.createServer(input);
  }

  async updateSshServer(
    name: string,
    input: SshServerInput,
    profile?: string,
  ): Promise<SshServer> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.updateServer(name, input);
  }

  async deleteSshServer(name: string, profile?: string): Promise<SshConfig> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.deleteServer(name);
  }

  /** 서버가 점프 경로를 그대로 타고 실제로 접속해 본다. 마스터 스위치와 무관하다 —
   *  켜기 전에 맞는지 확인할 수 있어야 한다. */
  async testSshServer(name: string, profile?: string): Promise<SshTestResult> {
    const record = await this.authenticatedRecord(profile);
    return record.client.ssh.testServer(name);
  }

  async setProfile(nameInput: string, serverUrlInput: string): Promise<ProfileSummary> {
    const name = validateProfileName(nameInput);
    const serverUrl = validateServerUrl(serverUrlInput);
    const config = await this.configs.read();
    const previous = config.profiles[name];
    config.profiles[name] = { serverUrl };
    if (!config.profiles[config.currentProfile]) config.currentProfile = name;
    await this.configs.write(config);
    this.clients.delete(name);
    if (name === config.currentProfile && previous?.serverUrl !== serverUrl) this.localToolBridge.stop();
    if (previous && previous.serverUrl !== serverUrl) await this.credentials.delete(name);
    return { name, serverUrl, current: name === config.currentProfile };
  }

  async useProfile(nameInput: string): Promise<ProfileSummary> {
    const name = validateProfileName(nameInput);
    const config = await this.configs.read();
    const profile = config.profiles[name];
    if (!profile) throw new DexError('not_found', `프로필을 찾을 수 없습니다: ${name}`);
    config.currentProfile = name;
    await this.configs.write(config);
    this.localToolBridge.stop();
    return { name, ...profile, current: true };
  }

  async login(email: string, password: string, requestedProfile?: string): Promise<AuthStatus> {
    if (!email.trim() || !password) throw new DexError('usage_error', '이메일과 비밀번호가 필요합니다.');
    const { name, profile } = await this.resolveProfile(requestedProfile);
    this.clients.delete(name);
    const record = this.createClient(name, profile.serverUrl);
    const result = await record.client.login(email.trim(), password);
    const session: StoredSession = {
      serverUrl: profile.serverUrl,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
    await this.credentials.set(name, session);
    await this.flush(record);
    record.authenticated = true;
    return {
      profile: name,
      serverUrl: profile.serverUrl,
      authenticated: true,
      user: record.client.user ?? undefined,
    };
  }

  async authStatus(requestedProfile?: string): Promise<AuthStatus> {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (!session || session.serverUrl !== profile.serverUrl) {
      return {
        profile: name,
        serverUrl: profile.serverUrl,
        authenticated: false,
        reason: 'missing_session',
      };
    }

    try {
      const record = await this.ensureAuthenticated(name, profile.serverUrl, session);
      return {
        profile: name,
        serverUrl: profile.serverUrl,
        authenticated: true,
        user: record.client.user ?? undefined,
      };
    } catch (error) {
      if (error instanceof DexError && error.code === 'network_error') {
        return {
          profile: name,
          serverUrl: profile.serverUrl,
          authenticated: false,
          reason: 'network',
        };
      }
      if (error instanceof DexError && (error.code === 'auth_required' || error.code === 'auth_invalid')) {
        return {
          profile: name,
          serverUrl: profile.serverUrl,
          authenticated: false,
          reason: 'invalid_session',
        };
      }
      throw error;
    }
  }

  async logout(requestedProfile?: string): Promise<void> {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (session?.serverUrl === profile.serverUrl) {
      const record = this.createClient(name, profile.serverUrl);
      record.client.setTokens(session.accessToken, session.refreshToken);
      await record.client.logout().catch(() => {});
    }
    await this.credentials.delete(name);
    this.clients.delete(name);
    this.localToolBridge.stop();
  }

  async listAgents(query: AgentListQuery = {}, requestedProfile?: string): Promise<AgentListResult> {
    return this.withAuthRetry(requestedProfile, (client) => client.agents.list(query));
  }

  /**
   * 만들기 화면이 그릴 것 — 프로바이더·모델과 손댈 수 있는 설정.
   *
   * 목록은 서버가 Agent XGeny 노드에서 읽어 내려 준다. 커넥터와 CLI 가 각자 적어
   * 두면 노드가 바뀔 때마다 조용히 낡는다.
   */
  async agentCreateOptions(requestedProfile?: string): Promise<AgentCreateOptions> {
    return this.withAuthRetry(requestedProfile, (client) => client.agents.createOptions());
  }

  /**
   * 에이전트 하나를 세운다 — Agent XGeny 노드 하나짜리 워크플로우.
   *
   * 엣지가 없는 것이 이 노드의 성질이다. 도구도 기억도 위임도 자기진화도 그 안에
   * 있어서 연결 없이 그대로 대화가 된다.
   */
  async createAgent(
    input: CreateAgentInput,
    requestedProfile?: string,
  ): Promise<{ workflowId: string; workflowName: string }> {
    const name = input.name.trim();
    if (!name) throw new DexError('usage_error', '에이전트 이름이 필요합니다.');
    if (!input.provider) throw new DexError('usage_error', 'AI 제공사가 필요합니다.');
    return this.withAuthRetry(requestedProfile, (client) =>
      client.agents.create({ ...input, name }),
    );
  }

  async listConversations(requestedProfile?: string): Promise<Conversation[]> {
    return this.withAuthRetry(requestedProfile, (client) => client.history.conversations());
  }

  async historyTurns(
    workflowId: string,
    interactionId: string,
    workflowName?: string,
    requestedProfile?: string,
  ): Promise<HistoryTurn[]> {
    if (!workflowId || !interactionId) {
      throw new DexError('usage_error', 'workflowId와 interactionId가 필요합니다.');
    }
    return this.withAuthRetry(requestedProfile, (client) =>
      client.history.turns(workflowId, interactionId, workflowName),
    );
  }

  async resolveChatInput(input: ChatInput): Promise<ResolvedChatInput> {
    const workflowId = input.workflowId.trim();
    if (!workflowId) throw new DexError('usage_error', 'Agent workflow ID가 필요합니다.');
    const { name } = await this.resolveProfile(input.profile);
    const workflowName = input.workflowName?.trim() || (await this.findAgent(workflowId, name)).workflowName;
    return {
      profile: name,
      workflowId,
      workflowName,
      input: input.input,
      interactionId: input.interactionId?.trim() || randomUUID(),
    };
  }

  async *chat(input: ChatInput, signal?: AbortSignal): AsyncGenerator<ChatEvent, ResolvedChatInput> {
    const resolved = await this.resolveChatInput(input);
    let record = await this.authenticatedRecord(resolved.profile);
    let emitted = false;

    try {
      const local = await this.startLocalTools(resolved.profile, 3_000);
      if (local.config.enabled) {
        yield local.bridge.catalogSynced
          ? {
              kind: 'status',
              surface: 'connector_local',
              detail: `로컬 도구 ${local.bridge.serverToolCount || local.tools.length}개 연결됨`,
            }
          : {
              kind: 'status',
              surface: 'connector_local',
              detail: local.bridge.error || '로컬 도구 카탈로그 연결 대기 중',
              reason: 'bridge_not_ready',
            };
      }
    } catch (error) {
      yield {
        kind: 'status',
        surface: 'connector_local',
        detail: `로컬 도구 연결 실패: ${error instanceof Error ? error.message : String(error)}`,
        reason: 'bridge_error',
      };
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for await (const event of record.client.chat.stream(
          {
            workflowId: resolved.workflowId,
            workflowName: resolved.workflowName,
            input: resolved.input,
            interactionId: resolved.interactionId,
            // 이 표면(CLI/VSCode)의 기기 — 멀티 디바이스에서 내 도구가 주입되게.
            clientDeviceId: await this.ensureDeviceId(),
          },
          signal,
        )) {
          emitted = true;
          yield event;
        }
        return resolved;
      } catch (error) {
        if (attempt === 0 && !emitted && isUnauthorized(error)) {
          await this.refresh(record);
          record = await this.authenticatedRecord(resolved.profile);
          continue;
        }
        throw error;
      }
    }
    return resolved;
  }

  private async findAgent(selector: string, profile: string): Promise<Agent> {
    const agents = await this.withAuthRetry(profile, (client) => client.agents.listAll({}, 100));
    const normalized = selector.trim().toLocaleLowerCase();
    const found =
      agents.find((agent) => agent.workflowId === selector.trim()) ??
      agents.find((agent) => agent.workflowName.toLocaleLowerCase() === normalized);
    if (!found) throw new DexError('not_found', `Agent를 찾을 수 없습니다: ${selector}`);
    return found;
  }

  private async withAuthRetry<T>(
    requestedProfile: string | undefined,
    operation: (client: XgenClient) => Promise<T>,
  ): Promise<T> {
    const record = await this.authenticatedRecord(requestedProfile);
    try {
      return await operation(record.client);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.refresh(record);
      return operation(record.client);
    }
  }

  private async authenticatedRecord(requestedProfile?: string): Promise<ClientRecord> {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (!session || session.serverUrl !== profile.serverUrl) {
      throw new DexError('auth_required', `로그인이 필요합니다: dex login --profile ${name}`);
    }
    return this.ensureAuthenticated(name, profile.serverUrl, session);
  }

  private async ensureAuthenticated(
    name: string,
    serverUrl: string,
    session: StoredSession,
  ): Promise<ClientRecord> {
    const cached = this.clients.get(name);
    if (cached?.authenticated && cached.serverUrl === serverUrl) return cached;
    const record = cached?.serverUrl === serverUrl ? cached : this.createClient(name, serverUrl);
    const state = await record.client.restoreDetailed(session.accessToken, session.refreshToken);
    await this.flush(record);
    if (state === 'valid') {
      record.authenticated = true;
      return record;
    }
    if (state === 'invalid') {
      await this.credentials.delete(name);
      this.clients.delete(name);
      throw new DexError('auth_invalid', `세션이 만료되었습니다: dex login --profile ${name}`);
    }
    throw new DexError('network_error', `XGEN 서버에 연결할 수 없습니다: ${serverUrl}`);
  }

  private createClient(profile: string, serverUrl: string): ClientRecord {
    const existing = this.clients.get(profile);
    if (existing?.serverUrl === serverUrl) return existing;

    const record = {
      profile,
      serverUrl,
      authenticated: false,
      persisting: Promise.resolve(),
    } as ClientRecord;
    record.client = new XgenClient({
      baseUrl: serverUrl,
      onTokensRotated: (accessToken, refreshToken) => {
        record.persisting = record.persisting.then(() =>
          this.credentials.set(profile, { serverUrl, accessToken, refreshToken }),
        );
      },
    });
    this.clients.set(profile, record);
    return record;
  }

  private async refresh(record: ClientRecord): Promise<void> {
    const session = await this.credentials.get(record.profile);
    const accessToken = await record.client.ensureFreshAuth(session?.refreshToken);
    await this.flush(record);
    if (!accessToken) {
      await this.credentials.delete(record.profile);
      record.authenticated = false;
      throw new DexError('auth_invalid', `세션이 만료되었습니다: dex login --profile ${record.profile}`);
    }
    record.authenticated = true;
  }

  private async flush(record: ClientRecord): Promise<void> {
    await record.persisting;
  }

  private async resolveProfile(requested?: string): Promise<{ name: string; profile: DexProfile }> {
    const config = await this.configs.read();
    const name = requested ? validateProfileName(requested) : config.currentProfile;
    const profile = config.profiles[name];
    if (!profile) {
      throw new DexError(
        'config_invalid',
        `XGEN 서버 프로필이 없습니다. 먼저 실행하세요: dex profile set ${name} --server <URL>`,
      );
    }
    return { name, profile };
  }
}
