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

/** 탭 이름에 쓰는 글 길이. 탭은 좁다(나머지는 툴팁이 보여 준다). */
const TAB_TITLE_MAX = 40;

function oneLine(text: string, limit: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * 탭 이름은 대화 제목이다(2026-10-09). 대화 목록이 알려 준 제목(붙인 이름, 없으면 첫 메시지)이 먼저고,
 * 모르면 이 대화의 첫 질문 한 줄이다. 아직 아무 말도 없으면 "새 대화".
 * 예전에는 에이전트 이름이라 같은 에이전트와의 대화 탭이 모두 같은 이름이었다.
 */
export function tabTitle(s: SessionState): string {
  const named = s.title?.trim();
  if (named) return oneLine(named, TAB_TITLE_MAX);
  const first = s.messages.find((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim());
  if (first) return oneLine(first.text, TAB_TITLE_MAX);
  return '새 대화';
}

/** 탭 툴팁: 에이전트 이름과 대화 제목. */
export function tabTooltip(s: SessionState): string {
  const title = tabTitle(s);
  const agent = s.agent.workflowName;
  return agent ? `${agent} · ${title}` : title;
}
