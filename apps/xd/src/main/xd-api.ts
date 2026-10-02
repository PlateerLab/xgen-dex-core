/**
 * XD 의 main API — 화면이 IPC 로 부르는 일들. Electron 을 모른다(시험이 그대로 부른다).
 *
 * 에이전트를 만들면 작업 공간 폴더(`<루트>/workspace/<이름>`)도 만든다. 지울 때 그 폴더는 남긴다(사용자 파일) —
 * 엔진 상태(`.xd/agents/<id>`: 기억·도구 결과)만 지운다. 대화를 지우면 그 대화의 대화 기록(STM)도 지운다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CliName } from './cli/detect';
import type { CliService, CliState } from './cli/service';
import type { EngineService, ModelsResult } from './engine-service';
import type { Secrets, SecretStatus } from './secrets';
import type { XdAccount, XdAgent, XdConversation, Store, XdTurn } from './store';
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
const isCliName = (name: unknown): name is CliName => name === 'claude' || name === 'codex';

export interface XdApiDeps {
  store: Store;
  secrets: Secrets;
  runner: TurnRunner;
  engine: Pick<EngineService, 'info' | 'running'> & { models?: EngineService['models'] };
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
    agentsCreate(input: AgentInput): XdAgent {
      const name = text(input?.name, 'name', 100);
      checkAccount(input.accountId);
      const workspace = uniqueFolderName(
        name,
        (candidate) => store.workspaceTaken(candidate) || existsSync(join(deps.workspaceDir, candidate)),
      );
      mkdirSync(join(deps.workspaceDir, workspace), { recursive: true });
      return store.createAgent({
        name,
        workspace,
        description: typeof input.description === 'string' ? input.description : '',
        systemPrompt: input.systemPrompt === undefined ? null : input.systemPrompt,
        accountId: input.accountId ?? null,
        model: typeof input.model === 'string' ? input.model : '',
        folders: stringList(input.folders, 'folders'),
        memory: input.memory !== false,
        options: input.options && typeof input.options === 'object' ? input.options : {},
      });
    },
    agentsUpdate(id: string, patch: Partial<AgentInput>): XdAgent {
      if (patch.name !== undefined) patch.name = text(patch.name, 'name', 100);
      if (patch.folders !== undefined) patch.folders = stringList(patch.folders, 'folders');
      checkAccount(patch.accountId);
      return store.updateAgent(id, patch as Partial<XdAgent>);
    },
    agentsDelete(id: string): void {
      if (runner.isAgentRunning(id)) throw new Error('this agent has a turn running');
      store.deleteAgent(id);
      rmSync(join(deps.stateDir, 'agents', id), { recursive: true, force: true });
    },

    // ── 대화 ──
    conversationsList: (agentId: string): XdConversation[] => store.listConversations(agentId),
    conversationsRename(id: string, title: string): void {
      store.renameConversation(id, text(title, 'title', 200));
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

    // ── 엔진 ──
    engineStatus: () => ({ running: deps.engine.running, info: deps.engine.info }),
  };
}

export type XdApi = ReturnType<typeof createXdApi>;
