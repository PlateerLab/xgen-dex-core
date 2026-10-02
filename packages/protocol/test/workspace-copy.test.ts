import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COPY_FROM_WORKSPACE_TOOL,
  COPY_TO_WORKSPACE_TOOL,
  answerTurnFiles,
  copyTargetDir,
  copyToWorkspaceResult,
  deviceTimeText,
  shouldLookForTurnFiles,
  workspaceCopySchemas,
  workspaceDownloadOf,
  workspaceRelDir,
} from '../src/index';

test('두 도구의 카탈로그 — 이름·필수 인자', () => {
  const [to, from] = workspaceCopySchemas('phone');
  assert.equal(to.name, COPY_TO_WORKSPACE_TOOL);
  assert.deepEqual((to.inputSchema as { required: string[] }).required, ['paths']);
  assert.equal(from.name, COPY_FROM_WORKSPACE_TOOL);
  assert.deepEqual((from.inputSchema as { required: string[] }).required, ['source', 'path']);
  assert.match(to.description, /user's phone/);
});

test('폴더째 옮기면 그 폴더 이름부터 남고, 파일 하나는 첨부 폴더 바로 아래로 간다', () => {
  assert.equal(copyTargetDir('KakaoTalk', 'sub/a.docx'), 'KakaoTalk/sub');
  assert.equal(copyTargetDir('KakaoTalk', 'a.docx'), 'KakaoTalk');
  assert.equal(copyTargetDir('', 'a.docx'), '');
  assert.equal(copyTargetDir('x', '../../a.docx'), 'x', '거슬러 오르는 자리는 버린다');
  assert.equal(workspaceRelDir(' a\\b/../c/ '), 'a/b/c');
});

test('결과 — 모델이 읽는 글과 서버가 sandbox 에 들일 목록', () => {
  const r = copyToWorkspaceResult(
    [{ source: '/KakaoTalk/a.docx', path: 'uploads/users_1/conv/a.docx', size: 2048, sha256: 'abc' }],
    [{ source: '/KakaoTalk/big.mp4', reason: 'larger than 100MB' }],
  );
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /Copied 1 file\(s\)/);
  assert.match(r.content[0].text, /big\.mp4: larger than 100MB/);
  assert.deepEqual(r.structuredContent, {
    workspaceFiles: [{ path: 'uploads/users_1/conv/a.docx', size: 2048, sha256: 'abc' }],
  });
  assert.equal(copyToWorkspaceResult([], [{ source: 'x', reason: 'not found' }]).isError, true);
});

test('받을 거리 — 서버가 실은 임시 파일 주소만 믿는다', () => {
  assert.deepEqual(
    workspaceDownloadOf({ download: { url: '/api/agentflow/files/artifacts/abc/download', token: 't', name: 'a/b.docx' } }),
    { url: '/api/agentflow/files/artifacts/abc/download', token: 't', name: 'a_b.docx' },
  );
  assert.equal(workspaceDownloadOf({ download: { url: 'https://evil/x' } }), null);
  assert.equal(workspaceDownloadOf({}), null);
});

test('수정 시각은 기기 현지 시각 한 줄로', () => {
  const at = new Date(2026, 9, 2, 9, 5).getTime();
  assert.equal(deviceTimeText(at), '2026-10-02 09:05');
  assert.equal(deviceTimeText(0), '');
});

test('답의 작업 공간 파일 — 시작 시각을 아는 답은 그 사이, 모르는 답은 마지막 것만 본문 경로로', () => {
  const nodes = [
    { path: 'out/report.docx', name: 'report.docx', is_dir: false, size: 10, modified_at: new Date(1_000_000).toISOString(), origin: 'agent' },
    { path: 'uploads/x.png', name: 'x.png', is_dir: false, size: 10, modified_at: new Date(1_000_000).toISOString(), origin: 'web' },
  ];
  assert.deepEqual(
    answerTurnFiles(nodes as never, { startedAt: 1_000_000, lastEventAt: 1_000_500 }).map((n) => n.path),
    ['out/report.docx'],
  );
  assert.deepEqual(answerTurnFiles(nodes as never, { text: 'out/report.docx 에 저장' }, { latest: false }), []);
  assert.deepEqual(
    answerTurnFiles(nodes as never, { text: 'out/report.docx 에 저장' }, { latest: true }).map((n) => n.path),
    ['out/report.docx'],
  );
  assert.equal(shouldLookForTurnFiles({ role: 'assistant', streaming: true, startedAt: 1 }, true), false);
  assert.equal(shouldLookForTurnFiles({ role: 'assistant' }, false), false);
  assert.equal(shouldLookForTurnFiles({ role: 'assistant' }, true), true);
});

test('같은 에이전트의 목록을 동시에 물으면 한 번만 묻고, 끝난 뒤에는 새로 묻는다', async () => {
  const { sharedTreeFetch } = await import('../src/index');
  let calls = 0;
  let release: (v: string) => void = () => undefined;
  const fetchTree = sharedTreeFetch((wf: string) => {
    calls += 1;
    return new Promise<string>((resolve) => {
      release = (v) => resolve(`${wf}:${v}`);
    });
  });
  const a = fetchTree('wf');
  const b = fetchTree('wf');
  assert.equal(a, b);
  assert.equal(calls, 1);
  release('1');
  assert.equal(await a, 'wf:1');
  const c = fetchTree('wf');
  assert.equal(calls, 2, '끝난 요청은 다시 쓰지 않는다 — 방금 끝난 턴의 파일을 놓치지 않게');
  release('2');
  assert.equal(await c, 'wf:2');
  const failing = sharedTreeFetch(async () => {
    throw new Error('boom');
  });
  await assert.rejects(failing('x'));
  await assert.rejects(failing('x'), '실패도 붙잡아 두지 않는다');
});
