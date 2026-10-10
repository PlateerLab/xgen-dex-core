/**
 * XD 의 main API — 화면이 IPC 로 부르는 일들. Electron 을 모른다(시험이 그대로 부른다).
 *
 * 에이전트를 만들면 작업 공간 폴더(`<루트>/workspace/<이름>`)도 만든다. 지울 때 그 폴더는 남긴다(사용자 파일) —
 * 엔진 상태(`.xd/agents/<id>`: 기억·도구 결과)만 지운다. 대화를 지우면 그 대화의 대화 기록(STM)도 지운다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CliName } from './cli/detect';
import { checkLinkedFolder, UNSAFE_FOLDER, type LinkedFolderCheck } from './linked-folders';
import { withResolvedSecrets } from '@dex/engine/mcp-secrets';
import {
  cleanMcpServers,
  engineServer,
  McpConfigError,
  mcpSecretId,
  parseMcpSecrets,
  splitMcpSecrets,
  type McpSecretsByName,
  type McpServerConfig,
} from './mcp-config';
import type { CliService, CliState } from './cli/service';
import type { EngineService, McpTestResult, ModelsResult } from './engine-service';
import type { Secrets, SecretStatus } from './secrets';
import type { XdAccount, XdAgent, XdConversation, XdConversationListItem, XdConversationSearchHit, Store, XdTurn } from './store';
import type { TurnRunner } from './turn-runner';
import { uniqueFolderName } from './workspace-name';

/** 계정 종류 — v1 제공자(DESIGN §2-4). OpenAI 호환은 Ollama·LM Studio(기본 주소가 있다)와 그 밖(vLLM 등, 주소 필수). */
export const ACCOUNT_KINDS = ['anthropic', 'openai', 'google', 'ollama', 'lmstudio', 'openai_compatible', 'claude_code', 'codex'] as const;

/** 계정 종류 → 모델 목록을 물을 런타임 제공자(model_discovery). */
const DISCOVERY_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  openai_compatible: 'vllm',
};

/** Claude Code 는 모델 목록 명령이 없다 — 판에 상관없는 별칭을 쓴다. */
const CLAUDE_CODE_MODELS = ['sonnet', 'opus', 'haiku'];

/** Codex 가 로그인·실행 뒤 홈에 두는 모델 캐시에서 보이는 것만. 없으면 빈 목록(이름을 직접 쓴다). */
export function codexCachedModels(home: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as {
      models?: Array<{ slug?: string; visibility?: string }>;
    };
    return (parsed.models ?? []).filter((m) => m.slug && m.visibility !== 'hide').map((m) => String(m.slug));
  } catch {
    return [];
  }
}

const CLI_OF_KIND: Record<string, CliName> = { claude_code: 'claude', codex: 'codex' };
const KIND_OF_CLI: Record<CliName, string> = { claude: 'claude_code', codex: 'codex' };
const CLI_LABEL: Record<CliName, string> = { claude: 'Claude Code', codex: 'Codex' };
const isCliName = (name: unknown): name is CliName => name === 'claude' || name === 'codex';

export interface XdApiDeps {
  store: Store;
  secrets: Secrets;
  runner: TurnRunner;
  engine: Pick<EngineService, 'info' | 'running'> & {
    models?: EngineService['models'];
    mcpTest?: EngineService['mcpTest'];
    mcpClose?: EngineService['mcpClose'];
  };
  cli?: CliService;
  /** `<루트>/workspace` */
  workspaceDir: string;
  /** `<루트>/.xd` */
  stateDir: string;
  allowFakeProvider?: boolean;
}

export type AccountView = XdAccount & { hasSecret: boolean };

export interface AgentInput {
  name: string;
  description?: string;
  systemPrompt?: string | null;
  accountId?: string | null;
  model?: string;
  folders?: string[];
  memory?: boolean;
  options?: Record<string, unknown>;
}

const text = (value: unknown, what: string, max = 200): string => {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`${what} is required`);
  if (s.length > max) throw new Error(`${what} is too long`);
  return s;
};

/** 화면이 까닭을 알아야 하는 실패 — `code` 가 IPC 로 그대로 간다. */
export class XdError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const stringList = (value: unknown, what: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${what} must be a list of strings`);
  return value as string[];
};

export function createXdApi(deps: XdApiDeps) {
  const { store, secrets, runner } = deps;
  const kinds = new Set<string>([...ACCOUNT_KINDS, ...(deps.allowFakeProvider ? ['xd_fake'] : [])]);
  const view = (a: XdAccount): AccountView => ({ ...a, hasSecret: secrets.has(a.id) });
  const checkAccount = (id: string | null | undefined) => {
    if (id && !store.getAccount(id)) throw new Error(`no account ${id}`);
  };

  /** 연결 폴더 — 위험한 것(.xd 안·.xd 를 품은 곳·상대 경로)은 저장하지 않는다. 겹친 것은 한 번. */
  const linkedFolders = async (value: unknown): Promise<string[]> => {
    const out: string[] = [];
    for (const raw of stringList(value, 'folders')) {
      const check = await checkLinkedFolder(raw, deps.stateDir);
      if (UNSAFE_FOLDER.has(check.status)) throw new XdError(`folder_${check.status}`, `cannot link ${raw}: ${check.status}`);
      if (!out.includes(check.path)) out.push(check.path);
    }
    return out;
  };

  /**
   * options 의 MCP 서버를 검사하고 비밀(env·headers 값)을 갈라 낸다 — 저장할 options 에는 키만 남는다. 값이 빈 칸이면
   * 저장된 비밀을 그대로 둔다(화면은 저장된 값을 모른다).
   */
  const splitMcp = (agentId: string | null, options: Record<string, unknown>) => {
    if (!('mcpServers' in options)) return { options, mcpSecrets: undefined };
    let servers: McpServerConfig[];
    try {
      servers = cleanMcpServers(options.mcpServers);
    } catch (err) {
      if (err instanceof McpConfigError) throw new XdError(err.code, err.message);
      throw err;
    }
    const stored = agentId ? parseMcpSecrets(secrets.get(mcpSecretId(agentId))) : null;
    const split = splitMcpSecrets(servers, stored);
    return { options: { ...options, mcpServers: split.servers }, mcpSecrets: split.secrets };
  };
  const saveMcpSecrets = (agentId: string, value: McpSecretsByName | undefined) => {
    if (value === undefined) return;
    secrets.set(mcpSecretId(agentId), Object.keys(value).length ? JSON.stringify(value) : null);
  };

  const cli = (name: unknown): CliService => {
    if (!deps.cli) throw new Error('CLI management is not available');
    if (!isCliName(name)) throw new Error(`unknown CLI ${String(name)}`);
    return deps.cli;
  };

  /** 이 종류·주소·키로 모델 목록을 묻는다 — 연결 시험도 겸한다. */
  async function models(kind: string, baseUrl: string | null, secret: string | null): Promise<ModelsResult> {
    if (kind === 'claude_code') return { ok: true, models: CLAUDE_CODE_MODELS.map((id) => ({ id })) };
    if (kind === 'codex') {
      const ids = deps.cli ? codexCachedModels(deps.cli.home('codex')) : [];
      return ids.length ? { ok: true, models: ids.map((id) => ({ id })) } : { ok: false, models: [], error: 'not_cached' };
    }
    const provider = DISCOVERY_PROVIDER[kind];
    if (!provider || !deps.engine.models) return { ok: false, models: [], error: `no model list for ${kind}` };
    return deps.engine.models({ provider, apiKey: secret, baseUrl });
  }

  return {
    // ── 에이전트 ──
    agentsList: (): XdAgent[] => store.listAgents(),
    agentsGet: (id: string): XdAgent | null => store.getAgent(id),
    async agentsCreate(input: AgentInput): Promise<XdAgent> {
      const name = text(input?.name, 'name', 100);
      checkAccount(input.accountId);
      const folders = await linkedFolders(input.folders);
      const workspace = uniqueFolderName(
        name,
        (candidate) => store.workspaceTaken(candidate) || existsSync(join(deps.workspaceDir, candidate)),
      );
      const { options, mcpSecrets } = splitMcp(null, input.options && typeof input.options === 'object' ? input.options : {});
      mkdirSync(join(deps.workspaceDir, workspace), { recursive: true });
      const created = store.createAgent({
        name,
        workspace,
        description: typeof input.description === 'string' ? input.description : '',
        systemPrompt: input.systemPrompt === undefined ? null : input.systemPrompt,
        accountId: input.accountId ?? null,
        model: typeof input.model === 'string' ? input.model : '',
        folders,
        memory: input.memory !== false,
        options,
      });
      saveMcpSecrets(created.id, mcpSecrets);
      return created;
    },
    async agentsUpdate(id: string, patch: Partial<AgentInput>): Promise<XdAgent> {
      if (patch.name !== undefined) patch.name = text(patch.name, 'name', 100);
      if (patch.folders !== undefined) patch.folders = await linkedFolders(patch.folders);
      checkAccount(patch.accountId);
      let mcpSecrets: McpSecretsByName | undefined;
      if (patch.options && typeof patch.options === 'object') ({ options: patch.options, mcpSecrets } = splitMcp(id, patch.options));
      const updated = store.updateAgent(id, patch as Partial<XdAgent>);
      saveMcpSecrets(id, mcpSecrets);
      return updated;
    },
    /**
     * MCP 서버 [연결 확인] — 붙어 보고 도구 목록만 받는다. 저장하기 전 입력도 시험할 수 있고, 값이 빈 비밀은 그
     * 에이전트에 저장된 것을 쓴다.
     */
    async mcpTest(input: { server: unknown; agentId?: string | null }): Promise<McpTestResult> {
      let server: McpServerConfig;
      try {
        [server] = cleanMcpServers([input?.server]);
      } catch (err) {
        if (err instanceof McpConfigError) throw new XdError(err.code, err.message);
        throw err;
      }
      if (!deps.engine.mcpTest) return { ok: false, tools: [], error: 'engine unavailable' };
      const stored = input.agentId ? parseMcpSecrets(secrets.get(mcpSecretId(input.agentId))) : null;
      const { previousName, ...config } = server;
      const saved = (previousName ? stored?.[previousName] : undefined) ?? stored?.[config.name] ?? null;
      return deps.engine.mcpTest(engineServer(withResolvedSecrets(config, saved), 'test'));
    },
    /** 연결 폴더의 지금 상태 — 고를 때 바로, 그리고 채팅·편집 화면이 없어진 폴더를 알리려고. */
    foldersCheck: (paths: string[]): Promise<LinkedFolderCheck[]> =>
      Promise.all(stringList(paths, 'paths').map((p) => checkLinkedFolder(p, deps.stateDir))),
    agentsDelete(id: string): void {
      if (runner.isAgentRunning(id)) throw new Error('this agent has a turn running');
      store.deleteAgent(id);
      rmSync(join(deps.stateDir, 'agents', id), { recursive: true, force: true });
      secrets.set(mcpSecretId(id), null);
      deps.engine.mcpClose?.(id);
    },

    // ── 대화 ──
    /** 한 에이전트의 대화(옛 화면·시험이 쓴다). 사이드바는 conversationsListAll. */
    conversationsList: (agentId: string): XdConversation[] => store.listConversations(agentId),
    /** 모든 에이전트의 대화를 마지막으로 말한 순서로(사이드바의 대화 목록). */
    conversationsListAll(limit?: number): XdConversationListItem[] {
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) throw new Error('limit must be a positive number');
      return store.listAllConversations(limit);
    },
    /** 채팅 검색: 제목·에이전트 이름·질문·답, 마지막으로 말한 순서(규칙은 @dex/protocol conversation-search). */
    conversationsSearch(query: string, limit?: number): { hits: XdConversationSearchHit[]; hasMore: boolean } {
      if (typeof query !== 'string') throw new Error('query must be a string');
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) throw new Error('limit must be a positive number');
      return store.searchConversations(query.slice(0, 200), Math.min(limit ?? 30, 100));
    },
    /** 이름 바꾸기. 빈 이름이면 첫 질문으로 정한 제목으로 돌아간다. 목록 순서는 그대로다. */
    conversationsRename(id: string, title: string): XdConversation {
      if (typeof title !== 'string') throw new Error('title must be a string');
      const wanted = title.trim();
      if (wanted.length > 200) throw new Error('title is too long');
      const renamed = store.renameConversation(text(id, 'id'), wanted);
      if (!renamed) throw new Error(`no conversation ${id}`);
      return renamed;
    },
    conversationsDelete(id: string): void {
      const conversation = store.getConversation(id);
      if (!conversation) return;
      if (runner.isRunning(id)) throw new Error('this conversation has a turn running');
      store.deleteConversation(id);
      rmSync(join(deps.stateDir, 'agents', conversation.agentId, 'memory', 'sessions', id), { recursive: true, force: true });
    },
    turnsList: (conversationId: string): XdTurn[] => store.listTurns(conversationId),

    // ── 턴 ──
    async turnSend(input: { agentId: string; conversationId?: string; text: string }): Promise<{ turnId: string; conversationId: string }> {
      const agent = store.getAgent(text(input?.agentId, 'agentId'));
      const account = agent?.accountId ? store.getAccount(agent.accountId) : null;
      const cliName = account ? CLI_OF_KIND[account.kind] : undefined;
      // CLI 계정 — 실행 파일을 아직 찾지 않았으면 찾고 보낸다(턴 설정은 프로세스를 띄우지 않고 그 결과만 읽는다).
      if (cliName && deps.cli && !deps.cli.binary(cliName)) await deps.cli.detect(cliName);
      const { turnId, conversationId } = runner.send({
        agentId: text(input?.agentId, 'agentId'),
        conversationId: input.conversationId,
        text: text(input.text, 'text', 200_000),
      });
      return { turnId, conversationId };
    },
    turnCancel: (turnId: string): boolean => runner.cancel(turnId),
    turnStop: (conversationId: string): boolean => runner.cancelConversation(conversationId),

    // ── 계정 ──
    /** 이 앱이 받는 계정 종류(시험 실행이면 시험용 제공자도). */
    accountKinds: (): string[] => [...kinds],
    accountsList: (): AccountView[] => store.listAccounts().map(view),
    accountsCreate(input: { kind: string; label: string; baseUrl?: string | null; settings?: Record<string, unknown>; secret?: string }): AccountView {
      if (!kinds.has(input?.kind)) throw new Error(`unknown account kind: ${String(input?.kind)}`);
      const account = store.createAccount({
        kind: input.kind,
        label: text(input.label, 'label', 100),
        baseUrl: typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : null,
        settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
      });
      if (input.secret) secrets.set(account.id, input.secret);
      return view(account);
    },
    accountsUpdate(id: string, patch: { label?: string; baseUrl?: string | null; settings?: Record<string, unknown> }): AccountView {
      if (patch.label !== undefined) patch.label = text(patch.label, 'label', 100);
      return view(store.updateAccount(id, patch));
    },
    accountsSetSecret(id: string, value: string | null): AccountView {
      const account = store.getAccount(id);
      if (!account) throw new Error(`no account ${id}`);
      secrets.set(id, value);
      return view(account);
    },
    accountsDelete(id: string): void {
      store.deleteAccount(id);
      secrets.set(id, null);
    },
    secretsStatus: (): SecretStatus => secrets.status(),

    // ── 모델 ──
    /** 저장된 계정으로 — 이 계정이 지금 쓸 수 있는 모델(=연결 시험). */
    modelsList(accountId: string): Promise<ModelsResult> {
      const account = store.getAccount(accountId);
      if (!account) throw new Error(`no account ${accountId}`);
      return models(account.kind, account.baseUrl, secrets.get(account.id));
    },
    /** 저장하기 전에 — 입력한 종류·주소·키로 시험한다. 키는 저장하지 않는다. */
    modelsProbe(input: { kind: string; baseUrl?: string | null; secret?: string | null }): Promise<ModelsResult> {
      if (!kinds.has(input?.kind)) throw new Error(`unknown account kind: ${String(input?.kind)}`);
      return models(input.kind, input.baseUrl?.trim() || null, input.secret || null);
    },

    // ── CLI ──
    cliState: (name: CliName): Promise<CliState> => cli(name).state(name),
    cliDetect: (name: CliName) => cli(name).detect(name, true),
    cliInstall: (name: CliName) => cli(name).install(name),
    cliLogin: (name: CliName) => cli(name).login(name),
    cliLoginCode(name: CliName, code: string): void {
      cli(name).submitLoginCode(name, text(code, 'code', 4000));
    },
    cliLoginCancel: (name: CliName): void => cli(name).cancelLogin(name),
    cliLogout: (name: CliName) => cli(name).logout(name),
    /**
     * 이 CLI 로 에이전트를 돌릴 계정 — 있으면 그것, 없으면 하나 만든다(로그인이 끝나면 main 이 부른다). 로그인은 CLI
     * 마다 하나라 계정도 하나면 된다.
     */
    cliAccountEnsure(name: CliName): AccountView {
      if (!isCliName(name)) throw new Error(`unknown CLI ${String(name)}`);
      const kind = KIND_OF_CLI[name];
      const existing = store.listAccounts().find((a) => a.kind === kind);
      if (existing) return view(existing);
      return view(store.createAccount({ kind, label: CLI_LABEL[name], baseUrl: null, settings: { auth: 'oauth' } }));
    },

    // ── 엔진 ──
    engineStatus: () => ({ running: deps.engine.running, info: deps.engine.info }),
  };
}

export type XdApi = ReturnType<typeof createXdApi>;
