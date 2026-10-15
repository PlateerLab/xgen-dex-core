// 메인 영역 탭 모델 — 세션 → 탭 사상 규칙을 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionState } from '../src/renderer/src/session-store';
import { chatTabs, tabTitle, tabTooltip } from '../src/renderer/src/views/tab-model';

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
  remote: false,
    error: null,
    unseen: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

const msg = { role: 'user' as const, text: '안녕' };

test('탭은 삽입 순서를 유지한다 — 최근 활동으로 재정렬하지 않는다', () => {
  const a = session({ key: 'a', messages: [msg], updatedAt: 1 });
  const b = session({ key: 'b', messages: [msg], updatedAt: 99 });
  assert.deepEqual(
    chatTabs([a, b], 'a').map((s) => s.key),
    ['a', 'b'],
  );
});

test('빈 세션은 활성일 때만 탭으로 보인다', () => {
  const empty = session({ key: 'e' });
  const full = session({ key: 'f', messages: [msg] });
  assert.deepEqual(
    chatTabs([empty, full], 'e').map((s) => s.key),
    ['e', 'f'],
  );
  assert.deepEqual(
    chatTabs([empty, full], 'f').map((s) => s.key),
    ['f'],
  );
});

test('스트리밍 중인 세션은 비어 있어도 탭으로 남는다', () => {
  const s = session({ key: 's', streaming: true });
  assert.deepEqual(
    chatTabs([s], null).map((x) => x.key),
    ['s'],
  );
});

test('탭 제목은 대화 제목: 목록이 알려 준 제목, 모르면 첫 질문, 아무 말도 없으면 "새 대화"', () => {
  assert.equal(tabTitle(session({ key: 'a' })), '새 대화');
  assert.equal(tabTitle(session({ key: 'b', messages: [{ role: 'user', text: '  분기 매출\n정리해 줘 ' }] })), '분기 매출 정리해 줘');
  assert.equal(
    tabTitle(session({ key: 'c', title: '내가 붙인 이름', messages: [{ role: 'user', text: '첫 질문' }] })),
    '내가 붙인 이름',
  );
  const long = tabTitle(session({ key: 'd', messages: [{ role: 'user', text: '가'.repeat(100) }] }));
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
  // 같은 에이전트와의 대화 탭이 모두 에이전트 이름이던 예전 규칙은 쓰지 않는다. 에이전트는 툴팁에 남는다.
  assert.equal(tabTooltip(session({ key: 'e', title: '보고서' })), '봇 · 보고서');
});
