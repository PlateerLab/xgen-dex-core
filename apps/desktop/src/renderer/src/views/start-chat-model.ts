/**
 * 시작 화면의 입력창 잠금 규칙 (2026-10-09). 화면과 떼어 두어 시험한다.
 *
 * 보낼 수 있을 때만 입력창이 열린다. 새 에이전트는 이름이 있고 겹치지 않아야 하며 모델 목록이 와
 * 있어야 하고, 고른 에이전트는 골라져 있기만 하면 된다. 잠긴 까닭은 그대로 사용자에게 보인다.
 */
export const NAME_REQUIRED = '에이전트 이름을 먼저 입력해 주세요.';
export const NAME_TAKEN = '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.';
export const AGENT_REQUIRED = '대화할 에이전트를 골라 주세요.';
export const OPTIONS_LOADING = '모델 목록을 불러오는 중입니다.';

/** 입력창이 잠긴 까닭. 없으면(null) 보낼 수 있다. */
export function startChatLockReason(state: {
  isNew: boolean;
  name: string;
  nameTaken: boolean;
  optionsReady: boolean;
  optionsError: string | null;
  agentSelected: boolean;
}): string | null {
  if (!state.isNew) return state.agentSelected ? null : AGENT_REQUIRED;
  if (!state.name.trim()) return NAME_REQUIRED;
  if (state.nameTaken) return NAME_TAKEN;
  if (!state.optionsReady) return state.optionsError ?? OPTIONS_LOADING;
  return null;
}

/** 잠긴 까닭이 이름 때문인가(그러면 이름 칸으로 간다). */
export function lockedByName(reason: string | null): boolean {
  return reason === NAME_REQUIRED || reason === NAME_TAKEN;
}
