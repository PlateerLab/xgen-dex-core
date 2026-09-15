/**
 * "이 답변에서 만든 파일" 고르기.
 *
 * 파일 이름·확장자·도구 이름이 아니라 수정 시각과 출처로만 고른다 — 어떤 에이전트가 어떤 방법으로
 * 만들었든 같게 동작해야 한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WsNode } from '@dex/protocol';
import {
  filesChangedDuringTurn,
  formatFileSize,
  parentDir,
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

test('크기와 폴더 표기', () => {
  assert.equal(formatFileSize(512), '512B');
  assert.equal(formatFileSize(6572), '6.4KB');
  assert.equal(formatFileSize(3 * 1024 * 1024), '3.0MB');
  assert.equal(formatFileSize(undefined), '');
  assert.equal(parentDir('uploads/out/a.xlsx'), 'uploads/out');
  assert.equal(parentDir('a.xlsx'), '');
});
