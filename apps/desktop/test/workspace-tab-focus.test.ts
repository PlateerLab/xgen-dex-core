/**
 * 워크스페이스 탭 포커스 — 백그라운드 채팅 갱신이 탭을 강제로 전환하지 않는다.
 *
 * layoutWithLiveSessions 는 세션 ↔ 탭을 구조적으로만(추가/제거) 맞추고 절대 포커스를
 * 건드리지 않는다. 포커스는 layoutWithActiveSession 이 activeKey 가 "진짜 바뀔 때만"
 * (새 대화를 열거나 이어보기할 때) 옮긴다 — 스트리밍 이벤트마다 새 sessions 배열
 * 참조가 나와도 activeKey 자체는 그대로이므로 재선택되지 않는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutWithLiveSessions, layoutWithActiveSession } from '../src/renderer/src/views/Workspace';
import {
  addWorkspaceTab,
  findTab,
  newWorkspaceLayout,
  selectWorkspaceTab,
  type WorkspaceTab,
} from '../src/renderer/src/views/workspace-layout';
import type { SessionState } from '../src/renderer/src/session-store';

function session(partial: Partial<SessionState> & { key: string }): SessionState {
  return {
    agent: {
      id: 1,
      workflowId: 'wf',
      workflowName: '봇',
      nodeCount: 0,
      isShared: false,
      isDeployed: false,
      isCompleted: true,
      workflowType: 'canvas',
      description: '',
      username: '',
      fullName: '',
      createdAt: '',
      updatedAt: '',
    },
    interactionId: partial.key,
    resume: false,
    loadingHistory: false,
    historyLoaded: true,
    messages: [],
    streaming: false,
    error: null,
    unseen: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

function settingsTab(): WorkspaceTab {
  return { id: 'settings', kind: 'settings' };
}

test('layoutWithLiveSessions: 새 살아있는 세션은 탭을 만들고 포커스한다', () => {
  const layout = newWorkspaceLayout();
  const next = layoutWithLiveSessions(layout, [session({ key: 'a' })]);
  const found = findTab(next, 'chat:a');
  assert.ok(found, '탭이 생겼다');
  assert.equal(next.groups[0].activeTabId, 'chat:a', '새 탭은 자동으로 포커스된다');
});

test('layoutWithLiveSessions: 더 이상 살아있지 않은 세션의 탭은 지운다', () => {
  let layout = newWorkspaceLayout();
  layout = layoutWithLiveSessions(layout, [session({ key: 'a' })]);
  layout = layoutWithLiveSessions(layout, []);
  assert.equal(findTab(layout, 'chat:a'), null);
});

test('회귀: 이미 존재하는 채팅 탭은 세션 갱신(sessions 배열 참조 변경)에도 포커스를 건드리지 않는다', () => {
  // 사용자가 채팅 A 에서 설정 탭으로 넘어간 상태를 재현 — activeTabId 는 settings.
  let layout = newWorkspaceLayout();
  layout = layoutWithLiveSessions(layout, [session({ key: 'a' })]); // A 탭 생성(+자동 포커스)
  layout = addWorkspaceTab(layout, layout.focusedGroupId, settingsTab()); // 설정 탭 생성(+자동 포커스)
  assert.equal(layout.groups[0].activeTabId, 'settings', '사전 조건: 지금은 설정 탭을 보고 있다');

  // A 가 스트리밍 중이라 session-store 가 emit 할 때마다 sessions 배열은 새 참조가 된다 —
  // 이 부분이 예전엔 layoutWithLiveSessions 안에서 activeKey 기준으로 chat:a 를 강제
  // 재선택했다(버그). 이제는 세 번을 다시 돌려도(새 참조 세 번) 포커스가 그대로여야 한다.
  for (let i = 0; i < 3; i++) {
    layout = layoutWithLiveSessions(layout, [session({ key: 'a', streaming: true, updatedAt: i })]);
  }
  assert.equal(
    layout.groups[0].activeTabId,
    'settings',
    '백그라운드 채팅 갱신이 설정 탭에서 채팅 탭으로 강제 전환하면 안 된다',
  );
});

test('layoutWithActiveSession: activeKey 에 해당하는 탭으로 포커스를 옮긴다', () => {
  let layout = newWorkspaceLayout();
  layout = layoutWithLiveSessions(layout, [session({ key: 'a' }), session({ key: 'b' })]);
  layout = selectWorkspaceTab(layout, layout.focusedGroupId, 'chat:a'); // 지금은 a 를 보는 중
  const next = layoutWithActiveSession(layout, 'b'); // 사이드바에서 b 를 "이어보기"
  assert.equal(next.groups[0].activeTabId, 'chat:b');
});

test('layoutWithActiveSession: activeKey 에 해당하는 탭이 없으면 아무것도 바꾸지 않는다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, settingsTab());
  const next = layoutWithActiveSession(layout, 'not-a-real-session');
  assert.equal(next, layout, '탭이 없으면 같은 참조를 돌려준다(불필요한 리렌더 방지)');
});

test('layoutWithActiveSession: activeKey 가 null 이면 아무것도 바꾸지 않는다', () => {
  const layout = newWorkspaceLayout();
  const next = layoutWithActiveSession(layout, null);
  assert.equal(next, layout);
});
