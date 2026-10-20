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

export class DecisionApi {
  constructor(private http: HttpClient) {}

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
