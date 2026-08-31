// 탐색기 사이드바 순수 모델 — 섹션 구성·경로 결합·정렬·크기 표시를 검증한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_ROOT,
  childPath,
  formatSize,
  sectionsFor,
  sortEntries,
  syncedAgo,
} from '../src/renderer/src/views/explorer-model';

test('동기화 에이전트가 없어도 XgenCloud 섹션은 항상 있다', () => {
  const sections = sectionsFor(null);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 'cloud');
  assert.equal(sections[0].title, 'XgenCloud');
  assert.equal(sections[0].kind, 'cloud');
  assert.equal(sections[0].path, CLOUD_ROOT);
});

test('로컬 동기화 중인 에이전트마다 섹션이 뒤따른다 (로컬 경로 포함)', () => {
  const sections = sectionsFor([
    {
      workflowId: 'wf-1',
      label: '마케팅 리서치',
      folder: '마케팅 리서치',
      dir: 'D:\\ws\\마케팅 리서치',
      syncing: true,
    },
    {
      workflowId: 'wf-2',
      label: '',
      folder: '보고서 봇',
      dir: '/home/u/ws/보고서 봇',
      syncing: false,
    },
  ]);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].id, 'agent:wf-1');
  assert.equal(sections[1].kind, 'agent');
  assert.equal(sections[1].title, '마케팅 리서치');
  assert.equal(sections[1].dir, 'D:\\ws\\마케팅 리서치');
  assert.equal(sections[1].syncing, true);
  // 에이전트 트리는 로컬 상대 경로 기준 — 루트는 빈 문자열.
  assert.equal(sections[1].path, '');
  // label 이 비면 폴더명이 제목이 된다 — 빈 헤더는 누를 수 없는 섹션이 된다.
  assert.equal(sections[2].title, '보고서 봇');
});

test('섹션 id 는 workflowId 기반이라 폴더명이 바뀌어도 접힘 상태가 유지된다', () => {
  const mk = (folder: string) =>
    sectionsFor([
      { workflowId: 'wf-1', label: folder, folder, dir: `/x/${folder}`, syncing: false },
    ]);
  assert.equal(mk('A')[1].id, mk('A2')[1].id);
});

test('childPath — 드라이브 루트("/")와 로컬 루트("") 기준 모두 안전하다', () => {
  assert.equal(childPath('/', '프로젝트'), '/프로젝트');
  assert.equal(childPath('/프로젝트', '보고서.md'), '/프로젝트/보고서.md');
  assert.equal(childPath('', '메모'), '메모');
  assert.equal(childPath('메모', '초안.md'), '메모/초안.md');
});

test('정렬은 폴더 먼저, 그 다음 이름순이다', () => {
  const sorted = sortEntries([
    { name: 'b.txt', isDir: false, size: 1, mtime: 0 },
    { name: '나', isDir: true, size: 0, mtime: 0 },
    { name: 'a.txt', isDir: false, size: 1, mtime: 0 },
    { name: '가', isDir: true, size: 0, mtime: 0 },
  ]);
  assert.deepEqual(
    sorted.map((e) => e.name),
    ['가', '나', 'a.txt', 'b.txt'],
  );
});

test('정렬은 입력 배열을 바꾸지 않는다', () => {
  const input = [
    { name: 'b', isDir: false, size: 0, mtime: 0 },
    { name: 'a', isDir: false, size: 0, mtime: 0 },
  ];
  sortEntries(input);
  assert.equal(input[0].name, 'b');
});

test('파일 크기는 사람 단위로 줄인다', () => {
  assert.equal(formatSize(0), '0B');
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(1536), '1.5KB');
  assert.equal(formatSize(10 * 1024 * 1024), '10MB');
  assert.equal(formatSize(-1), '');
});

test('마지막 동기화 시각 표기', () => {
  const now = 1_000_000_000;
  assert.equal(syncedAgo(undefined, now), '');
  assert.equal(syncedAgo(now - 2_000, now), '방금 동기화');
  assert.equal(syncedAgo(now - 30_000, now), '30초 전 동기화');
  assert.equal(syncedAgo(now - 5 * 60_000, now), '5분 전 동기화');
  assert.equal(syncedAgo(now - 3 * 3_600_000, now), '3시간 전 동기화');
});
