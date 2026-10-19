/** Pure, persistence-safe model for the two-group workspace. */

export type WorkspaceTabKind =
  | 'chat'
  | 'browser'
  | 'teams'
  | 'settings'
  | 'agent-viewer'
  | 'agent-create'
  | 'file-viewer'
  /** [앱] — 내 앱·앱 스토어. 설정처럼 하나뿐인 탭이다(id 'apps'). */
  | 'apps'
  /** 채팅 기록 관리(2026-10-10). 대화 목록 머리 ⋯ 가 연다. 하나뿐인 탭이다(id 'history'). */
  | 'history';

/** 에이전트 뷰어가 처음 열 하위 탭 — 정의는 core(main 의 영속 스키마와 공유). */
import type { AgentViewerSub } from '@dex/protocol';

export type { AgentViewerSub };
export type SplitDirection = 'horizontal' | 'vertical';
export type DropEdge = 'center' | 'left' | 'right' | 'top' | 'bottom';

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  sessionKey?: string;
  workflowId?: string;
  workflowName?: string;
  /** kind==='teams' 일 때의 방 id / 표시 이름. */
  roomId?: string;
  roomName?: string;
  /** kind==='agent-viewer' 일 때 처음 열 하위 탭. */
  viewerSub?: AgentViewerSub;
  /**
   * kind==='agent-viewer' 의 [앱] 하위 탭에서 고른 앱(폴더 이름). [앱] 탭의 [열기] 가 이 값으로
   * 그 앱을 골라 연다. 고른 것이 바뀌면 뷰어가 다시 적어 두므로 재시작 뒤에도 같은 앱이 열린다.
   */
  viewerApp?: string;
  /** kind==='file-viewer' — 탐색기에서 연 파일. */
  fileRel?: string;
  fileName?: string;
  fileSection?: 'cloud' | 'agent';
  /**
   * kind==='agent-viewer' 를 연 탭(대개 채팅의 [상세]). 상세 탭을 닫거나 머리의 ← 를 누르면 그 탭으로
   * 돌아간다(2026-10-19). 예전에는 닫으면 자리상 옆 탭으로 가서, 상세를 연 대화가 아닌 곳에 떨어졌다.
   */
  openerTabId?: string;
}

export interface WorkspaceGroup {
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
}

export interface WorkspaceLayout {
  groups: WorkspaceGroup[];
  direction: SplitDirection;
  ratio: number;
  focusedGroupId: string;
}

export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

export function newWorkspaceLayout(groupId = 'group-a'): WorkspaceLayout {
  return {
    groups: [{ id: groupId, tabs: [], activeTabId: null }],
    direction: 'horizontal',
    ratio: 0.5,
    focusedGroupId: groupId,
  };
}

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}


/** 저장된 뷰어 탭 → 지금의 탭. 이름을 앱으로 바꾸기 전(2026-09-28)에 저장된 'artifacts' 는 'apps' 다. */
function restoredSub(value: unknown): AgentViewerSub {
  return (value === 'artifacts' ? 'apps' : value) as AgentViewerSub;
}

function cleanTab(raw: unknown): WorkspaceTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const tab = raw as Partial<WorkspaceTab>;
  if (
    typeof tab.id !== 'string' ||
    // 옛 [아바타 설정] 탭('avatar')은 설정의 [아바타 설정] 탭으로 들어갔다(2026-09-29) — 버린다.
    !['chat', 'browser', 'teams', 'settings', 'agent-viewer', 'file-viewer', 'apps', 'history'].includes(
      String(tab.kind),
    )
  ) {
    return null;
  }
  // AgentViewerSub 전부 — 하나라도 빠지면 그 탭으로 열려 있던 뷰어가 재시작 후
  // 조용히 기본 탭으로 돌아간다. ('basic' 이 실제로 그렇게 빠져 있었다.)
  const viewerSubs: AgentViewerSub[] = [
    'basic',
    'workflow',
    'memory',
    'tasks',
    'tools',
    'apps',
    'storage',
    'fulllog',
  ];
  return {
    id: tab.id,
    kind: tab.kind as WorkspaceTabKind,
    sessionKey: typeof tab.sessionKey === 'string' ? tab.sessionKey : undefined,
    workflowId: typeof tab.workflowId === 'string' ? tab.workflowId : undefined,
    workflowName: typeof tab.workflowName === 'string' ? tab.workflowName : undefined,
    roomId: typeof tab.roomId === 'string' ? tab.roomId : undefined,
    roomName: typeof tab.roomName === 'string' ? tab.roomName : undefined,
    fileRel: typeof tab.fileRel === 'string' ? tab.fileRel : undefined,
    fileName: typeof tab.fileName === 'string' ? tab.fileName : undefined,
    fileSection: tab.fileSection === 'cloud' || tab.fileSection === 'agent' ? tab.fileSection : undefined,
    // 이름을 앱으로 바꾸기 전(2026-09-28)에 저장된 탭은 'artifacts' 다 — 같은 탭으로 연다.
    viewerSub: viewerSubs.includes(restoredSub(tab.viewerSub)) ? restoredSub(tab.viewerSub) : undefined,
    viewerApp: typeof tab.viewerApp === 'string' && tab.viewerApp ? tab.viewerApp : undefined,
    // 다시 켜도 상세의 ← 가 연 대화로 돌아가게(그 탭이 되살아나지 않았으면 openerOf 가 null 이다).
    openerTabId: typeof tab.openerTabId === 'string' && tab.openerTabId ? tab.openerTabId : undefined,
  };
}

/** Validate old/corrupt config and enforce the hard two-group limit. */
export function normalizeWorkspaceLayout(raw: unknown): WorkspaceLayout {
  if (!raw || typeof raw !== 'object') return newWorkspaceLayout();
  const value = raw as Partial<WorkspaceLayout>;
  const seen = new Set<string>();
  const groups = (Array.isArray(value.groups) ? value.groups : [])
    .slice(0, 2)
    .flatMap((candidate, index): WorkspaceGroup[] => {
      if (!candidate || typeof candidate !== 'object') return [];
      const group = candidate as Partial<WorkspaceGroup>;
      const id = typeof group.id === 'string' && group.id ? group.id : `group-${index + 1}`;
      const tabs = (Array.isArray(group.tabs) ? group.tabs : []).flatMap((tab) => {
        const clean = cleanTab(tab);
        if (!clean || seen.has(clean.id)) return [];
        seen.add(clean.id);
        return [clean];
      });
      const active = tabs.some((tab) => tab.id === group.activeTabId)
        ? String(group.activeTabId)
        : (tabs[0]?.id ?? null);
      return [{ id, tabs, activeTabId: active }];
    });
  const nonEmpty = groups.filter((group) => group.tabs.length > 0);
  const normalized = nonEmpty.length ? nonEmpty : groups.slice(0, 1);
  if (!normalized.length) return newWorkspaceLayout();
  const focused = normalized.some((group) => group.id === value.focusedGroupId)
    ? String(value.focusedGroupId)
    : normalized[0].id;
  return {
    groups: normalized,
    direction: value.direction === 'vertical' ? 'vertical' : 'horizontal',
    ratio: clampSplitRatio(Number(value.ratio)),
    focusedGroupId: focused,
  };
}

export function findTab(
  layout: WorkspaceLayout,
  tabId: string,
): { group: WorkspaceGroup; tab: WorkspaceTab } | null {
  for (const group of layout.groups) {
    const tab = group.tabs.find((item) => item.id === tabId);
    if (tab) return { group, tab };
  }
  return null;
}

export function selectWorkspaceTab(
  layout: WorkspaceLayout,
  groupId: string,
  tabId: string,
): WorkspaceLayout {
  if (
    !layout.groups.some(
      (group) => group.id === groupId && group.tabs.some((tab) => tab.id === tabId),
    )
  ) {
    return layout;
  }
  return {
    ...layout,
    focusedGroupId: groupId,
    groups: layout.groups.map((group) =>
      group.id === groupId ? { ...group, activeTabId: tabId } : group,
    ),
  };
}

export function addWorkspaceTab(
  layout: WorkspaceLayout,
  groupId: string,
  tab: WorkspaceTab,
): WorkspaceLayout {
  const existing = findTab(layout, tab.id);
  if (existing) return selectWorkspaceTab(layout, existing.group.id, tab.id);
  const target = layout.groups.some((group) => group.id === groupId)
    ? groupId
    : layout.focusedGroupId;
  return {
    ...layout,
    focusedGroupId: target,
    groups: layout.groups.map((group) =>
      group.id === target ? { ...group, tabs: [...group.tabs, tab], activeTabId: tab.id } : group,
    ),
  };
}

/**
 * Reveal an agent-created browser beside a chat from the same workflow.
 *
 * A one-group layout becomes a left(chat)/right(browser) split. When the user
 * already has two groups, the group opposite the chat is reused so the hard
 * two-group limit is preserved.
 */
export function placeBrowserBesideChat(
  layout: WorkspaceLayout,
  browserTab: WorkspaceTab,
): WorkspaceLayout {
  const matchingChats = layout.groups.flatMap((group) =>
    group.tabs
      .filter(
        (tab) =>
          tab.kind === 'chat' &&
          !!browserTab.workflowId &&
          tab.workflowId === browserTab.workflowId,
      )
      .map((tab) => ({ group, tab })),
  );
  const chat =
    matchingChats.find(({ group, tab }) => group.activeTabId === tab.id) ?? matchingChats[0];
  const existing = findTab(layout, browserTab.id);
  if (!chat) {
    return existing
      ? selectWorkspaceTab(layout, existing.group.id, existing.tab.id)
      : addWorkspaceTab(layout, layout.focusedGroupId, browserTab);
  }

  let next = selectWorkspaceTab(layout, chat.group.id, chat.tab.id);
  let browser = findTab(next, browserTab.id);
  if (next.groups.length === 1) {
    if (!browser) next = addWorkspaceTab(next, chat.group.id, browserTab);
    next = dropWorkspaceTab(next, browserTab.id, chat.group.id, 'right');
  } else {
    const chatNow = findTab(next, chat.tab.id)!;
    const opposite = next.groups.find((group) => group.id !== chatNow.group.id)!;
    browser = findTab(next, browserTab.id);
    next = browser
      ? browser.group.id === opposite.id
        ? selectWorkspaceTab(next, opposite.id, browserTab.id)
        : dropWorkspaceTab(next, browserTab.id, opposite.id, 'center')
      : addWorkspaceTab(next, opposite.id, browserTab);
    next = { ...next, direction: 'horizontal' };
  }

  const chatNow = findTab(next, chat.tab.id);
  browser = findTab(next, browserTab.id);
  if (chatNow) next = selectWorkspaceTab(next, chatNow.group.id, chatNow.tab.id);
  if (browser) next = selectWorkspaceTab(next, browser.group.id, browser.tab.id);
  return next;
}

/**
 * 탭 줄의 [+](브라우저 열기) — 에이전트가 연 브라우저와 같은 자리에 둔다: 같은 에이전트의 채팅이 열려 있으면
 * 그 채팅 옆(placeBrowserBesideChat), 없으면 누른 그룹에 탭으로. 채팅과 같은 그룹에 쌓여 있던 브라우저도 옆으로 꺼낸다.
 * 같은 자리에 겹쳐 두고 싶으면 탭을 끌어 그룹 가운데에 놓는다.
 */
export function openBrowserTab(
  layout: WorkspaceLayout,
  groupId: string,
  browserTab: WorkspaceTab,
): WorkspaceLayout {
  const hasChat = layout.groups.some((group) =>
    group.tabs.some((tab) => tab.kind === 'chat' && !!browserTab.workflowId && tab.workflowId === browserTab.workflowId),
  );
  if (hasChat) return placeBrowserBesideChat(layout, browserTab);
  const existing = findTab(layout, browserTab.id);
  return existing
    ? selectWorkspaceTab(layout, existing.group.id, browserTab.id)
    : addWorkspaceTab(layout, groupId, browserTab);
}

/** 지금 포커스된 묶음에서 보이는 탭. 새 탭(상세 등)을 연 탭이다. */
export function focusedTabId(layout: WorkspaceLayout): string | null {
  return layout.groups.find((group) => group.id === layout.focusedGroupId)?.activeTabId ?? null;
}

/**
 * 탭을 열면서 그 탭을 연 탭을 적어 둔다. 이미 열려 있으면 그리로 가고, 연 탭을 지금 탭으로 바꾼다
 * (다른 대화의 [상세] 로 같은 에이전트의 상세에 다시 왔으면 이번에는 그 대화로 돌아간다).
 */
export function openWorkspaceTabFrom(
  layout: WorkspaceLayout,
  groupId: string,
  tab: WorkspaceTab,
): WorkspaceLayout {
  const from = focusedTabId(layout);
  const openerTabId = from && from !== tab.id ? from : undefined;
  const opened = addWorkspaceTab(layout, groupId, { ...tab, openerTabId: openerTabId ?? tab.openerTabId });
  if (!openerTabId) return opened;
  return {
    ...opened,
    groups: opened.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((item) => (item.id === tab.id ? { ...item, openerTabId } : item)),
    })),
  };
}

/** 이 탭을 연 탭이 아직 있으면 그 탭(과 묶음). 없으면 null. */
export function openerOf(layout: WorkspaceLayout, tabId: string): { groupId: string; tabId: string } | null {
  const openerTabId = findTab(layout, tabId)?.tab.openerTabId;
  if (!openerTabId) return null;
  const found = findTab(layout, openerTabId);
  return found ? { groupId: found.group.id, tabId: openerTabId } : null;
}

/** ← : 이 탭을 연 탭으로 간다(이 탭은 그대로 둔다). 연 탭이 없으면 바꾸지 않는다. */
export function returnToOpener(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const opener = openerOf(layout, tabId);
  if (!opener) return layout;
  return { ...selectWorkspaceTab(layout, opener.groupId, opener.tabId), focusedGroupId: opener.groupId };
}

export function removeWorkspaceTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const groups = layout.groups
    .map((group) => {
      const index = group.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return group;
      const tabs = group.tabs.filter((tab) => tab.id !== tabId);
      // 이 탭을 연 탭이 같은 묶음에 있으면 그리로 돌아간다. 없으면 자리상 옆 탭.
      const openerTabId = group.tabs[index].openerTabId;
      const fallback = (openerTabId && tabs.some((tab) => tab.id === openerTabId) ? openerTabId : null)
        ?? tabs[Math.min(index, tabs.length - 1)]?.id
        ?? null;
      return {
        ...group,
        tabs,
        activeTabId: group.activeTabId === tabId ? fallback : group.activeTabId,
      };
    })
    .filter((group) => group.tabs.length > 0);
  if (!groups.length) return newWorkspaceLayout(layout.groups[0]?.id ?? 'group-a');
  return {
    ...layout,
    groups,
    ratio: groups.length === 1 ? 0.5 : layout.ratio,
    focusedGroupId: groups.some((group) => group.id === layout.focusedGroupId)
      ? layout.focusedGroupId
      : groups[0].id,
  };
}

let groupSequence = 0;
function nextGroupId(layout: WorkspaceLayout): string {
  let id = '';
  do id = `group-${Date.now().toString(36)}-${++groupSequence}`;
  while (layout.groups.some((group) => group.id === id));
  return id;
}

/** Move a tab to a group, or create the only allowed split from an edge drop. */
export function dropWorkspaceTab(
  layout: WorkspaceLayout,
  tabId: string,
  targetGroupId: string,
  edge: DropEdge,
  index?: number,
): WorkspaceLayout {
  const found = findTab(layout, tabId);
  if (!found || !layout.groups.some((group) => group.id === targetGroupId)) return layout;
  if (edge !== 'center' && layout.groups.length >= 2) return layout;

  const without = layout.groups.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => tab.id !== tabId),
    activeTabId:
      group.activeTabId === tabId
        ? (group.tabs.filter((tab) => tab.id !== tabId)[0]?.id ?? null)
        : group.activeTabId,
  }));

  if (edge === 'center') {
    const moved = without.map((group) => {
      if (group.id !== targetGroupId) return group;
      const at = Math.max(0, Math.min(group.tabs.length, index ?? group.tabs.length));
      const tabs = group.tabs.slice();
      tabs.splice(at, 0, found.tab);
      return { ...group, tabs, activeTabId: tabId };
    });
    const groups = moved.filter((group) => group.tabs.length > 0);
    return {
      ...layout,
      groups,
      ratio: groups.length === 1 ? 0.5 : layout.ratio,
      focusedGroupId: targetGroupId,
    };
  }

  const targetIndex = without.findIndex((group) => group.id === targetGroupId);
  const fresh: WorkspaceGroup = { id: nextGroupId(layout), tabs: [found.tab], activeTabId: tabId };
  const target = without[targetIndex];
  const rest = without.filter((group) => group.id !== targetGroupId && group.tabs.length > 0);
  const before = edge === 'left' || edge === 'top';
  const groups = before ? [fresh, target, ...rest] : [target, fresh, ...rest];
  return {
    ...layout,
    groups: groups.filter((group) => group.tabs.length > 0).slice(0, 2),
    direction: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
    ratio: 0.5,
    focusedGroupId: fresh.id,
  };
}

export function setWorkspaceRatio(layout: WorkspaceLayout, ratio: number): WorkspaceLayout {
  return { ...layout, ratio: clampSplitRatio(ratio) };
}
