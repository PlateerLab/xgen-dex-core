/**
 * 메인 영역 탭 순수 모델 — 세션 스토어를 VS Code 식 탭 줄로 사상한다.
 *
 * 탭 목록은 세션 스토어의 **삽입 순서**를 그대로 쓴다. `openSessions()` 는
 * 최근 활동순 정렬이라, 그대로 탭에 묶으면 응답이 올 때마다 탭이 자리를
 * 바꾼다 — 탭은 자리가 곧 정체성이므로 절대 스스로 움직이면 안 된다.
 *
 * 빈 새 세션(메시지 0, 스트리밍 없음)은 스토어가 포커스를 떠나는 순간
 * 걷어가므로(gcIfEmpty), 탭으로는 **활성일 때만** 보인다 — "빈 탭은 떠나면
 * 사라진다"가 이 앱의 규칙이고, 탭 줄도 그것을 그대로 따른다.
 */
import { isKeepable, type SessionState } from '../session-store';

/** 탭 줄에 실제로 보이는 세션들 — 삽입 순서 유지. */
export function chatTabs(sessions: SessionState[], activeKey: string | null): SessionState[] {
  return sessions.filter((s) => isKeepable(s) || s.key === activeKey);
}

/** 탭 이름 — 에이전트 이름. 비어 있으면 자리표시. */
export function tabTitle(s: SessionState): string {
  return s.agent.workflowName || '대화';
}
