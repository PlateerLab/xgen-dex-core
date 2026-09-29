/**
 * [IDE] 로 보는 동안 앱 사이드바(대화·탐색기·Teams…)를 접는다 — IDE 가 자기 사이드바(탐색기·찾기·
 * 소스 제어)를 갖고 있어서, 둘이 나란히 서면 편집기 자리만 줄어든다.
 *
 * - IDE 로 바뀌는 순간 사이드바가 열려 있으면 접고, 접었다는 것을 기억한다.
 * - 채팅으로 돌아오면(또는 IDE 가 아닌 탭으로 옮기면) 우리가 접은 것만 다시 편다.
 * - IDE 에 있는 동안 사용자가 사이드바를 직접 열었으면 그 선택을 따른다 — 돌아올 때 건드리지 않는다.
 *
 * 순수 함수다. 화면(Workspace)은 전환과 사이드바 변화를 여기에 넘기고 결과대로 둔다.
 */
export interface IdeSidebarState {
  /** 사이드바가 접혀 있는가. */
  collapsed: boolean;
  /** IDE 로 바뀌면서 **우리가** 접었는가. */
  autoCollapsed: boolean;
}

/** 지금 보는 탭이 IDE 인지가 바뀌었다. */
export function onIdeViewChange(wasIde: boolean, isIde: boolean, s: IdeSidebarState): IdeSidebarState {
  if (!wasIde && isIde) {
    return s.collapsed ? { collapsed: true, autoCollapsed: false } : { collapsed: true, autoCollapsed: true };
  }
  if (wasIde && !isIde) {
    return s.autoCollapsed ? { collapsed: false, autoCollapsed: false } : { ...s, autoCollapsed: false };
  }
  return s;
}

/** 사용자가 사이드바를 열었다·접었다(IDE 안에서) — 열었으면 그 뒤로는 사용자의 선택이다. */
export function onSidebarToggle(isIde: boolean, collapsed: boolean, s: IdeSidebarState): IdeSidebarState {
  if (isIde && !collapsed) return { collapsed, autoCollapsed: false };
  return { ...s, collapsed };
}
