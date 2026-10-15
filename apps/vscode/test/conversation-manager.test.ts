/**
 * 채팅 기록 관리 탭의 규칙(2026-10-10): 여러 대화 지우기(4개씩, 실패 모으기), 안내 글, 상태 필터, 탭이 그릴 것.
 * 글은 데스크톱 ConversationManager 와 같다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation } from '@dex/protocol';
import {
  DELETE_CONCURRENCY,
  deleteInBatches,
  deleteNotice,
  deleteQuestion,
  managerKind,
  managerView,
  pageForKind,
  purgeQuestion,
  type ManagerState,
} from '../src/conversation-manager';

const conv = (interactionId: string, rest: Partial<Conversation> = {}): Conversation => ({
  id: 1,
  interactionId,
  workflowId: 'wf',
  workflowName: 'gitlab',
  interactionCount: 2,
  metadata: {},
  createdAt: new Date(2026, 9, 1, 12).toISOString(),
  updatedAt: new Date(2026, 9, 9, 12).toISOString(),
  title: '',
  customTitle: false,
  tag: null,
  agentDeleted: false,
  agentOwnerId: null,
  compare: [],
  ...rest,
});

const key = (c: { workflowId: string; interactionId: string }): string => `${c.workflowId}\u0000${c.interactionId}`;
const NOW = new Date(2026, 9, 10, 15, 0);

test('여러 대화 지우기: 한 번에 4개씩 보내고, 실패한 것은 따로 모은다', async () => {
  const targets = Array.from({ length: 10 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const batches: number[][] = [];
  let current: number[] = [];
  const result = await deleteInBatches(targets, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    current.push(n);
    if (current.length === DELETE_CONCURRENCY || n === targets.length - 1) {
      batches.push(current);
      current = [];
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (n === 3 || n === 8) throw new Error('거절');
  });
  assert.equal(DELETE_CONCURRENCY, 4);
  assert.equal(peak, 4, '한 번에 4개를 넘게 보내지 않는다');
  assert.deepEqual(batches, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  assert.deepEqual(result.failed, [3, 8]);
  assert.deepEqual(result.gone, [0, 1, 2, 4, 5, 6, 7, 9]);
  assert.deepEqual(await deleteInBatches([], async () => undefined), { gone: [], failed: [] });
});

test('지우기 안내: 실패가 있으면 실패 수, 여러 개를 다 지웠으면 지운 수, 하나면 없다', () => {
  assert.equal(deleteNotice(3, 2), '채팅 2개는 삭제하지 못했습니다.');
  assert.equal(deleteNotice(5, 0), '채팅 5개를 삭제했습니다.');
  assert.equal(deleteNotice(1, 0), undefined);
  assert.equal(deleteNotice(0, 0), undefined);
});

test('묻는 글: 한 개면 그 제목, 여러 개면 수. 정리는 모두 지운다고', () => {
  assert.equal(deleteQuestion([conv('a', { title: '분기 매출' })]), '"분기 매출" 대화를 삭제할까요? 되돌릴 수 없습니다.');
  assert.equal(deleteQuestion([conv('a'), conv('b'), conv('c')]), '선택한 채팅 3개를 삭제할까요? 되돌릴 수 없습니다.');
  assert.equal(purgeQuestion(4), '에이전트가 사라진 채팅 4개를 모두 지웁니다. 되돌릴 수 없습니다.');
});

test('상태 필터: 모르는 값은 전체, 필터를 모르는 옛 엔진의 답은 같은 판정으로 거른다', () => {
  assert.equal(managerKind('deleted'), 'deleted');
  assert.equal(managerKind('nope'), 'all');
  assert.equal(managerKind(undefined), 'all');
  const deploy = conv('a'.repeat(40));
  const gone = conv('g', { agentDeleted: true });
  const active = conv('x');
  assert.deepEqual(pageForKind([deploy, gone, active], 'deploy'), { list: [deploy], ignored: true });
  assert.deepEqual(pageForKind([active], 'active'), { list: [active], ignored: false });
  assert.deepEqual(pageForKind([deploy, gone], 'all'), { list: [deploy, gone], ignored: false });
});

const state = (rest: Partial<ManagerState> = {}): ManagerState => ({
  kind: 'all',
  query: '',
  items: [],
  cursor: null,
  total: null,
  searchHasMore: false,
  deletedCount: 0,
  loading: false,
  loadingMore: false,
  selected: new Set(),
  busy: false,
  ...rest,
});

test('탭이 그릴 것: 줄, 총 수, 선택 수, 정리 버튼, 더 보기, 상태 글', () => {
  const items = [conv('a', { title: '배포 상태', tag: 'deploy' }), conv('c', { agentDeleted: true })];
  const view = managerView(state({ items, total: 120, cursor: 'next', deletedCount: 2, selected: new Set([key(items[0])]) }), NOW);
  assert.deepEqual(
    view.rows.map((r) => [r.title, r.agentName, r.agentDeleted, r.tagLabel ?? null, r.day, r.checked, r.openLabel]),
    [
      ['배포 상태', 'gitlab', false, '배포', '어제', true, '열기'],
      ['새 대화', '', true, null, '어제', false, '대화 보기'],
    ],
  );
  assert.deepEqual([view.total, view.selectedLabel, view.allSelected], ['총 120개', '1개 선택', false]);
  assert.deepEqual(view.purge, { label: '에이전트가 사라진 채팅 제거 (2)', disabled: false });
  assert.deepEqual(view.more, { label: '더 보기', disabled: false });

  const none = managerView(state({ items, selected: new Set(items.map(key)) }));
  assert.equal(none.allSelected, true);
  assert.equal('total' in none, false, '총 수를 모르면 숨긴다');
  assert.deepEqual(none.purge, { label: '에이전트가 사라진 채팅 제거 (0)', disabled: true, title: '정리할 채팅이 없습니다.' });

  assert.equal(managerView(state({ loading: true })).status, '불러오는 중…');
  assert.equal(managerView(state()).status, '채팅 기록이 없습니다.');
  assert.equal(managerView(state({ query: '매출' })).status, '맞는 채팅이 없습니다.');
  assert.equal(managerView(state({ error: '연결 끊김' })).error, '채팅 기록을 불러오지 못했습니다. 연결 끊김');
  const searching = managerView(state({ query: '매출', items, cursor: 'next', searchHasMore: true }));
  assert.equal('more' in searching, false, '검색 중에는 쪽을 넘기지 않는다');
  assert.equal(searching.searchMore, '맞는 채팅이 더 있습니다. 낱말을 더 적어 좁혀 보세요.');
});
