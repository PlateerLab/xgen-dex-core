/**
 * Decision — 판단 모델(System One)에 묻는다. 글을 생성하지 않고 선택지별 확률만 돌려주는 모델이다.
 *
 * 판단 모델은 XGEN 서버(xgen-model)에 올라가 있고, 커넥터는 로그인 토큰으로 xgen-core 를 부른다.
 * 같은 state 로 질문 여러 개를 한 번에 보내면 서버가 한 번의 모델 호출로 묶는다.
 *
 * Endpoint (xgen-core):
 *  - POST /api/base/v1/decision/systemone  {state, questions} → {model, answers, usage, latency_s}
 *    판단 모델이 load 되지 않은 서버면 503.
 */
import { HttpClient } from './client';

export const DECISION_SYSTEMONE_PATH = '/api/base/v1/decision/systemone';

/**
 * 질문 하나. choice 는 criteria 의 키(또는 options)를, noul/boolean 은 예·아니오를,
 * score 는 0..N-1 점수를 고른다. criteria 값은 모델에게 보이는 선택지 설명이다.
 */
export interface DecisionQuestion {
  type: 'choice' | 'noul' | 'boolean' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[];
  options?: string[];
}

/** 답 하나 — 질문 type 에 따라 채워지는 필드가 다르다. */
export interface DecisionAnswer {
  type?: string;
  /** choice: 고른 선택지 */
  choice?: string;
  /** choice·score: 선택지별 확률 */
  probabilities?: Record<string, number>;
  confidence?: number;
  /** noul·boolean: 예일 확률과 그 판정 */
  noul?: number;
  value?: boolean;
  /** score: 가장 높은 점수와 기댓값 */
  score?: number;
  expected?: number;
}

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  latency_s?: number;
}

/**
 * 판단 모델 선택 — core 설정 `DECISION_MODEL`("<provider>/<model_id>", 빈 값 = xgen-model decider).
 * 서버 하나에 한 모델이고 관리자가 고른다. 고를 수 있는 것은 LLM 카탈로그에서
 * `capabilities.kind = "decision"` 으로 켜 둔 행이다. 세 API 모두 관리자 권한이 필요하다.
 */
export const DECISION_MODEL_CONFIG = 'DECISION_MODEL';

export interface DecisionModelChoice {
  /** `DECISION_MODEL` 에 들어갈 값 — `openrouter/typesafe/jev-1.14`. 빈 값은 기본 decider. */
  value: string;
  label: string;
}

export interface DecisionModelState {
  current: string;
  choices: DecisionModelChoice[];
}

interface RawCatalogRow {
  provider?: string;
  model_id?: string;
  display_name?: string;
  enabled?: boolean;
  deprecated?: boolean;
  capabilities?: { kind?: string } | null;
}

export class DecisionApi {
  constructor(private http: HttpClient) {}

  /**
   * 지금 판단 모델과 고를 수 있는 것. 권한이 없으면(403 등) 던진다 — 화면은 선택기를 그리지 않는다.
   * 401 이 로그아웃으로 번지지 않게 `auth: false`.
   */
  async model(): Promise<DecisionModelState> {
    const [catalog, configs] = await Promise.all([
      this.http.get<{ items?: RawCatalogRow[] }>('/api/admin/llm-catalog', { auth: false }),
      this.http.get<{ persistent_summary?: { configs?: { env_name?: string; current_value?: unknown }[] } }>(
        '/api/config/persistent',
        { auth: false },
      ),
    ]);
    const choices: DecisionModelChoice[] = [{ value: '', label: '기본 (XGEN decider)' }];
    for (const r of catalog.items ?? []) {
      if (r.capabilities?.kind !== 'decision' || !r.enabled || r.deprecated || !r.provider || !r.model_id) continue;
      choices.push({ value: `${r.provider}/${r.model_id}`, label: r.display_name || r.model_id });
    }
    const raw = configs.persistent_summary?.configs?.find((c) => c.env_name === DECISION_MODEL_CONFIG)?.current_value;
    const current = typeof raw === 'string' ? raw.trim() : '';
    // 꺼졌거나 지운 모델이 설정에 남아 있어도 지금 값으로는 보여야 한다(판단 호출은 503).
    if (!choices.some((c) => c.value === current)) choices.push({ value: current, label: `${current} (꺼짐)` });
    return { current, choices };
  }

  /** 판단 모델을 바꾼다 — 서버 전체, 다음 판단 호출부터. */
  async setModel(value: string): Promise<void> {
    await this.http.put(`/api/config/persistent/${DECISION_MODEL_CONFIG}`, { value }, { auth: false });
  }

  /**
   * state 를 보고 questions 각각에 답한다. 답 순서와 키는 questions 와 같다.
   * `auth: false` 면 401 이 로그아웃 처리(onAuthFailure)로 번지지 않는다 — 실패하면 다른 길로
   * 넘어가는 호출자가 쓴다.
   */
  systemone(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    opts?: { timeoutMs?: number; auth?: boolean },
  ): Promise<DecisionResult> {
    return this.http.post<DecisionResult>(DECISION_SYSTEMONE_PATH, { state, questions }, opts);
  }
}
