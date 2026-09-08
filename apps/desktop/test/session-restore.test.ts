/**
 * 실수로 닫았다 다시 켠다 — 진행 중이던 대화가 그 상태 그대로 돌아온다.
 *
 * 무엇을 고정하나
 * ───────────────
 * 서버 실행은 **연결이 아니라 대화**에 매여 있다. 커넥터를 닫아도(종료 신호가
 * 아니다) 턴은 계속 돈다. 그런데 다시 켰을 때 창이 그 대화를 열지 않으면, 돌고
 * 있는 실행은 화면에 없는 것과 같다 — [진행 중]도, [정지] 버튼도 없다. 사용자
 * 입장에서 "꺼졌다 켰더니 실행이 사라졌다" 와 구분되지 않는다.
 *
 * 여기서 고정하는 것 셋:
 *
 * 1. 저장된 배치의 대화 탭이 **제자리에** 남는다 (스토어가 비어 있는 첫 패스에서
 *    지워지지 않는다 — 지워졌다 다시 붙으면 분할·순서·포커스가 무너진다).
 * 2. 되살린 세션은 **포커스를 훔치지 않는다** — 복원은 사용자가 한 행동이 아니다.
 * 3. 되살아난 대화가 서버에서 아직 돌고 있으면 그 사실이 화면 상태로 돌아온다
 *    (`remote`) — 그것이 [정지] 버튼을 되살리는 값이다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  layoutForOwner,
  layoutWithLiveSessions,
  restorableChats,
} from '../src/renderer/src/views/Workspace';
import {
  addWorkspaceTab,
  findTab,
  newWorkspaceLayout,
  normalizeWorkspaceLayout,
  type WorkspaceTab,
} from '../src/renderer/src/views/workspace-layout';
import {
  SessionStore,
  isKeepable,
  type SessionState,
  type SessionTransport,
} from '../src/renderer/src/session-store';
import type { Agent, HistoryAttachment } from '@dex/protocol';

const flush = () => new Promise((r) => setTimeout(r, 0));

function chatTabOf(key: string, workflowId = 'wf', workflowName = '봇'): WorkspaceTab {
  return { id: `chat:${key}`, kind: 'chat', sessionKey: key, workflowId, workflowName };
}

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
    } as Agent,
    interactionId: partial.key,
    resume: false,
    loadingHistory: false,
    historyLoaded: true,
    messages: [],
    streaming: false,
    remote: false,
    error: null,
    unseen: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

// ── 1. 저장된 배치에서 되살릴 대화를 읽어낸다 ──────────────────────────
test('restorableChats: 저장된 대화 탭의 workflowId + interactionId 를 집는다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1', 'wf-a', '가'));
  layout = addWorkspaceTab(layout, layout.focusedGroupId, { id: 'settings', kind: 'settings' });
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-2', 'wf-b', '나'));

  assert.deepEqual(restorableChats(layout), [
    { workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' },
    { workflowId: 'wf-b', workflowName: '나', interactionId: 'int-2' },
  ]);
});

test('restorableChats: 앱 재시작 경로(정규화)를 그대로 통과한다', () => {
  // 실제로는 layout 이 config 에 JSON 으로 저장됐다가 normalize 를 거쳐 돌아온다.
  // 그 길에서 sessionKey·workflowId 가 떨어지면 되살릴 근거가 사라진다.
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1', 'wf-a', '가'));
  const reborn = normalizeWorkspaceLayout(JSON.parse(JSON.stringify(layout)));
  assert.deepEqual(restorableChats(reborn), [
    { workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' },
  ]);
});

// ── 2. 복원 대기 중인 탭은 제자리를 지킨다 ─────────────────────────────
test('앱을 켠 첫 패스: 세션이 아직 없어도 저장된 대화 탭이 사라지지 않는다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1'));
  layout = addWorkspaceTab(layout, layout.focusedGroupId, { id: 'settings', kind: 'settings' });

  // 스토어는 아직 비어 있다 — 복원 effect 는 첫 렌더 뒤에 돈다.
  const next = layoutWithLiveSessions(layout, [], new Set(['int-1']));

  assert.ok(findTab(next, 'chat:int-1'), '복원 대기 탭이 지워졌다');
  // 자리까지 그대로여야 한다. 지웠다 다시 붙이면 분할·순서·포커스가 무너진다.
  assert.deepEqual(
    next.groups.map((g) => g.tabs.map((t) => t.id)),
    layout.groups.map((g) => g.tabs.map((t) => t.id)),
  );
  assert.deepEqual(
    next.groups.map((g) => g.activeTabId),
    layout.groups.map((g) => g.activeTabId),
  );
});

test('대기표가 없으면(=사용자가 닫은 탭) 예전처럼 지워진다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1'));
  const next = layoutWithLiveSessions(layout, [], new Set());
  assert.equal(findTab(next, 'chat:int-1'), null, '죽은 대화 탭이 남았다');
});

test('되살아난 뒤에는 대기표 없이도 남는다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1'));
  const live = [session({ key: 'int-1', messages: [{ role: 'user', text: '안녕' }] })];
  const next = layoutWithLiveSessions(layout, live, new Set());
  assert.ok(findTab(next, 'chat:int-1'));
});

// ── 3. 스토어 복원 ────────────────────────────────────────────────────
function makeStore(running: Record<string, boolean> = {}, turns: Record<string, unknown[]> = {}) {
  const watched: string[] = [];
  const stopped: string[] = [];
  const transport: SessionTransport = {
    stream() {
      return { cancel: () => {}, stop: async () => {} };
    },
    async historyTurns() {
      return [];
    },
    async historySnapshot(_w, interactionId) {
      return {
        turns: (turns[interactionId] ?? []) as Array<{
          input: string;
          output: string;
          attachments?: HistoryAttachment[];
        }>,
        running: running[interactionId] === true,
      };
    },
    async stopChat(interactionId) {
      stopped.push(interactionId);
    },
    watchConversation(_workflowId, _name, interactionId) {
      watched.push(interactionId);
    },
  };
  let clock = 1000;
  return { store: new SessionStore(transport, () => clock++), watched, stopped };
}

test('restore: 대화를 되살리되 포커스는 옮기지 않는다', async () => {
  const { store, watched } = makeStore();
  store.restore([
    { workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' },
    { workflowId: 'wf-b', workflowName: '나', interactionId: 'int-2' },
  ]);

  assert.equal(store.getSnapshot().activeKey, null, '복원이 포커스를 가로챘다');
  assert.deepEqual(watched, ['int-1', 'int-2'], '대화 소켓 구독이 빠졌다');
  const keys = store.getSnapshot().sessions.map((s) => s.key).sort();
  assert.deepEqual(keys, ['int-1', 'int-2']);
  await flush();
});

test('restore: 서버에서 아직 도는 턴이면 [정지] 를 되살릴 상태가 돌아온다', async () => {
  const { store, stopped } = makeStore({ 'int-1': true });
  store.restore([{ workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' }]);
  await flush();

  const s = store.get('int-1')!;
  // Chat 의 busy = streaming || remote. 토큰은 이 창으로 흐르지 않으므로
  // streaming 은 거짓이고, 실행이 살아 있다는 사실은 remote 가 나른다.
  assert.equal(s.remote, true, '진행 중인 실행을 못 알아봤다');
  assert.equal(isKeepable(s), true, '진행 중인데 버려질 세션으로 분류됐다');

  // 그리고 그 버튼이 실제로 서버에 닿는다 — 이 창은 스트림 핸들이 없으므로
  // 정지는 transport.stopChat(대화를 향한 정지)로 나가야 한다.
  store.stop('int-1');
  assert.deepEqual(stopped, ['int-1']);
  assert.equal(store.get('int-1')!.remote, false);
});

test('restore: 이미 열려 있는 대화는 건드리지 않는다', async () => {
  const { store, watched } = makeStore();
  const agent: Agent = {
    id: 1,
    workflowId: 'wf-a',
    workflowName: '가',
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
  };
  const key = store.openResume(agent, 'int-1', '가');
  await flush();
  const before = store.get(key);

  store.restore([{ workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' }]);
  assert.equal(store.get('int-1'), before, '열린 세션을 복원이 덮어썼다');
  assert.deepEqual(watched, ['int-1'], '구독이 중복됐다');
});

test('restore: 히스토리가 도착하기 전에도 탭이 유지된다', () => {
  const { store } = makeStore();
  store.restore([{ workflowId: 'wf-a', workflowName: '가', interactionId: 'int-1' }]);
  const s = store.get('int-1')!;
  assert.equal(s.messages.length, 0);
  assert.equal(
    isKeepable(s),
    true,
    '히스토리를 받는 동안 빈 세션으로 읽혀 탭이 떴다 사라진다',
  );
});

test('빈 새 세션은 여전히 버려진다', () => {
  assert.equal(isKeepable(session({ key: 'x' })), false);
});

// ── 4. 계정이 바뀌면 대화 탭은 되살리지 않는다 ─────────────────────────
test('남의 배치면 대화 탭만 버리고 나머지는 남긴다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1', 'wf-a', '남의 봇'));
  layout = addWorkspaceTab(layout, layout.focusedGroupId, { id: 'settings', kind: 'settings' });

  const next = layoutForOwner(layout, 'user-1', 'user-2');
  assert.equal(findTab(next, 'chat:int-1'), null, '남의 대화 탭이 남았다');
  assert.ok(findTab(next, 'settings'), '이 PC 의 취향까지 버렸다');
  assert.deepEqual(restorableChats(next), []);
});

test('같은 계정이면 그대로 둔다', () => {
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1'));
  assert.equal(layoutForOwner(layout, 'user-1', 'user-1'), layout);
});

test('주인을 적기 전에 저장된 배치는 이 계정 것으로 본다', () => {
  // 업그레이드 한 번에 열어 두던 대화를 다 잃는 것이 더 나쁘다.
  let layout = newWorkspaceLayout();
  layout = addWorkspaceTab(layout, layout.focusedGroupId, chatTabOf('int-1'));
  assert.equal(layoutForOwner(layout, undefined, 'user-1'), layout);
});
