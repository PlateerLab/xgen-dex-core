/**
 * "이 답변에서 만든 파일" 고르기.
 *
 * 바뀐 파일은 수정 시각과 출처로만, 결과물은 그 턴의 요청·답 글에 적힌 이름·형식으로만 고른다 —
 * 어떤 에이전트가 어떤 방법으로 만들었든 같게 동작해야 하고, 박아 둔 파일 이름이 있으면 안 된다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WsNode } from '@dex/protocol';
import {
  filesChangedDuringTurn,
  formatFileSize,
  parentDir,
  requestBefore,
  splitRequestedFiles,
  TURN_FILE_SLACK_AFTER_MS,
  TURN_FILE_SLACK_BEFORE_MS,
} from '../src/renderer/src/views/turn-files-model';

const T0 = Date.parse('2026-09-15T14:00:00Z');
const node = (path: string, minutesFromT0: number, extra: Partial<WsNode> = {}): WsNode => ({
  name: path.split('/').pop() ?? path,
  path,
  is_dir: false,
  size: 100,
  modified_at: new Date(T0 + minutesFromT0 * 60_000).toISOString(),
  origin: 'agent',
  ...extra,
});

test('턴 동안 바뀐 파일만 고르고 경로 순으로 돌려준다', () => {
  const picked = filesChangedDuringTurn(
    [
      node('out/report.xlsx', 3),
      node('out/a.json', 4),
      node('old/before.csv', -30),
      node('later/after.txt', 40),
    ],
    T0,
    T0 + 5 * 60_000,
  );
  assert.deepEqual(picked.map((n) => n.path), ['out/a.json', 'out/report.xlsx']);
});

test('폴더·숨김 경로·사용자 업로드·시각 없는 항목은 뺀다', () => {
  const picked = filesChangedDuringTurn(
    [
      node('out', 1, { is_dir: true }),
      node('.xgeny/python-env.json', 1),
      node('uploads/source.pdf', 1, { origin: 'web' }),
      node('notes.md', 1, { modified_at: undefined }),
      node('result.png', 1, { origin: undefined }),
    ],
    T0,
    T0 + 2 * 60_000,
  );
  assert.deepEqual(picked.map((n) => n.path), ['result.png']);
});

test('서버와 PC 시계가 조금 어긋나도 경계 안이면 잡는다', () => {
  const end = T0 + 60_000;
  const early = node('early.txt', 0, { modified_at: new Date(T0 - TURN_FILE_SLACK_BEFORE_MS + 1000).toISOString() });
  const late = node('late.txt', 0, { modified_at: new Date(end + TURN_FILE_SLACK_AFTER_MS - 1000).toISOString() });
  assert.equal(filesChangedDuringTurn([early, late], T0, end).length, 2);
});

test('요청에 파일 형식이 있으면 그 형식만 결과물로, 나머지는 그 외로', () => {
  const files = [node('out/report.xlsx', 1), node('out/report.json', 1), node('work/raw_rows.json', 1), node('work/notes.txt', 1)];
  const { requested, others } = splitRequestedFiles(files, '분석해서 결과를 엑셀로 저장해 주세요.', '저장: out/report.xlsx, out/report.json');
  assert.deepEqual(requested.map((f) => f.name), ['report.xlsx']);
  assert.equal(others.length, 3);
});

test('요청에 적힌 파일 이름은 결과물로, 그 이름의 확장자는 형식 요청으로 치지 않는다', () => {
  const files = [node('a/sample.csv', 1), node('a/sample.json', 1), node('a/tmp_cache.json', 1)];
  const { requested, others } = splitRequestedFiles(files, 'data/sample.csv 와 같은 내용의 sample.json 을 만들어 주세요', '');
  assert.deepEqual(requested.map((f) => f.name), ['sample.csv', 'sample.json']);
  assert.deepEqual(others.map((f) => f.name), ['tmp_cache.json']);
});

test('원본 파일 이름 + 다른 형식 요청이면 요청한 형식만', () => {
  const files = [node('out/result.xlsx', 1), node('out/result.json', 1), node('work/raw.json', 1)];
  const { requested } = splitRequestedFiles(files, 'uploads/source.pdf 에서 표를 뽑아 결과를 엑셀로 저장해 주세요.', '');
  assert.deepEqual(requested.map((f) => f.name), ['result.xlsx']);
});

test('답변을 부른 요청은 앞의 가장 가까운 사용자 글', () => {
  const msgs = [
    { role: 'user', text: '첫 요청' },
    { role: 'assistant', text: '첫 답' },
    { role: 'user', text: '둘째 요청' },
    { role: 'system', text: '알림' },
    { role: 'assistant', text: '둘째 답' },
  ];
  assert.equal(requestBefore(msgs, 4), '둘째 요청');
  assert.equal(requestBefore(msgs, 1), '첫 요청');
  assert.equal(requestBefore(msgs, 0), '');
});

test('요청에 파일 언급이 없으면 답에 이름이 나온 파일, 그것도 없으면 전부 그 외', () => {
  const files = [node('out/summary.md', 1), node('work/step1.json', 1)];
  assert.deepEqual(splitRequestedFiles(files, '정리해 주세요', '요약은 out/summary.md 에 저장했습니다').requested.map((f) => f.name), ['summary.md']);
  const none = splitRequestedFiles(files, '정리해 주세요', '완료했습니다');
  assert.equal(none.requested.length, 0);
  assert.equal(none.others.length, 2);
});

test('영어 단어 속 형식 이름을 오인하지 않는다 (keyword ≠ word)', () => {
  const files = [node('a/list.docx', 1)];
  assert.equal(splitRequestedFiles(files, '검색 keyword 를 정리해 주세요', '').requested.length, 0);
});

test('크기와 폴더 표기', () => {
  assert.equal(formatFileSize(512), '512B');
  assert.equal(formatFileSize(6572), '6.4KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0MB');
  assert.equal(formatFileSize(undefined), '');
  assert.equal(parentDir('uploads/out/a.xlsx'), 'uploads/out');
  assert.equal(parentDir('a.xlsx'), '');
});
