// 온디맨드 페어 폴더명 — 연결 없이 모든 에이전트가 로컬 폴더를 갖는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickFolderName, safeFolder, safeName } from '../src/main/local-sync-folder';

test('safeName — 상태 파일 id 는 ASCII 로 좁힌다', () => {
  assert.equal(safeName('conn-wf-123'), 'conn-wf-123');
  assert.equal(safeName('a/b:c'), 'a_b_c');
});

test('safeFolder — 한글은 보존하고 경로 금지문자만 없앤다', () => {
  assert.equal(safeFolder('마케팅 리서치'), '마케팅 리서치');
  assert.equal(safeFolder('Agentflow (25)'), 'Agentflow (25)');
  assert.equal(safeFolder('보고서/최종:본'), '보고서 최종 본');
  assert.equal(safeFolder('  new-shlee '), 'new-shlee'); // 하이픈 보존, 공백 정리
  assert.equal(safeFolder('끝점...'), '끝점');
});

test('폴더명은 라벨(한글 포함)을 그대로 살린다', () => {
  assert.equal(pickFolderName('wf-1', '보고서 봇', new Set()), '보고서 봇');
});

test('같은 이름의 다른 에이전트는 workflowId 꼬리로 구분한다', () => {
  const taken = new Set(['봇']);
  const name = pickFolderName('wf-abcdef123456', '봇', taken);
  assert.notEqual(name, '봇');
  assert.ok(name.startsWith('봇-'));
  assert.ok(name.endsWith('123456'));
});

test('라벨이 비면 workflowId 로, 그것도 비면 agent 로 폴백', () => {
  assert.equal(pickFolderName('wf-9', '', new Set()), 'wf-9');
  assert.equal(pickFolderName('', '', new Set()), 'agent');
});
