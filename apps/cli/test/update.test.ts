/**
 * `dex update` — 확인 · 갱신 · 안내.
 *
 * 여기서 지키는 것 셋:
 *  1. 확인 실패를 "최신입니다" 로 덮지 않는다 — 그러면 옛 버전에 조용히 남는다.
 *  2. 전역 설치가 아니면 npm 명령을 쏘지 않는다 — 엉뚱한 곳을 건드리거나 아무 일도
 *     안 일어나는데 사용자는 업데이트한 줄 안다.
 *  3. 실패의 진짜 이유를 짚는다 — npm 출력은 길고 원인이 묻힌다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdate, compareVersions, explainNpmFailure, fetchLatest } from '../src/update';

function registry(version: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

test('버전 비교', () => {
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
  assert.ok(compareVersions('1.2.3', '2.0.0') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '10 은 9 보다 크다 — 문자열 비교면 반대다');
  // 로컬에서 빌드한 앞선 버전은 '업데이트 있음' 이 아니다.
  assert.ok(compareVersions('1.4.0', '1.3.0') > 0);
  // prerelease 는 숫자 부분만 본다.
  assert.equal(compareVersions('1.4.0-rc.1', '1.4.0'), 0);
});

test('최신이면 outdated 가 아니다', async () => {
  const check = await checkForUpdate('1.3.0', registry('1.3.0'));
  assert.deepEqual(check, { current: '1.3.0', latest: '1.3.0', outdated: false });
});

test('새 버전이 있으면 outdated', async () => {
  const check = await checkForUpdate('1.3.0', registry('1.4.0'));
  assert.equal(check.outdated, true);
  assert.equal(check.latest, '1.4.0');
});

test('레지스트리가 실패하면 던진다 — 최신인 척하지 않는다', async () => {
  const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchLatest(failing), /503/);
});

test('레지스트리 응답에 version 이 없으면 던진다', async () => {
  const empty = (async () =>
    new Response('{}', { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => fetchLatest(empty), /version/);
});

test('권한 오류는 무엇을 하면 되는지까지 말한다', () => {
  const message = explainNpmFailure('npm error code EACCES\nnpm error syscall mkdir');
  assert.match(message, /권한/);
  assert.match(message, /npm config set prefix/, '해결 방법이 있어야 한다');
});

test('네트워크 오류를 권한 오류와 구분한다', () => {
  assert.match(explainNpmFailure('npm error code ENOTFOUND'), /네트워크/);
});

test('그 밖의 오류는 npm 이 말한 첫 줄을 그대로 보여 준다', () => {
  const message = explainNpmFailure(
    'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/nope',
  );
  assert.match(message, /E404|404/);
});
