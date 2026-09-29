/**
 * 대화의 모델 — 채팅 입력창 옆 선택기(데스크톱·모바일·VS Code·CLI 가 같이 쓴다).
 *
 * 에이전트의 모델은 에이전트에 저장된 값이다. 사용자는 대화 도중에 다른 모델을 고를 수 있고,
 * 그 선택은 **이 대화에만** 붙는다. 서버가 들고 있다가 다음 턴 시작에 바꿔 끼운다 — 세션은
 * 다시 시작하지 않는다(대화 기록·기억·샌드박스 그대로, 답만 새 모델). 어느 화면에서 고르든
 * 다른 화면에도 곧바로 보인다(대화 버스 `model` 소식).
 *
 *   GET    /api/agentflow/conversations/{id}/model?workflow_id=…   지금 모델(맨 앞)·고를 수 있는 것
 *   PUT    /api/agentflow/conversations/{id}/model                 고르기(다음 턴부터)
 *   DELETE /api/agentflow/conversations/{id}/model?workflow_id=…   에이전트의 모델로 되돌리기
 *
 * 이름은 서버가 정한다 — "제공자: 모델"(예 `Anthropic: Haiku 4.5`). 모든 화면이 그대로 쓴다.
 * 옛 서버(API 없음, 404)면 `supported: false` — 화면은 선택기를 그리지 않는다.
 */
import { ApiError, type HttpClient } from './client';

export interface ModelChoice {
  provider: string;
  model: string;
  /** 제공자를 뺀 모델 이름(`Haiku 4.5`). */
  name: string;
  /** `Anthropic: Haiku 4.5`. */
  label: string;
  /** 묶음 제목 — 제공자의 긴 이름(`Google (Gemini)`). */
  group: string;
}

export interface ConversationModelState {
  /** Geny 에이전트이고 서버가 이 기능을 안다. 아니면 선택기가 없다. */
  supported: boolean;
  /** 고정본·게스트 대화 — 보이기만 하고 바꿀 수 없다. */
  locked: boolean;
  /** 지금 모델. `source` 가 `conversation` 이면 이 대화에서 고른 것, `agent` 면 에이전트 설정. */
  current: (ModelChoice & { source: 'agent' | 'conversation' }) | null;
  /** 에이전트에 저장된 모델(되돌아갈 자리). */
  agent: { provider: string; model: string; label: string } | null;
  /** 고를 수 있는 모델 — 지금 모델이 맨 앞이다. */
  choices: ModelChoice[];
}

export const UNSUPPORTED_MODEL_STATE: ConversationModelState = {
  supported: false,
  locked: true,
  current: null,
  agent: null,
  choices: [],
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function parseChoice(raw: unknown): ModelChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = str(r.provider);
  const model = str(r.model);
  if (!provider || !model) return null;
  const name = str(r.name) || model;
  return { provider, model, name, label: str(r.label) || `${provider}: ${name}`, group: str(r.group) || provider };
}

/** 서버 모양 → 화면 모양. 대화 버스의 `model` 소식에는 `current` 만 온다. */
export function parseConversationModel(raw: unknown): ConversationModelState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (r.supported !== true) return { ...UNSUPPORTED_MODEL_STATE };
  const currentRaw = parseChoice(r.current);
  const current = currentRaw
    ? { ...currentRaw, source: (str((r.current as Record<string, unknown>).source) === 'conversation' ? 'conversation' : 'agent') as 'agent' | 'conversation' }
    : null;
  const agentRaw = r.agent && typeof r.agent === 'object' ? (r.agent as Record<string, unknown>) : null;
  const choices = (Array.isArray(r.choices) ? r.choices : []).map(parseChoice).filter((c): c is ModelChoice => !!c);
  return {
    supported: true,
    locked: r.locked === true,
    current,
    agent: agentRaw && str(agentRaw.provider)
      ? { provider: str(agentRaw.provider), model: str(agentRaw.model), label: str(agentRaw.label) }
      : null,
    choices,
  };
}

export function sameModel(a: { provider: string; model: string } | null | undefined, b: { provider: string; model: string } | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/**
 * 목록을 그리는 순서 — 지금 모델이 맨 앞, 나머지는 제공자 묶음 그대로.
 * 서버가 이미 이 순서로 주지만 소식(`model`)으로 지금 모델만 바뀐 경우를 위해 화면도 맞춘다.
 */
export function orderedChoices(state: ConversationModelState): ModelChoice[] {
  const cur = state.current;
  if (!cur) return state.choices;
  return [cur, ...state.choices.filter((c) => !sameModel(c, cur))];
}

/** 대화 버스의 `model` 소식을 지금 상태에 얹는다(목록은 그대로, 지금 모델만). */
export function applyModelNotice(state: ConversationModelState, notice: unknown): ConversationModelState {
  const n = notice && typeof notice === 'object' ? (notice as Record<string, unknown>) : {};
  const cur = parseChoice(n.current);
  if (!state.supported || !cur) return state;
  const source = str((n.current as Record<string, unknown>).source) === 'conversation' ? 'conversation' : 'agent';
  return { ...state, current: { ...cur, source } };
}

function path(interactionId: string): string {
  return `/api/agentflow/conversations/${encodeURIComponent(interactionId)}/model`;
}

type HttpLike = Pick<HttpClient, 'get' | 'put' | 'del'>;

export class ConversationModelApi {
  constructor(private http: HttpLike) {}

  /** 이 대화의 모델 선택기. 옛 서버·Geny 가 아닌 에이전트면 `supported: false`. */
  async get(interactionId: string, workflowId: string): Promise<ConversationModelState> {
    try {
      const raw = await this.http.get<unknown>(`${path(interactionId)}?workflow_id=${encodeURIComponent(workflowId)}`);
      return parseConversationModel(raw);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return { ...UNSUPPORTED_MODEL_STATE };
      throw e;
    }
  }

  /** 이 대화의 모델을 바꾼다 — 다음 답변부터. 에이전트의 모델을 고르면 에이전트를 따른다. */
  async set(interactionId: string, workflowId: string, choice: { provider: string; model: string }): Promise<ConversationModelState> {
    return parseConversationModel(
      await this.http.put<unknown>(path(interactionId), {
        workflow_id: workflowId,
        provider: choice.provider,
        model: choice.model,
      }),
    );
  }

  /** 에이전트의 모델로 되돌린다. */
  async reset(interactionId: string, workflowId: string): Promise<ConversationModelState> {
    return parseConversationModel(
      await this.http.del<unknown>(`${path(interactionId)}?workflow_id=${encodeURIComponent(workflowId)}`),
    );
  }
}

/** 선택기가 쓰는 짧은 안내 — 화면마다 같은 문구. */
export const MODEL_PICKER_TEXT = {
  title: '모델',
  current: '현재',
  nextTurn: '다음 답변부터 이 모델로 답합니다',
  locked: '고정된 에이전트는 모델을 바꿀 수 없습니다',
  failed: '모델을 바꾸지 못했습니다',
} as const;
