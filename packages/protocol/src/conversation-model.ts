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
 *   PUT    /api/agentflow/conversations/{id}/thinking              생각(추론) 값 고르기
 *   DELETE /api/agentflow/conversations/{id}/thinking?workflow_id=… 에이전트의 생각 값으로 되돌리기
 *
 * 생각(thinking): 모델 옆에서 "이 대화는 이만큼 생각해서" 를 고른다. 고를 수 있는 값은 **지금 모델이
 * 받는 것만** 서버가 준다(모델마다 다르다 — 강도·켜기/끄기·조절 불가). 모델을 바꾸면 고른 값은 새 모델이
 * 받는 가장 가까운 값으로 돈다. 생각 상태는 모델 상태와 한 묶음으로 오가고 같은 `model` 소식에 실린다.
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

/** 생각 값 — `auto` 는 에이전트 설정(에이전트가 정하지 않았으면 모델 기본)을 따른다. */
export type ThinkingValue = 'auto' | 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const THINKING_VALUES: readonly ThinkingValue[] = ['auto', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ThinkingState {
  /** 이 모델은 생각을 조절할 수 있다. 아니면 화면은 "생각 조절 불가" 로 그린다. */
  supported: boolean;
  /** `levels` 강도 · `toggle` 켜기/끄기만 · `none` 조절 불가. */
  kind: 'none' | 'toggle' | 'levels';
  /** 고를 수 있는 값(맨 앞 `auto`) — 지금 모델이 받는 것만. */
  options: ThinkingValue[];
  /** 아무것도 정하지 않았을 때 모델이 하는 것(`off`·`on`·강도, 모르면 빈 값). */
  modelDefault: string;
  /** 끌 수 있는가 — 아니면 늘 생각한다. */
  canDisable: boolean;
  /** 지금 이 모델에서 실제로 쓰는 값(고른 값을 이 모델이 받는 값으로 맞춘 것). `auto` 면 모델 기본. */
  current: ThinkingValue;
  /** 고른 값 그대로(대화의 선택, 없으면 에이전트 설정). */
  selected: ThinkingValue;
  /** `conversation` 이면 이 대화에서 고른 것, `agent` 면 에이전트 설정을 따른다. */
  source: 'agent' | 'conversation';
}

function thinkingValue(v: unknown, fallback: ThinkingValue = 'auto'): ThinkingValue {
  const s = str(v).trim().toLowerCase();
  return (THINKING_VALUES as readonly string[]).includes(s) ? (s as ThinkingValue) : fallback;
}

/** 서버의 `thinking` 묶음 → 화면 모양. 옛 서버(없음)는 null — 화면은 생각 선택기를 그리지 않는다. */
export function parseThinking(raw: unknown): ThinkingState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === 'levels' || r.kind === 'toggle' ? r.kind : 'none';
  const supported = r.supported === true && kind !== 'none';
  const options = supported
    ? (Array.isArray(r.options) ? r.options : []).map((o) => thinkingValue(o, 'auto')).filter((o, i, all) => all.indexOf(o) === i)
    : [];
  return {
    supported,
    kind: supported ? kind : 'none',
    options: options.length && options[0] !== 'auto' ? ['auto', ...options.filter((o) => o !== 'auto')] : options,
    modelDefault: str(r.default),
    canDisable: r.can_disable === true,
    current: thinkingValue(r.current),
    selected: thinkingValue(r.selected),
    source: str(r.source) === 'conversation' ? 'conversation' : 'agent',
  };
}

/**
 * 목록에서 눌려 있는 값 — 이 대화에서 고른 것이 없으면 `auto`(에이전트 설정). 고른 값을 지금 모델이 받지
 * 않으면(모델을 바꿨다) 실제로 쓰는 값에 눌린다 — 아무것도 눌리지 않은 목록은 지금 상태를 말하지 못한다.
 */
export function selectedThinking(t: ThinkingState): ThinkingValue {
  if (t.source !== 'conversation') return 'auto';
  return t.options.includes(t.selected) ? t.selected : t.current;
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
  /** 생각(추론) — 지금 모델이 받는 값. 옛 서버면 null. */
  thinking?: ThinkingState | null;
}

export const UNSUPPORTED_MODEL_STATE: ConversationModelState = {
  supported: false,
  locked: true,
  current: null,
  agent: null,
  choices: [],
  thinking: null,
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
    thinking: parseThinking(r.thinking),
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
  // 소식에 생각 묶음이 있으면 그것으로(모델이 바뀌면 받을 수 있는 생각 값이 함께 바뀐다).
  const thinking = 'thinking' in n ? parseThinking(n.thinking) : state.thinking;
  return { ...state, current: { ...cur, source }, thinking };
}

function path(interactionId: string): string {
  return `/api/agentflow/conversations/${encodeURIComponent(interactionId)}/model`;
}

function thinkingPath(interactionId: string): string {
  return `/api/agentflow/conversations/${encodeURIComponent(interactionId)}/thinking`;
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

  /** 이 대화의 생각 값을 바꾼다 — 다음 답변부터. `auto` 나 에이전트의 값을 고르면 에이전트를 따른다. */
  async setThinking(interactionId: string, workflowId: string, thinking: ThinkingValue): Promise<ConversationModelState> {
    return parseConversationModel(
      await this.http.put<unknown>(thinkingPath(interactionId), { workflow_id: workflowId, thinking }),
    );
  }

  /** 에이전트의 생각 값으로 되돌린다. */
  async resetThinking(interactionId: string, workflowId: string): Promise<ConversationModelState> {
    return parseConversationModel(
      await this.http.del<unknown>(`${thinkingPath(interactionId)}?workflow_id=${encodeURIComponent(workflowId)}`),
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

/** 생각 선택기의 문구 — 화면마다 같다. */
export const THINKING_PICKER_TEXT = {
  title: '생각',
  unsupported: '생각 조절 불가',
  unsupportedHint: '이 모델은 생각을 조절할 수 없습니다',
  nextTurn: '다음 답변부터 적용됩니다',
  autoHint: '에이전트 설정을 따릅니다',
  locked: '고정된 에이전트는 생각 설정을 바꿀 수 없습니다',
  failed: '생각 설정을 바꾸지 못했습니다',
  alwaysOn: '이 모델은 늘 생각합니다',
} as const;

const THINKING_LABELS: Record<ThinkingValue, string> = {
  auto: '기본',
  off: '끄기',
  on: '켜기',
  minimal: '최소',
  low: '낮게',
  medium: '보통',
  high: '높게',
  xhigh: '매우 높게',
  max: '최대',
};

/** 값 하나의 이름표(`높게`). */
export function thinkingValueLabel(value: string): string {
  return THINKING_LABELS[thinkingValue(value)] ?? value;
}

/** 칩에 쓰는 한 줄 — `생각: 높게`, `생각: 기본`, `생각 조절 불가`. */
export function thinkingChipLabel(t: ThinkingState | null | undefined): string {
  if (!t) return '';
  if (!t.supported) return THINKING_PICKER_TEXT.unsupported;
  return `${THINKING_PICKER_TEXT.title}: ${thinkingValueLabel(t.current)}`;
}
