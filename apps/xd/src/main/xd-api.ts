/**
 * XD 의 main API — 화면이 IPC 로 부르는 일들. Electron 을 모른다(시험이 그대로 부른다).
 *
 * 에이전트를 만들면 작업 공간 폴더(`<루트>/workspace/<이름>`)도 만든다. 지울 때 그 폴더는 남긴다(사용자 파일) —
 * 엔진 상태(`.xd/agents/<id>`: 기억·도구 결과)만 지운다. 대화를 지우면 그 대화의 대화 기록(STM)도 지운다.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineService } from './engine-service';
import type { Secrets, SecretStatus } from './secrets';
import type { XdAccount, XdAgent, XdConversation, Store, XdTurn } from './store';
import type { TurnRunner } from './turn-runner';
import { uniqueFolderName } from './workspace-name';

/** 계정 종류 — v1 제공자(DESIGN §2-4). CLI 둘은 M3 에서 턴을 돌린다. */
export const ACCOUNT_KINDS = ['anthropic', 'openai', 'google', 'openai_compatible', 'claude_code', 'codex'] as const;

export interface XdApiDeps {
  store: Store;
  secrets: Secrets;
  runner: TurnRunner;
  engine: Pick<EngineService, 'info' | 'running'>;
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
    turnSend(input: { agentId: string; conversationId?: string; text: string }): { turnId: string; conversationId: string } {
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

    // ── 엔진 ──
    engineStatus: () => ({ running: deps.engine.running, info: deps.engine.info }),
  };
}

export type XdApi = ReturnType<typeof createXdApi>;
