/**
 * 답변 피드백 — 서버와 말이 맞는가.
 *
 * 값이 어긋나면 화면에서는 멀쩡해 보이고 관리자 집계에서만 갈린다(같은 불만이 두 종류가 된다).
 * 그래서 보내는 모양과 읽는 모양을 여기서 못박는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDBACK_ISSUE_TYPES, FeedbackApi } from '../src/feedback';

interface Call { method: string; path: string; body?: unknown }

function fakeHttp(reply: unknown) {
  const calls: Call[] = [];
  const http = {
    get: async (path: string) => { calls.push({ method: 'GET', path }); return reply; },
    post: async (path: string, body?: unknown) => { calls.push({ method: 'POST', path, body }); return reply; },
    put: async (path: string, body?: unknown) => { calls.push({ method: 'PUT', path, body }); return reply; },
    del: async (path: string) => { calls.push({ method: 'DELETE', path }); return reply; },
  };
  return { http, calls };
}

const raw = {
  data: { id: 7, execution_io_id: 42, star_rating: 4, issue_type: '데이터 오류', comment: '숫자가 틀렸어요', created_at: '2026-09-17T00:00:00Z' },
};

test('문제 유형 목록은 서버가 아는 값 그대로다', () => {
  assert.deepEqual([...FEEDBACK_ISSUE_TYPES], ['이슈없음', '규정 위반', '데이터 오류', '환각(허위 정보)', '응답 실패', '기타']);
});

test('등록은 실행 id 와 함께 snake_case 로 보내고 읽기 쉬운 모양으로 돌려준다', async () => {
  const { http, calls } = fakeHttp(raw);
  const api = new FeedbackApi(http as never);
  const saved = await api.submit({ executionIoId: 42, starRating: 4, issueType: '데이터 오류', comment: '숫자가 틀렸어요' });
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/agentflow/feedback',
    body: { execution_io_id: 42, star_rating: 4, issue_type: '데이터 오류', comment: '숫자가 틀렸어요' },
  });
  assert.equal(saved.id, 7);
  assert.equal(saved.executionIoId, 42);
  assert.equal(saved.starRating, 4);
});

test('빈 코멘트는 보내지 않는다 — 서버에 빈 문자열을 남기지 않는다', async () => {
  const { http, calls } = fakeHttp(raw);
  await new FeedbackApi(http as never).submit({ executionIoId: 1, starRating: 5, issueType: '이슈없음' });
  assert.deepEqual(Object.keys(calls[0].body as object), ['execution_io_id', 'star_rating', 'issue_type']);
});

test('고칠 때는 바뀐 칸만 보낸다', async () => {
  const { http, calls } = fakeHttp(raw);
  await new FeedbackApi(http as never).update(7, { starRating: 2 });
  assert.equal(calls[0].path, '/api/agentflow/feedback/7');
  assert.deepEqual(calls[0].body, { star_rating: 2 });
});

test('내 피드백은 한 번에 읽고, 물어볼 것이 없으면 부르지 않는다', async () => {
  const { http, calls } = fakeHttp({ items: [raw.data] });
  const api = new FeedbackApi(http as never);
  assert.deepEqual(await api.mine([]), []);
  assert.equal(calls.length, 0, '빈 목록으로 서버를 부르지 않는다');
  const mine = await api.mine([42, 43]);
  assert.equal(calls[0].path, '/api/agentflow/feedback/me?execution_io_ids=42%2C43');
  assert.equal(mine[0].issueType, '데이터 오류');
});
