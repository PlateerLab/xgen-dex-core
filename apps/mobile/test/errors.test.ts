// 사용자 문구 매핑 — 와이어 문자열("POST /x → 401")을 그대로 노출하지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyError } from '../src/lib/errors';

test('서버 본문 message/detail 우선', () => {
  assert.equal(friendlyError({ status: 400, body: { message: '계정이 잠겼습니다' } }, 'f'), '계정이 잠겼습니다');
  assert.equal(friendlyError({ status: 422, body: { detail: { message: '입력 오류' } } }, 'f'), '입력 오류');
});

test('상태코드별 한국어 안내 — 401 은 자격증명 안내', () => {
  assert.equal(friendlyError({ status: 401, body: null }, 'f'), '이메일 또는 비밀번호가 올바르지 않습니다.');
  assert.equal(friendlyError({ status: 403, body: {} }, 'f'), '권한이 없습니다. 관리자에게 문의하세요.');
  assert.match(friendlyError({ status: 502, body: '' }, 'f'), /서버 오류\(502\)/);
});

test('와이어 형식 메시지는 숨기고 폴백을 쓴다', () => {
  const e = Object.assign(new Error('POST /api/auth/login → 401'), { status: 401 });
  assert.equal(friendlyError(e, 'f'), '이메일 또는 비밀번호가 올바르지 않습니다.');
  assert.equal(friendlyError(new Error('GET /api/x → 500'), '기본 안내'), '기본 안내');
  assert.equal(friendlyError(new Error('네트워크 연결 없음'), 'f'), '네트워크 연결 없음');
});
