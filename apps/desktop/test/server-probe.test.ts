// 서버 주소 자동 확정(https→http)과 로그인 실패 문구를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '@dex/protocol/client';
import {
  candidatesFor,
  isTlsVerifyError,
  loginErrorMessage,
  resolveServerUrl,
} from '../src/main/server-probe';

test('스킴이 없으면 https 를 먼저, http 를 다음에 시도한다', () => {
  assert.deepEqual(candidatesFor('dev-xgen.x2bee.com'), [
    'https://dev-xgen.x2bee.com',
    'http://dev-xgen.x2bee.com',
  ]);
});

test('스킴을 적었으면 그 주소만 시도한다', () => {
  assert.deepEqual(candidatesFor('http://10.0.0.5:8080/'), ['http://10.0.0.5:8080']);
  assert.deepEqual(candidatesFor('https://xgen.example.com//'), ['https://xgen.example.com']);
});

test('빈 입력은 후보가 없다', () => {
  assert.deepEqual(candidatesFor('   '), []);
  assert.deepEqual(candidatesFor('///'), []);
});

test('https 가 응답하면 https 로 확정한다', async () => {
  const tried: string[] = [];
  const r = await resolveServerUrl('xgen.example.com', async (u) => {
    tried.push(u);
  });
  assert.deepEqual(r, { url: 'https://xgen.example.com' });
  assert.deepEqual(tried, ['https://xgen.example.com']);
});

test('https 연결 불가 → http 가 응답하면 http 로 확정한다', async () => {
  const r = await resolveServerUrl('intranet-host', async (u) => {
    if (u.startsWith('https://')) {
      const e = new Error('fetch failed');
      (e as { cause?: unknown }).cause = { code: 'ECONNREFUSED' };
      throw e;
    }
  });
  assert.deepEqual(r, { url: 'http://intranet-host' });
});

test('https TLS 검증 실패는 "https 서버 있음"이다 — https 로 확정', async () => {
  const r = await resolveServerUrl('self-signed.example.com', async () => {
    const e = new Error('fetch failed');
    (e as { cause?: unknown }).cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN' };
    throw e;
  });
  assert.deepEqual(r, { url: 'https://self-signed.example.com' });
});

test('둘 다 연결 불가면 사유를 돌려준다', async () => {
  const r = await resolveServerUrl('no-such-host.example', async () => {
    const e = new Error('fetch failed');
    (e as { cause?: unknown }).cause = { code: 'ENOTFOUND' };
    throw e;
  });
  assert.ok('error' in r && r.error.includes('no-such-host.example'));
});

test('TLS 오류 분류 — cause.code 와 최상위 code 모두 읽는다', () => {
  const withCause = new Error('fetch failed');
  (withCause as { cause?: unknown }).cause = { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' };
  assert.equal(isTlsVerifyError(withCause), true);
  const plain = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
  assert.equal(isTlsVerifyError(plain), false);
});

test('401 은 자격 증명 문구로 바꾼다 — 상태코드 원문을 노출하지 않는다', () => {
  const msg = loginErrorMessage(new ApiError(401, 'POST /api/auth/login → 401'));
  assert.equal(msg, '이메일 또는 비밀번호가 올바르지 않습니다.');
  assert.ok(!msg.includes('401'));
});

test('서버가 사유를 실어 줬으면 그것을 우선한다', () => {
  const err = new ApiError(403, 'POST /api/auth/login → 403', { message: '계정이 잠겼습니다.' });
  assert.equal(loginErrorMessage(err), '계정이 잠겼습니다.');
});

test('5xx 는 서버 오류로, 네트워크 실패는 연결 안내로 말한다', () => {
  assert.ok(loginErrorMessage(new ApiError(503, 'x')).includes('서버 오류'));
  const netErr = new TypeError('fetch failed');
  assert.ok(loginErrorMessage(netErr).includes('연결할 수 없습니다'));
});

test('서버 거절 사유(일반 Error 문장)는 그대로 보여준다', () => {
  assert.equal(
    loginErrorMessage(new Error('비밀번호가 만료되었습니다.')),
    '비밀번호가 만료되었습니다.',
  );
});
