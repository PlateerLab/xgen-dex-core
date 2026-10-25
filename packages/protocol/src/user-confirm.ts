/**
 * 에이전트가 일을 이어 가기 전에 사용자에게 묻는 카드(desktop user-confirm, 기기 도구 `UserConfirm`).
 *
 * 답은 같은 턴의 도구 결과로 돌아간다 — 에이전트가 답변으로 묻고 턴을 끝낸 뒤 사용자가 "진행해줘" 를 보내는 왕복이 없다.
 */

/** 카드의 답 — 그대로 진행 / 진행하지 말고 고칠 점(말)을 전하기. */
export type UserConfirmChoice = 'proceed' | 'revise';

export interface UserConfirmRequest {
  requestId: string;
  workflowId: string;
  interactionId?: string;
  /** 에이전트의 질문 한 줄. */
  question: string;
  /** 사용자가 보고 판단할 내용(초안·바꿀 값 목록 등). 없으면 질문만 띄운다. */
  details?: string;
  createdAt: number;
  /** 이때까지 답이 없으면 진행하지 않는다. */
  expiresAt: number;
}

export interface UserConfirmResolveRequest {
  requestId: string;
  choice: UserConfirmChoice;
  /** revise 일 때 에이전트에게 전할 말. */
  message?: string;
}
