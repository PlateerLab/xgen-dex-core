import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addWorkspaceTab,
  dropWorkspaceTab,
  findTab,
  newWorkspaceLayout,
  normalizeWorkspaceLayout,
  placeBrowserBesideChat,
  removeWorkspaceTab,
  setWorkspaceRatio,
} from '../src/renderer/src/views/workspace-layout';

const chat = (id: string) => ({ id, kind: 'chat' as const, sessionKey: id.slice(5) });
const workflowChat = (id: string, workflowId: string) => ({
  ...chat(id),
  workflowId,
  workflowName: workflowId,
});
const browser = (workflowId: string) => ({
  id: `browser:${workflowId}`,
  kind: 'browser' as const,
  workflowId,
  workflowName: workflowId,
});

test('edge drop creates one horizontal/vertical split and never a third group', () => {
  let layout = addWorkspaceTab(newWorkspaceLayout(), 'group-a', chat('chat:a'));
  layout = addWorkspaceTab(layout, 'group-a', chat('chat:b'));
  layout = dropWorkspaceTab(layout, 'chat:b', 'group-a', 'right');
  assert.equal(layout.groups.length, 2);
  assert.equal(layout.direction, 'horizontal');
  const second = findTab(layout, 'chat:b')!;
  assert.notEqual(second.group.id, 'group-a');
  const unchanged = dropWorkspaceTab(layout, 'chat:a', second.group.id, 'bottom');
  assert.deepEqual(unchanged, layout);
});

test('center drop moves a tab and removes its empty source group', () => {
  let layout = addWorkspaceTab(newWorkspaceLayout(), 'group-a', chat('chat:a'));
  layout = addWorkspaceTab(layout, 'group-a', chat('chat:b'));
  layout = dropWorkspaceTab(layout, 'chat:b', 'group-a', 'bottom');
  const secondId = findTab(layout, 'chat:b')!.group.id;
  layout = dropWorkspaceTab(layout, 'chat:b', 'group-a', 'center');
  assert.equal(layout.groups.length, 1);
  assert.equal(layout.groups[0].id, 'group-a');
  assert.deepEqual(
    layout.groups[0].tabs.map((tab) => tab.id),
    ['chat:a', 'chat:b'],
  );
  assert.equal(
    layout.groups.some((group) => group.id === secondId),
    false,
  );
});

test('closing the final tab collapses to a usable empty group and divider ratio is clamped', () => {
  let layout = addWorkspaceTab(newWorkspaceLayout(), 'group-a', chat('chat:a'));
  layout = removeWorkspaceTab(layout, 'chat:a');
  assert.equal(layout.groups.length, 1);
  assert.equal(layout.groups[0].tabs.length, 0);
  assert.equal(setWorkspaceRatio(layout, 0.01).ratio, 0.2);
  assert.equal(setWorkspaceRatio(layout, 0.99).ratio, 0.8);
});

test('persisted layout normalization deduplicates tabs, caps groups and repairs focus', () => {
  const layout = normalizeWorkspaceLayout({
    groups: [
      { id: 'a', tabs: [chat('chat:a')], activeTabId: 'missing' },
      { id: 'b', tabs: [chat('chat:a'), chat('chat:b')], activeTabId: 'chat:b' },
      { id: 'c', tabs: [chat('chat:c')], activeTabId: 'chat:c' },
    ],
    direction: 'vertical',
    ratio: 9,
    focusedGroupId: 'missing',
  });
  assert.equal(layout.groups.length, 2);
  assert.equal(layout.groups[0].activeTabId, 'chat:a');
  assert.deepEqual(
    layout.groups[1].tabs.map((tab) => tab.id),
    ['chat:b'],
  );
  assert.equal(layout.focusedGroupId, 'a');
  assert.equal(layout.direction, 'vertical');
  assert.equal(layout.ratio, 0.8);
});

test('agent browser opens in a new group beside its chat', () => {
  let layout = addWorkspaceTab(
    newWorkspaceLayout(),
    'group-a',
    workflowChat('chat:a', 'workflow-a'),
  );
  layout = placeBrowserBesideChat(layout, browser('workflow-a'));

  assert.equal(layout.groups.length, 2);
  assert.equal(layout.direction, 'horizontal');
  assert.equal(layout.groups[0].activeTabId, 'chat:a');
  assert.equal(layout.groups[1].activeTabId, 'browser:workflow-a');
});

test('agent browser reuses the group opposite its chat', () => {
  let layout = addWorkspaceTab(
    newWorkspaceLayout(),
    'group-a',
    workflowChat('chat:a', 'workflow-a'),
  );
  layout = addWorkspaceTab(layout, 'group-a', { id: 'avatar', kind: 'avatar' });
  layout = dropWorkspaceTab(layout, 'avatar', 'group-a', 'bottom');
  layout = placeBrowserBesideChat(layout, browser('workflow-a'));

  assert.equal(layout.groups.length, 2);
  assert.equal(layout.direction, 'horizontal');
  assert.equal(findTab(layout, 'chat:a')?.group.activeTabId, 'chat:a');
  assert.equal(findTab(layout, 'browser:workflow-a')?.group.activeTabId, 'browser:workflow-a');
  assert.notEqual(
    findTab(layout, 'chat:a')?.group.id,
    findTab(layout, 'browser:workflow-a')?.group.id,
  );
});

test('file-viewer 탭은 파일 필드와 함께 영속을 통과한다', () => {
  const restored = normalizeWorkspaceLayout({
    groups: [
      {
        id: 'g1',
        tabs: [
          {
            id: 'file:wf1:tools/a.py',
            kind: 'file-viewer',
            workflowId: 'wf1',
            fileRel: 'tools/a.py',
            fileName: 'a.py',
            fileSection: 'agent',
          },
          { id: 'bad', kind: 'file-viewer', fileSection: 'nope' },
        ],
        activeTabId: 'file:wf1:tools/a.py',
      },
    ],
    direction: 'horizontal',
    ratio: 0.5,
    focusedGroupId: 'g1',
  });
  const tabs = restored.groups[0].tabs;
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].kind, 'file-viewer');
  assert.equal(tabs[0].fileRel, 'tools/a.py');
  assert.equal(tabs[0].fileName, 'a.py');
  assert.equal(tabs[0].fileSection, 'agent');
  // 알 수 없는 fileSection 은 버려지되 탭 자체는 살아남는다.
  assert.equal(tabs[1].fileSection, undefined);
});
