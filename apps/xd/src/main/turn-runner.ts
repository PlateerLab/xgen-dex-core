/**
 * 턴 실행 — 저장소(대화·이력·계정)와 엔진을 잇는다.
 *
 * - 대화 id 는 부르는 쪽이 줄 수 있다(Dex 화면은 대화 id 를 스스로 만든다 — `conn-<에이전트>-<시각>`).
 * - 엔진 사건은 **Dex 화면의 `ChatEvent` 모양**으로 바꿔 내보낸다(`@dex/protocol` 의 같은 변환기). 작업 과정은
 *   Dex 의 `HistoryFlowItem` 그대로 모아 끝날 때 한 번에 저장한다 — 지난 턴도 화면이 같은 타임라인으로 그린다.
 * - 대화 하나에 도는 턴은 하나. 엔진이 받기 전에 알 수 있는 실패(계정·키 없음)는 엔진에 가지 않고 끝난다.
 */
import { describeStreamError } from '@dex/protocol/errors';
import { turnEventToChatEvent } from '@dex/protocol/chat';
import type { ChatEvent, HistoryFlowItem, ToolEvent, XgenErrorInfo } from '@dex/protocol';
import type { EngineEvent, TurnCommand, TurnTerminal } from './engine-service';
import type { XdAccount, XdAgent, Store, XdTurn } from './store';

/** 계정 종류 → 엔진(런타임) 제공자. OpenAI 호환(Ollama·LM Studio·vLLM)은 런타임의 vllm(=custom 프로필). */
const PROVIDER_OF_KIND: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  openai_compatible: 'vllm',
};

/** 키 없이 도는 제공자 — 그 밖의 API 제공자는 키가 있어야 턴을 시작한다. */
const KEYLESS = new Set(['openai_compatible', 'xd_fake']);

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
  emit(event: XdTurnEvent): void;
  /** 위험 명령을 사용자에게 묻는다(main 의 확인 창). 없으면 거부한다. */
  confirmDangerous?(command: string, conversationId: string): Promise<'once' | 'session' | 'deny'>;
  /** 시험용 제공자(xd_fake)를 허용하는가 — 엔진이 가짜 LLM 을 등록했을 때만. */
  allowFakeProvider?: boolean;
  now?: () => number;
}

/** XD 가 붙이는 실패 코드 → 화면 문구. 문구는 한 문장, 내부 사정을 말하지 않는다. */
const XD_ERRORS: Record<string, Pick<XgenErrorInfo, 'title' | 'hint' | 'retryable'>> = {
  no_account: { title: '이 에이전트에 연결된 AI 제공자가 없습니다.', hint: '에이전트 설정에서 제공자를 고르세요.', retryable: false },
  no_key: { title: '이 제공자의 API 키가 없습니다.', hint: '제공자 설정에서 키를 입력하세요.', retryable: false },
  no_model: { title: '이 에이전트에 모델이 정해져 있지 않습니다.', hint: '에이전트 설정에서 모델을 고르세요.', retryable: false },
  unsupported_provider: { title: '이 제공자는 아직 쓸 수 없습니다.', retryable: false },
  engine_unavailable: { title: '실행 엔진을 시작하지 못했습니다.', hint: '앱을 다시 시작해 보세요.', retryable: true },
  engine_exited: { title: '실행 엔진이 멈췄습니다.', hint: '다시 보내면 새로 시작합니다.', retryable: true },
  bad_request: { title: '에이전트 설정을 확인해 주세요.', retryable: false },
};

export function errorInfo(code: string, message: string): XgenErrorInfo {
  const known = XD_ERRORS[code];
  if (known) return { code: `XD-${code}`, detail: message, ...known };
  // 엔진(제공자·파이프라인)의 실패는 Dex 와 같은 분류기로 사람이 읽는 말로 바꾼다.
  return describeStreamError(message);
}

/** 엔진 config — 계정 종류·키·주소와 에이전트 옵션. 엔진에 가기 전에 알 수 있는 실패는 코드로. */
export function engineConfig(
  agent: XdAgent,
  account: XdAccount | null,
  secret: string | null,
  opts: { allowFakeProvider?: boolean } = {},
): { ok: true; config: Record<string, unknown> } | { ok: false; code: string; message: string } {
  if (!account) return { ok: false, code: 'no_account', message: 'agent has no provider account' };
  const provider =
    account.kind === 'xd_fake' && opts.allowFakeProvider ? 'xd_fake' : PROVIDER_OF_KIND[account.kind];
  if (!provider) return { ok: false, code: 'unsupported_provider', message: `account kind ${account.kind}` };
  if (!KEYLESS.has(account.kind) && !secret) return { ok: false, code: 'no_key', message: `no API key for ${account.kind}` };
  const model = agent.model || String(account.settings.defaultModel ?? '');
  if (!model) return { ok: false, code: 'no_model', message: 'agent has no model' };
  const config: Record<string, unknown> = { provider, model };
  if (secret) config.api_key = secret;
  if (account.baseUrl) config.base_url = account.baseUrl;
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
    // 물을 방법이 없으면 거부한다 — "물을 필요가 없다" 가 아니라 "동의를 받을 수 없다" 다.
    const answer = ask ? ask(command, conversationId).catch(() => 'deny' as const) : Promise.resolve('deny' as const);
    void answer.then((a) => this.deps.engine.approvalReply(turnId, request, a));
  }
}
