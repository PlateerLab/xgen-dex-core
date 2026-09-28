// IDE 의 실패 봉투 — 서버·게이트웨이의 실패가 IDE 가 읽는 이유로 바뀌는가.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/client';
import { ideFailureOf, ideTerminalSocketPath, workspaceChangeSocketPath } from '../src/ide';

test('서버가 정한 이유와 상세(저장 충돌의 지금 판)를 그대로 넘긴다', () => {
  const f = ideFailureOf(new ApiError(409, 'Conflict', { detail: { code: 'changed', message: '그사이 바뀌었습니다', current_sha: 'abc' } }));
  assert.equal(f.code, 'changed');
  assert.equal(f.message, '그사이 바뀌었습니다');
  assert.equal(f.detail.current_sha, 'abc');
});

test('게이트웨이·파드 교체 중의 실패는 곧 돌아오는 이유로, 원문 대신 읽을 수 있는 문구로', () => {
  for (const [status, code] of [[500, 'server_error'], [502, 'unavailable'], [503, 'sandbox_unavailable'], [504, 'timeout']] as const) {
    const f = ideFailureOf(new ApiError(status, 'Bad Gateway', '<html>bad gateway</html>'));
    assert.equal(f.code, code);
    assert.equal(f.status, status);
    assert.equal(f.message, '서버에 잠시 닿지 않습니다');
  }
});

test('응답이 없으면 망·시간 초과로 본다', () => {
  assert.equal(ideFailureOf(new TypeError('fetch failed')).code, 'network');
  assert.equal(ideFailureOf(new Error('The operation was aborted due to timeout')).code, 'timeout');
});

test('소켓 경로 — 에이전트 id 를 인코딩한다', () => {
  assert.equal(workspaceChangeSocketPath('wf 1'), '/api/agentflow/ws/geny-workspace/wf%201');
  assert.equal(
    ideTerminalSocketPath('wf1', 't1', { rows: 24, cols: 80, create: false }),
    '/api/agentflow/ws/geny-ide/wf1/terminal/t1?rows=24&cols=80&create=0',
  );
});
