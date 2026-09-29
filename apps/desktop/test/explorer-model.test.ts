// 탐색기 사이드바 순수 모델 — 섹션 구성·서버 트리 슬라이스·정렬·크기 표시.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_SECTION_KEY,
  childPath,
  entriesAt,
  formatSize,
  sectionsFor,
  sortEntries,
} from '../src/renderer/src/views/explorer-model';

test('파일 저장소가 항상 먼저, 에이전트는 서버 목록 그대로 전부 나온다', () => {
  const s = sectionsFor([
    { workflowId: 'wf-a', label: '에이전트A' },
    { workflowId: 'wf-b', label: '에이전트B' },
  ]);
  assert.deepEqual(
    s.map((x) => [x.id, x.title, x.kind, x.workflowId]),
    [
      ['cloud', '파일 저장소', 'cloud', CLOUD_SECTION_KEY],
      ['agent:wf-a', '에이전트A', 'agent', 'wf-a'],
      ['agent:wf-b', '에이전트B', 'agent', 'wf-b'],
    ],
  );
});

test('에이전트가 없어도 파일 저장소는 보인다', () => {
  assert.deepEqual(
    sectionsFor([]).map((x) => x.id),
    ['cloud'],
  );
});

test('entriesAt: 평면 서버 목록 → 한 디렉터리의 직계 자식 (중간 폴더 유도)', () => {
  const nodes = [
    { name: 'a.txt', path: 'a.txt', is_dir: false, size: 10 },
    { name: 'b.txt', path: 'docs/b.txt', is_dir: false, size: 20 },
    { name: 'c.txt', path: 'docs/deep/c.txt', is_dir: false, size: 30 },
  ];
  const root = entriesAt(nodes, '');
  assert.deepEqual(
    root.map((e) => [e.name, e.isDir]),
    [
      ['docs', true],
      ['a.txt', false],
    ],
  );
  const docs = entriesAt(nodes, 'docs');
  assert.deepEqual(
    docs.map((e) => [e.name, e.isDir]),
    [
      ['deep', true],
      ['b.txt', false],
    ],
  );
});

test('entriesAt: 폴더 항목이 명시된 목록도 그대로 처리한다', () => {
  const nodes = [
    { name: 'docs', path: 'docs', is_dir: true },
    { name: 'b.txt', path: 'docs/b.txt', is_dir: false, size: 5 },
  ];
  assert.deepEqual(
    entriesAt(nodes, '').map((e) => [e.name, e.isDir]),
    [['docs', true]],
  );
});

test('childPath — 상대 기준 결합', () => {
  assert.equal(childPath('', 'a'), 'a');
  assert.equal(childPath('a/b', 'c'), 'a/b/c');
});

test('sortEntries — 폴더 먼저, 한국어 이름순', () => {
  const out = sortEntries([
    { name: '나.txt', isDir: false, size: 1, mtime: 0 },
    { name: '가폴더', isDir: true, size: 0, mtime: 0 },
    { name: '가.txt', isDir: false, size: 1, mtime: 0 },
  ]);
  assert.deepEqual(
    out.map((e) => e.name),
    ['가폴더', '가.txt', '나.txt'],
  );
});

test('formatSize 표시', () => {
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(2048), '2KB');
});
