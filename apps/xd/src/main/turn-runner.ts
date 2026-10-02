/**
 * 턴 실행 — 저장소(대화·이력·계정)와 엔진을 잇는다.
 *
 * - 대화 id 는 부르는 쪽이 줄 수 있다(Dex 화면은 대화 id 를 스스로 만든다 — `conn-<에이전트>-<시각>`).
 * - 엔진 사건은 **Dex 화면의 `ChatEvent` 모양**으로 바꿔 내보낸다(`@dex/protocol` 의 같은 변환기). 작업 과정은
 *   Dex 의 `HistoryFlowItem` 그대로 모아 끝날 때 한 번에 저장한다 — 지난 턴도 화면이 같은 타임라인으로 그린다.
 * - 대화 하나에 도는 턴은 하나. 엔진이 받기 전에 알 수 있는 실패(계정·키 없음)는 엔진에 가지 않고 끝난다.
 */
import { turnEventToChatEvent } from '@dex/protocol/chat';
import type { ChatEvent, HistoryFlowItem, ToolEvent } from '@dex/protocol';
import { errorInfo } from '../shared/error-info';
export { errorInfo } from '../shared/error-info';
import type { EngineEvent, TurnCommand, TurnTerminal } from './engine-service';
import type { XdAccount, XdAgent, Store, XdTurn } from './store';

/**
 * 계정 종류 → 엔진(런타임) 제공자. Ollama·LM Studio 는 런타임의 전용 프로필(도구 지원·기본 주소), 그 밖의 OpenAI
 * 호환 서버(vLLM 등)는 vllm(=custom 프로필, 주소 필수). CLI 둘은 그 CLI 가 에이전트 루프를 돈다.
 */
export const PROVIDER_OF_KIND: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  openai_compatible: 'vllm',
  claude_code: 'claude_code',
  codex: 'codex',
};

/** 계정 종류 → CLI 이름(main 의 cli/ 가 아는 이름). */
const CLI_OF_KIND: Record<string, 'claude' | 'codex'> = { claude_code: 'claude', codex: 'codex' };

/** 키 없이 도는 API 제공자(로컬 서버). CLI 는 인증 방식(구독 로그인이면 키 없음)에 따른다. */
const KEYLESS = new Set(['openai_compatible', 'ollama', 'lmstudio', 'xd_fake']);

/** 에이전트 옵션 중 엔진 config 로 그대로 가는 것. */
const OPTION_KEYS = [
  'temperature',
  'max_tokens',
  'max_iterations',
  'thinking',
  'context_window',
  'tool_exposure',
  'enable_compaction',
  'memory_distill',
] as const;

export type XdTurnEvent =
  | { type: 'chat'; turnId: string; conversationId: string; event: ChatEvent }
  | { type: 'usage'; turnId: string; conversationId: string; usage: Record<string, unknown> }
  | { type: 'approval'; turnId: string; conversationId: string; request: string; command: string }
  /** 확인 창에 대답했다 — 화면은 "묻는 중" 안내를 걷는다. */
  | { type: 'approval_done'; turnId: string; conversationId: string; request: string; answer: 'once' | 'session' | 'deny' }
  | { type: 'finished'; turnId: string; conversationId: string; turn: XdTurn };

export interface EnginePort {
  turn(cmd: TurnCommand, listener: (event: EngineEvent) => void): Promise<TurnTerminal>;
  cancel(turnId: string): void;
  approvalReply(turnId: string, request: string, answer: 'once' | 'session' | 'deny'): void;
}

export interface TurnRunnerDeps {
  store: Store;
  engine: EnginePort;
  secret(accountId: string): string | null;
  /** CLI 계정의 실행 파일·전용 홈 — 설치·감지 안 됐으면 null. */
  cli?(name: 'claude' | 'codex'): { binary: string; home: string } | null;
  emit(event: XdTurnEvent): void;
  /** 위험 명령을 사용자에게 묻는다(main 의 확인 창) — 어느 에이전트가 묻는지도 준다. 없으면 거부한다. */
  confirmDangerous?(command: string, context: { conversationId: string; agentName: string }): Promise<'once' | 'session' | 'deny'>;
  /** 시험용 제공자(xd_fake)를 허용하는가 — 엔진이 가짜 LLM 을 등록했을 때만. */
  allowFakeProvider?: boolean;
  now?: () => number;
}

/** 엔진 config — 계정 종류·키·주소와 에이전트 옵션. 엔진에 가기 전에 알 수 있는 실패는 코드로. */
export function engineConfig(
  agent: XdAgent,
  account: XdAccount | null,
  secret: string | null,
  opts: { allowFakeProvider?: boolean; cli?: TurnRunnerDeps['cli'] } = {},
): { ok: true; config: Record<string, unknown> } | { ok: false; code: string; message: string } {
  if (!account) return { ok: false, code: 'no_account', message: 'agent has no provider account' };
  const provider =
    account.kind === 'xd_fake' && opts.allowFakeProvider ? 'xd_fake' : PROVIDER_OF_KIND[account.kind];
  if (!provider) return { ok: false, code: 'unsupported_provider', message: `account kind ${account.kind}` };
  const cliName = CLI_OF_KIND[account.kind];
  // CLI 의 인증: oauth(그 CLI 의 구독 로그인 — 키 없음) | api_key(이 계정의 키).
  const cliAuth = cliName ? (account.settings.auth === 'api_key' ? 'api_key' : 'oauth') : null;
  const needsKey = cliName ? cliAuth === 'api_key' : !KEYLESS.has(account.kind);
  if (needsKey && !secret) return { ok: false, code: 'no_key', message: `no API key for ${account.kind}` };
  if (account.kind === 'openai_compatible' && !account.baseUrl) {
    return { ok: false, code: 'no_base_url', message: 'openai_compatible needs a base URL' };
  }
  const model = agent.model || String(account.settings.defaultModel ?? '');
  if (!model) return { ok: false, code: 'no_model', message: 'agent has no model' };
  const config: Record<string, unknown> = { provider, model };
  if (cliName) {
    const found = opts.cli?.(cliName) ?? null;
    if (!found) return { ok: false, code: 'no_cli', message: `${cliName} is not installed` };
    config.cli = { binary: found.binary, home: found.home, auth: cliAuth };
    // 구독 로그인에는 키를 싣지 않는다(엔진·런타임도 막지만 여기서부터 섞지 않는다).
    if (cliAuth === 'api_key' && secret) config.api_key = secret;
  } else if (secret) {
    config.api_key = secret;
  }
  // CLI 의 주소는 키 방식의 게이트웨이에서만 뜻이 있다(구독 로그인은 그 회사로만 간다).
  if (account.baseUrl && (!cliName || cliAuth === 'api_key')) config.base_url = account.baseUrl;
  for (const key of OPTION_KEYS) {
    if (agent.options[key] !== undefined && agent.options[key] !== null) config[key] = agent.options[key];
  }
  const settings = agent.options.settings;
  if (settings && typeof settings === 'object') config.settings = settings;
  return { ok: true, config };
}

/** 사건을 모아 끝날 때 저장할 모양을 만든다. */
class TurnRecorder {
  answer = '';
  flow: HistoryFlowItem[] = [];
  usage: Record<string, unknown> | null = null;

  constructor(private readonly now: () => number) {}

  add(event: ChatEvent): void {
    if (event.kind === 'text') {
      this.answer += event.content;
      const last = this.flow[this.flow.length - 1];
      // 글 조각은 이어 붙인다 — 토큰마다 한 칸이면 타임라인이 글자 단위로 부서진다.
      if (last && last.kind === 'text') last.text += event.content;
      else this.flow.push({ kind: 'text', text: event.content, at: this.now() });
    } else if (event.kind === 'tool') {
      this.flow.push({ kind: 'tool', event: event.event as ToolEvent, at: this.now() });
    }
  }
}

export class BusyError extends Error {
  constructor(readonly conversationId: string) {
    super(`conversation ${conversationId} already has a turn running`);
  }
}

export class TurnRunner {
  private readonly running = new Map<string, { conversationId: string; agentId: string }>(); // turnId →
  private readonly now: () => number;

  constructor(private readonly deps: TurnRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  isRunning(conversationId: string): boolean {
    return [...this.running.values()].some((r) => r.conversationId === conversationId);
  }

  isAgentRunning(agentId: string): boolean {
    return [...this.running.values()].some((r) => r.agentId === agentId);
  }

  /**
   * 턴을 시작한다. 바로 돌아오고, 사건은 `emit` 으로 흐른다. 끝은 `finished` 사건(저장된 턴)이다.
   * 에이전트·대화가 맞지 않으면 예외(부르는 쪽의 잘못), 그 밖의 실패는 끝난 턴으로 돌아온다.
   */
  send(input: { agentId: string; conversationId?: string; text: string; attachments?: unknown[] }): {
    turnId: string;
    conversationId: string;
    done: Promise<XdTurn>;
  } {
    const { store } = this.deps;
    const agent = store.getAgent(input.agentId);
    if (!agent) throw new Error(`no agent ${input.agentId}`);
    let conversation = input.conversationId ? store.getConversation(input.conversationId) : null;
    if (conversation && conversation.agentId !== agent.id) throw new Error('conversation belongs to another agent');
    // 대화 하나에 턴 하나 — 화면은 답이 도는 동안 보내지 못하게 막는다. 여기 오면 부르는 쪽의 잘못이다.
    if (conversation && this.isRunning(conversation.id)) throw new BusyError(conversation.id);
    if (!conversation) conversation = store.createConversation(agent.id, '', input.conversationId);
    const conversationId = conversation.id;

    const history = store.history(conversationId);
    const turn = store.startTurn(conversationId, input.text, input.attachments ?? []);
    const recorder = new TurnRecorder(this.now);

    const finish = (status: 'done' | 'error' | 'cancelled', error: { code: string; message: string } | null): XdTurn => {
      this.running.delete(turn.id);
      const saved = store.finishTurn(turn.id, {
        answer: recorder.answer,
        process: recorder.flow,
        usage: recorder.usage,
        status,
        error,
      });
      this.deps.emit({ type: 'finished', turnId: turn.id, conversationId, turn: saved });
      return saved;
    };
    const fail = (code: string, message: string): XdTurn => {
      this.chat(turn.id, conversationId, { kind: 'error', detail: message, info: errorInfo(code, message) });
      return finish('error', { code, message });
    };

    const account = agent.accountId ? store.getAccount(agent.accountId) : null;
    const prepared = engineConfig(agent, account, account ? this.deps.secret(account.id) : null, {
      allowFakeProvider: this.deps.allowFakeProvider,
      cli: this.deps.cli,
    });
    if (!prepared.ok) {
      return { turnId: turn.id, conversationId, done: Promise.resolve(fail(prepared.code, prepared.message)) };
    }

    this.running.set(turn.id, { conversationId, agentId: agent.id });
    const cmd: TurnCommand = {
      id: turn.id,
      conversation: conversationId,
      text: input.text,
      history,
      agent: {
        id: agent.id,
        name: agent.name,
        workspace: agent.workspace,
        folders: agent.folders,
        memory: agent.memory,
        ...(agent.systemPrompt !== null ? { system_prompt: agent.systemPrompt } : {}),
      },
      config: prepared.config,
    };
    const done = this.deps.engine
      .turn(cmd, (event) => this.onEngineEvent(turn.id, conversationId, event, recorder))
      .then((terminal) => {
        if (terminal.type === 'done') {
          this.chat(turn.id, conversationId, { kind: 'end' });
          return finish('done', null);
        }
        if (terminal.type === 'cancelled') {
          this.chat(turn.id, conversationId, { kind: 'end' });
          return finish('cancelled', null);
        }
        return fail(terminal.code, terminal.message);
      });
    return { turnId: turn.id, conversationId, done };
  }

  cancel(turnId: string): boolean {
    if (!this.running.has(turnId)) return false;
    this.deps.engine.cancel(turnId);
    return true;
  }

  /** 이 대화에서 도는 턴을 멈춘다 — Dex 화면의 [정지]는 대화 id 로 멈춘다. */
  cancelConversation(conversationId: string): boolean {
    for (const [turnId, r] of this.running) {
      if (r.conversationId === conversationId) return this.cancel(turnId);
    }
    return false;
  }

  private chat(turnId: string, conversationId: string, event: ChatEvent): void {
    this.deps.emit({ type: 'chat', turnId, conversationId, event });
  }

  private onEngineEvent(turnId: string, conversationId: string, event: EngineEvent, recorder: TurnRecorder): void {
    let chat: ChatEvent | null = null;
    if (event.type === 'chunk') {
      chat = turnEventToChatEvent(undefined, { type: 'data', content: String(event.text ?? '') });
    } else if (event.type === 'tool' && event.event && typeof event.event === 'object') {
      chat = turnEventToChatEvent('tool', event.event as Record<string, unknown>);
    } else if (event.type === 'usage' && event.usage && typeof event.usage === 'object') {
      recorder.usage = event.usage as Record<string, unknown>;
      this.deps.emit({ type: 'usage', turnId, conversationId, usage: recorder.usage });
      return;
    } else if (event.type === 'approval_request') {
      this.approve(turnId, conversationId, String(event.request ?? ''), String(event.command ?? ''));
      return;
    }
    if (!chat) return;
    recorder.add(chat);
    this.chat(turnId, conversationId, chat);
  }

  private approve(turnId: string, conversationId: string, request: string, command: string): void {
    this.deps.emit({ type: 'approval', turnId, conversationId, request, command });
    const ask = this.deps.confirmDangerous;
    const agentId = this.running.get(turnId)?.agentId;
    const agentName = (agentId && this.deps.store.getAgent(agentId)?.name) || '';
    // 물을 방법이 없으면 거부한다 — "물을 필요가 없다" 가 아니라 "동의를 받을 수 없다" 다.
    const answer = ask ? ask(command, { conversationId, agentName }).catch(() => 'deny' as const) : Promise.resolve('deny' as const);
    void answer.then((a) => {
      this.deps.engine.approvalReply(turnId, request, a);
      this.deps.emit({ type: 'approval_done', turnId, conversationId, request, answer: a });
    });
  }
}
