/**
 * 실패를 사용자가 읽을 수 있게 — 코드 체계 (2026-09-09).
 *
 * 실제로 화면에 나갔던 것: `stream /api/agentflow/execute/based-id/stream → 502`.
 * 이 문장은 일반 사용자에게 아무 정보도 주지 않는다 — 무엇이 잘못됐는지, 자기가
 * 뭘 해야 하는지, 기다리면 되는지, 문의할 때 뭐라고 말해야 하는지 전부 알 수 없다.
 *
 * 여기서 못 박는 것:
 *   · 서버가 붙인 `[ERRORnnn: …]` 코드는 **그대로 존중**한다(관리자가 배포
 *     워크플로우에서 문구를 덮어쓴 경우까지 포함).
 *   · 서버가 말할 기회조차 없던 실패(502·네트워크·타임아웃)에도 코드가 붙는다.
 *   · 어떤 경우에도 기술 원문이 제목 자리에 오지 않는다 — 원문은 detail 에 보존.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INTERRUPTED_NOTE,
  INTERRUPTED_TEXT,
  TRANSPORT_CODES,
  describeError,
  describeHttpStatus,
  describeStreamError,
  formatErrorLine,
  parseServerErrorMarker,
} from '../src/errors';
import { frameToChatEvent } from '../src/chat';
import { ApiError } from '../src/client';

// ── 서버 코드는 서버의 것 ─────────────────────────────────────

test('서버 마커는 코드와 사용자용 메시지로 갈린다', () => {
  const parsed = parseServerErrorMarker('[ERROR510: 문서 검색 중 오류가 발생했습니다.]');
  assert.deepEqual(parsed, { code: 'XGEN-510', message: '문서 검색 중 오류가 발생했습니다.' });
});

test('서버가 쓴 문구를 다시 쓰지 않는다 — 관리자가 덮어쓴 문구도 그대로 존중', () => {
  const info = describeStreamError('[ERROR207: 사내 규정상 이 기능은 총무팀 승인이 필요합니다.]');
  assert.equal(info.code, 'XGEN-207');
  assert.equal(info.title, '사내 규정상 이 기능은 총무팀 승인이 필요합니다.');
});

test('마커가 본문에 날것으로 남지 않는다 — 제목은 사람이 읽는 문장뿐', () => {
  const info = describeStreamError('[ERROR304: AWS Bedrock 요청 검증에 실패했습니다.]');
  assert.ok(!info.title.includes('[ERROR'), `마커가 제목에 새어 나왔다: ${info.title}`);
  assert.ok(info.detail?.includes('[ERROR304'), '원문은 detail 에 보존돼야 한다');
});

// ── 서버가 말할 기회조차 없던 실패 ────────────────────────────

test('게이트웨이 502 — 실제 신고된 그 화면', () => {
  const err = new ApiError(
    502,
    'stream /api/agentflow/execute/based-id/stream → 502',
    '<html>502 Bad Gateway</html>',
  );
  const info = describeError(err);
  assert.equal(info.code, TRANSPORT_CODES.GATEWAY);
  assert.ok(!info.title.includes('/api/'), `URL 이 제목에 남았다: ${info.title}`);
  assert.ok(!info.title.includes('502'), '상태 코드 숫자를 사용자에게 들이대지 않는다');
  assert.ok(info.hint && info.hint.length > 0, '무엇을 하면 되는지 알려 줘야 한다');
  assert.equal(info.retryable, true, '재시도가 의미 있는 실패다');
  assert.ok(info.detail?.includes('→ 502'), '원문은 접어서 보존한다');
});

test('401 은 재시도가 아니라 재로그인이다', () => {
  const info = describeError(new ApiError(401, 'stream /x → 401', ''));
  assert.equal(info.code, TRANSPORT_CODES.UNAUTHORIZED);
  assert.equal(info.retryable, false);
  assert.match(info.hint ?? '', /로그인/);
});

test('403·404 는 사용자가 취할 행동이 다르다', () => {
  assert.equal(describeError(new ApiError(403, 'x', '')).code, TRANSPORT_CODES.FORBIDDEN);
  assert.equal(describeError(new ApiError(404, 'x', '')).code, TRANSPORT_CODES.NOT_FOUND);
});

test('429 는 기다리라고 말한다', () => {
  const info = describeError(new ApiError(429, 'x', ''));
  assert.equal(info.code, TRANSPORT_CODES.RATE_LIMITED);
  assert.equal(info.retryable, true);
});

test('네트워크가 아예 닿지 않은 경우', () => {
  const info = describeError(new TypeError('Failed to fetch'));
  assert.equal(info.code, TRANSPORT_CODES.OFFLINE);
  assert.match(info.title, /연결할 수 없습니다/);
});

test('시간 초과', () => {
  const info = describeError(new Error('Request timeout: 30000ms POST /api/x'));
  assert.equal(info.code, TRANSPORT_CODES.TIMEOUT);
  assert.equal(info.retryable, true);
});

test('정체 모를 실패도 코드를 받는다 — 추적할 수 있어야 한다', () => {
  const info = describeError(new Error('ECANCELED weird internal thing'));
  assert.equal(info.code, TRANSPORT_CODES.UNKNOWN);
  assert.ok(info.detail?.includes('ECANCELED'), '원문은 남는다');
});

test('응답 본문에 서버 마커가 있으면 상태 코드보다 그것을 믿는다', () => {
  const err = new ApiError(500, 'stream /x → 500', JSON.stringify({ detail: '[ERROR204: API 요청 한도를 초과했습니다.]' }));
  const info = describeError(err);
  assert.equal(info.code, 'XGEN-204');
  assert.equal(info.title, 'API 요청 한도를 초과했습니다.');
});

test('본문이 사람이 읽는 문장이면 제목으로 올린다', () => {
  const err = new ApiError(400, 'POST /x → 400', JSON.stringify({ detail: '첨부한 파일 형식을 지원하지 않습니다.' }));
  assert.equal(describeError(err).title, '첨부한 파일 형식을 지원하지 않습니다.');
});

test('본문이 HTML/JSON 덩어리면 제목으로 올리지 않는다', () => {
  const err = new ApiError(500, 'POST /x → 500', '{"trace": ["a", "b"], "code": 17}');
  const info = describeError(err);
  assert.equal(info.title, '서버에서 오류가 발생했습니다.');
});

// ── 스트림 오류 프레임 ────────────────────────────────────────

test('스트림 error 프레임이 코드를 달고 나온다', () => {
  const ev = frameToChatEvent('message', JSON.stringify({ type: 'error', detail: '[ERROR401: 워크플로우 실행 중 오류가 발생했습니다.]' }));
  assert.equal(ev?.kind, 'error');
  if (ev?.kind !== 'error') return;
  assert.equal(ev.detail, '[ERROR401: 워크플로우 실행 중 오류가 발생했습니다.]', '원문은 그대로 흐른다');
  assert.equal(ev.info?.code, 'XGEN-401');
  assert.equal(ev.info?.title, '워크플로우 실행 중 오류가 발생했습니다.');
});

test('스택/JSON 이 그대로 제목이 되지 않는다', () => {
  const info = describeStreamError('TypeError: x is not a function\n    at foo (/srv/app.js:12:9)');
  assert.equal(info.title, '응답을 생성하지 못했습니다.');
  assert.ok(info.detail?.includes('TypeError'), '원문은 접어서 보존한다');
});

test('서버가 마커 없이 사람 문장을 보내면 그것을 쓴다', () => {
  const info = describeStreamError('선택한 모델이 이 계정에서 사용 중지되었습니다.');
  assert.equal(info.title, '선택한 모델이 이 계정에서 사용 중지되었습니다.');
});

test('일시 중지된 워크플로우도 코드를 갖는다', () => {
  const ev = frameToChatEvent('execution_suspended', '{}');
  assert.equal(ev?.kind, 'error');
  if (ev?.kind !== 'error') return;
  assert.equal(ev.info?.code, 'XGEN-930');
  assert.equal(ev.info?.retryable, false);
});

// ── 표시 ─────────────────────────────────────────────────────

test('한 줄 포맷에는 코드가 들어가고 원문은 안 들어간다', () => {
  const line = formatErrorLine(describeError(new ApiError(502, 'stream /api/x → 502', '')));
  assert.ok(line.includes('XGEN-921'), '문의할 코드가 있어야 한다');
  assert.ok(!line.includes('/api/'), '원문 URL 이 새면 안 된다');
});

test('중단 문구는 한 곳에서만 온다 — 표면마다 달라지면 안 된다', () => {
  assert.equal(INTERRUPTED_TEXT, '작업이 중단되었습니다');
  // 본문 문구는 **서버가 기록에 남기는 그 글**이어야 한다
  // (xgen-workflow turn_outcome.INTERRUPTED_NOTE). 다르면 대화를 다시 여는
  // 순간 같은 턴의 설명이 바뀐다 — 화면과 기록이 두 말을 하면 어느 쪽도 못 믿는다.
  assert.equal(
    INTERRUPTED_NOTE,
    '[중단됨] 에이전트 실행이 중단되었습니다. 다시 시도해 주세요.',
  );
});

test('모든 상태 코드가 코드·제목·안내를 갖는다 (빈손으로 돌아오지 않는다)', () => {
  for (const status of [400, 401, 403, 404, 408, 413, 422, 429, 500, 502, 503, 504, 418, 599]) {
    const info = describeHttpStatus(status);
    assert.match(info.code, /^XGEN-9\d\d$/, `${status} 코드 없음`);
    assert.ok(info.title.length > 0, `${status} 제목 없음`);
    assert.ok(info.hint && info.hint.length > 0, `${status} 안내 없음`);
  }
});
