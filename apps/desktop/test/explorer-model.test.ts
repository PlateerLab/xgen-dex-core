// 탐색기 사이드바 순수 모델 — 섹션 구성·서버 트리 슬라이스·정렬·크기 표시.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  childPath,
  entriesAt,
  formatSize,
  sectionsFor,
  sortEntries,
  syncedAgo,
} from '../src/renderer/src/views/explorer-model';
import type { FileSystemStatusLike } from '../src/preload/index';

function status(over: Partial<FileSystemStatusLike> = {}): FileSystemStatusLike {
  return {
    loggedIn: true,
    dataRoot: '/home/u/xgen-dex',
    cloud: {
      enabled: false,
      dir: '/home/u/xgen-dex/cloud',
      owner: 'user:7',
      synced: false,
      syncing: false,
    },
    agents: { enabled: false, root: '/home/u/xgen-dex/agent_workspace', list: [] },
    ...over,
  };
}

test('상태가 없으면 섹션도 없다 (로그인 전)', () => {
  assert.deepEqual(sectionsFor(null), []);
});

test('XgenCloud 가 항상 먼저, 에이전트는 **동기화 여부와 무관하게 전부** 나온다', () => {
  const s = sectionsFor(
    status({
      agents: {
        enabled: false,
        root: '/r',
        list: [
          { workflowId: 'wf-a', label: '에이전트A', folder: '', dir: null, synced: false, syncing: false },
          { workflowId: 'wf-b', label: '에이전트B', folder: '', dir: null, synced: false, syncing: false },
        ],
      },
    }),
  );
  assert.equal(s[0].id, 'cloud');
  assert.equal(s[0].title, 'XgenCloud');
  assert.equal(s[0].workflowId, 'user:7'); // 서버 트리 읽기용 소유 키
  assert.equal(s[0].synced, false); // 토글 OFF → 서버 보기
  assert.deepEqual(
    s.slice(1).map((x) => [x.title, x.synced]),
    [
      ['에이전트A', false],
      ['에이전트B', false],
    ],
  );
});

test('동기화가 켜지면 synced 와 로컬 dir 이 실린다', () => {
  const s = sectionsFor(
    status({
      cloud: {
        enabled: true,
        dir: '/home/u/xgen-dex/cloud',
        owner: 'user:7',
        synced: true,
        syncing: false,
      },
      agents: {
        enabled: true,
        root: '/r',
        list: [
          {
            workflowId: 'wf-a',
            label: 'A',
            folder: 'A',
            dir: '/r/A',
            synced: true,
            syncing: false,
          },
        ],
      },
    }),
  );
  assert.equal(s[0].synced, true);
  assert.equal(s[0].dir, '/home/u/xgen-dex/cloud');
  assert.equal(s[1].synced, true);
  assert.equal(s[1].dir, '/r/A');
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

test('formatSize / syncedAgo 표시', () => {
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(2048), '2KB');
  assert.equal(syncedAgo(undefined, 1000), '');
  assert.equal(syncedAgo(1000, 3000), '방금 동기화');
});
