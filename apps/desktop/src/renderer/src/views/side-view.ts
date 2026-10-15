/**
 * 사이드바 보기 — 왼쪽 아이콘 줄(ActivityBar) 위쪽 단추들이 고르는 패널.
 *
 * ActivityBar(React·IDE 묶음을 끌어온다) 밖에 두는 이유는 저장값 복원 규칙을 노드 테스트가
 * 그대로 불러 확인하기 위해서다.
 */
export type SideView = 'agent' | 'explorer' | 'teams';

export const SIDE_VIEWS: readonly SideView[] = ['agent', 'explorer', 'teams'];

/**
 * 저장된 사이드바 보기 → 지금의 보기.
 *
 * [앱] 은 사이드바였다가 탭이 되었다(2026-09-30). 그때 저장된 'apps' 와, 이름을 앱으로
 * 바꾸기 전(2026-09-28)의 'artifacts' 는 기본 보기로 연다. 모르는 값(다른 버전이 쓴 것)도
 * 기본 보기로 — 아무 패널도 안 보이는 사이드바가 되지 않게.
 */
export function restoreSideView(value: unknown): SideView {
  return SIDE_VIEWS.includes(value as SideView) ? (value as SideView) : 'agent';
}
