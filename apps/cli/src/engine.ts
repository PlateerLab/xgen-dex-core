import { randomUUID } from 'node:crypto';
import { XgenClient } from './xgen/index';
import type { ConfigStore } from './config-store';
import { defaultLocalToolsConfig, validateProfileName, validateServerUrl } from './config-store';
import type { CredentialStore } from './credential-store';
import { DexError, isUnauthorized } from './errors';
import { LocalToolBridge, type LocalToolBridgeStatus } from './local-tool-bridge';
import { LocalToolProvider, normalizeLocalToolsConfig, type LocalToolResult, type LocalToolSchema } from './local-tools';
import type {
  Agent,
  AgentListQuery,
  AgentListResult,
  AuthStatus,
  ChatEvent,
  ChatInput,
  Conversation,
  DexProfile,
  HistoryTurn,
  LocalToolsConfig,
  ResolvedChatInput,
  StoredSession,
} from './types';

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
  tools: LocalToolSchema[];
  bridge: LocalToolBridgeStatus;
}

export interface DexEngineOptions {
  localToolProvider?: LocalToolProvider;
  localToolBridge?: LocalToolBridge;
  log?: (message: string) => void;
}

export class DexEngine {
  private clients = new Map<string, ClientRecord>();
  private readonly localTools: LocalToolProvider;
  private readonly localToolBridge: LocalToolBridge;

  constructor(
    private readonly configs: ConfigStore,
    private readonly credentials: CredentialStore,
    options: DexEngineOptions = {},
  ) {
    this.localTools = options.localToolProvider ?? new LocalToolProvider(defaultLocalToolsConfig());
    this.localToolBridge = options.localToolBridge ?? new LocalToolBridge(this.localTools, options.log);
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const config = await this.configs.read();
    return Object.entries(config.profiles)
      .map(([name, profile]) => ({ name, ...profile, current: name === config.currentProfile }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  onLocalToolsStatus(listener: (status: LocalToolBridgeStatus) => void): () => void {
    return this.localToolBridge.onStatus(listener);
  }

  async localToolsStatus(): Promise<LocalToolsStatus> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    const tools = this.localTools.schemas();
    const bridge = this.localToolBridge.status();
    if (config.enabled && !bridge.running) bridge.advertisedTools = tools.length;
    return { config, tools, bridge };
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
    this.localTools.configure(config.localTools);
    if (!config.localTools.enabled) this.localToolBridge.stop();
    else this.localToolBridge.refreshCatalog();
    return this.localToolsStatus();
  }

  async runLocalTool(tool: string, args: unknown): Promise<LocalToolResult> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    return this.localTools.call(tool, args);
  }

  async startLocalTools(requestedProfile?: string, waitMs = 0): Promise<LocalToolsStatus> {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    if (!config.enabled) {
      this.localToolBridge.stop();
      return this.localToolsStatus();
    }
    const record = await this.authenticatedRecord(requestedProfile);
    const userId = record.client.user?.userId?.trim();
    if (!userId) throw new DexError('auth_invalid', '로컬 도구 연결에 필요한 사용자 ID가 없습니다.');
    this.localToolBridge.start({
      profile: record.profile,
      serverUrl: record.serverUrl,
      userId,
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

  stopLocalTools(): void {
    this.localToolBridge.stop();
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
              detail: `로컬 도구 ${local.bridge.serverTools || local.tools.length}개 연결됨`,
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
