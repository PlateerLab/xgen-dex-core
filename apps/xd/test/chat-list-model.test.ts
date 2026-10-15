import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAPSED_KEY,
  agentLastLine,
  deleteNotice,
  deleteQuestion,
  freshFound,
  loadCollapsed,
  recentSlice,
  saveCollapsed,
} from '../src/renderer/src/chat-list-model';

test('최근 채팅·에이전트: 처음 5개, [더 보기] 마다 5개 더, [접기] 는 5개보다 많이 보일 때만', () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  assert.deepEqual(recentSlice(items, 5), { rows: [0, 1, 2, 3, 4], canMore: true, canCollapse: false });
  const ten = recentSlice(items, 10);
  assert.equal(ten.rows.length, 10);
  assert.equal(ten.canMore, true);
  assert.equal(ten.canCollapse, true);
  assert.deepEqual(recentSlice(items, 15), { rows: items, canMore: false, canCollapse: true });
  // 늘려 둔 뒤 대화가 줄면(지움) 보이는 것만큼
  assert.deepEqual(recentSlice([0, 1, 2], 10), { rows: [0, 1, 2], canMore: false, canCollapse: false });
  assert.deepEqual(recentSlice([], 5), { rows: [], canMore: false, canCollapse: false });
});

test('에이전트 줄의 둘째 줄: 마지막 대화 제목 · 날, 제목이 없으면 "새 대화"', () => {
  const now = new Date(2026, 9, 10, 15, 0);
  assert.equal(agentLastLine({ lastTitle: '보고서', lastActivity: new Date(2026, 9, 10, 9, 5).getTime() }, now), '보고서 · 09:05');
  assert.equal(agentLastLine({ lastTitle: '  ', lastActivity: new Date(2026, 9, 9, 23, 0).getTime() }, now), '새 대화 · 어제');
  assert.equal(agentLastLine({ lastTitle: '옛 대화', lastActivity: new Date(2025, 0, 2).getTime() }, now), '옛 대화 · 2025. 1. 2.');
});

test('접은 칸은 기억했다가 다시 켜면 그대로, 못 읽거나 못 쓰면 펼친 채로 동작한다', () => {
  const saved = new Map<string, string>();
  const storage = () => ({ getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
  assert.deepEqual(loadCollapsed(storage), { recent: false, agents: false });
  saveCollapsed({ recent: true, agents: false }, storage);
  assert.deepEqual(loadCollapsed(storage), { recent: true, agents: false });
  saved.set(COLLAPSED_KEY, '깨진 값');
  assert.deepEqual(loadCollapsed(storage), { recent: false, agents: false });
  const blocked = () => {
    throw new Error('막힘');
  };
  assert.deepEqual(loadCollapsed(blocked), { recent: false, agents: false });
  assert.doesNotThrow(() => saveCollapsed({ recent: false, agents: true }, blocked));
});

test('채팅 기록 관리: 삭제 확인과 알림 문구(Dex 와 같다), 답을 만드는 중이면 그 까닭', () => {
  assert.equal(deleteQuestion([{ title: '보고서' }]), '"보고서" 대화를 삭제할까요? 되돌릴 수 없습니다.');
  assert.equal(deleteQuestion([{ title: '' }]), '"새 대화" 대화를 삭제할까요? 되돌릴 수 없습니다.');
  assert.equal(deleteQuestion([{ title: 'a' }, { title: 'b' }, { title: 'c' }]), '선택한 채팅 3개를 삭제할까요? 되돌릴 수 없습니다.');
  assert.equal(deleteNotice({ deleted: 3, failed: 0, running: 0 }), '채팅 3개를 삭제했습니다.');
  assert.equal(deleteNotice({ deleted: 1, failed: 0, running: 0 }), null);
  assert.equal(deleteNotice({ deleted: 2, failed: 1, running: 0 }), '채팅 1개는 삭제하지 못했습니다.');
  assert.equal(
    deleteNotice({ deleted: 0, failed: 2, running: 1 }),
    '채팅 2개는 삭제하지 못했습니다. 답을 만드는 중인 채팅은 지울 수 없습니다.',
  );
});

test('찾은 대화는 지금 목록에 맞춘다: 바뀐 이름은 새 이름, 지워진 것은 빼고, 순서는 찾은 순서', () => {
  const found = [
    { id: 'x', title: '옛 이름' },
    { id: 'gone', title: '지운 것' },
    { id: 'y', title: 'Y' },
  ];
  const list = [
    { id: 'y', title: 'Y' },
    { id: 'x', title: '새 이름' },
    { id: 'z', title: '찾지 않은 것' },
  ];
  assert.deepEqual(freshFound(found, list), [
    { id: 'x', title: '새 이름' },
    { id: 'y', title: 'Y' },
  ]);
});
