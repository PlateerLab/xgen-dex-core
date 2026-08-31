/** Pure, persistence-safe model for the two-group workspace. */

export type WorkspaceTabKind =
  | 'chat'
  | 'browser'
  | 'avatar'
  | 'teams'
  | 'settings'
  | 'agent-viewer';

/** 에이전트 뷰어가 처음 열 하위 탭 — 정의는 core(main 의 영속 스키마와 공유). */
import type { AgentViewerSub } from '../../../core/index';

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

function cleanTab(raw: unknown): WorkspaceTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const tab = raw as Partial<WorkspaceTab>;
  if (
    typeof tab.id !== 'string' ||
    !['chat', 'browser', 'avatar', 'teams', 'settings', 'agent-viewer'].includes(String(tab.kind))
  ) {
    return null;
  }
  const viewerSubs = ['memory', 'tasks', 'tools', 'storage', 'fulllog'];
  return {
    id: tab.id,
    kind: tab.kind as WorkspaceTabKind,
    sessionKey: typeof tab.sessionKey === 'string' ? tab.sessionKey : undefined,
    workflowId: typeof tab.workflowId === 'string' ? tab.workflowId : undefined,
    workflowName: typeof tab.workflowName === 'string' ? tab.workflowName : undefined,
    roomId: typeof tab.roomId === 'string' ? tab.roomId : undefined,
    roomName: typeof tab.roomName === 'string' ? tab.roomName : undefined,
    viewerSub: viewerSubs.includes(String(tab.viewerSub))
      ? (tab.viewerSub as AgentViewerSub)
      : undefined,
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

export function removeWorkspaceTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const groups = layout.groups
    .map((group) => {
      const index = group.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return group;
      const tabs = group.tabs.filter((tab) => tab.id !== tabId);
      const fallback = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
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
