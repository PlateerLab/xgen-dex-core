// 로컬 동기화 3-way 판정기 — 무한 부활(2026-08-06) 재발 방지가 핵심 계약이다.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conflictCopyName,
  isIgnoredPath,
  isSafeRelPath,
  overlayRemote,
  planSync,
  snapshotRemote,
  type BaseState,
  type LocalState,
  type RemoteState,
} from '../src/main/sync-plan';

const sig = (sha: string) => ({ sha, size: 1, mtimeMs: 1000 });
const rf = (sha: string) => ({ sha, size: 1, mtimeMs: 1000 });

function plan(b: Record<string, string>, l: Record<string, string>, r: Record<string, string>) {
  const base: BaseState = new Map(Object.entries(b).map(([p, s]) => [p, sig(s)]));
  const local: LocalState = new Map(Object.entries(l).map(([p, s]) => [p, sig(s)]));
  const remote: RemoteState = new Map(Object.entries(r).map(([p, s]) => [p, rf(s)]));
  return planSync(base, local, remote).sort((x, y) => x.path.localeCompare(y.path));
}

test('삼자 일치는 아무 것도 하지 않는다', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'x' }, { 'a.md': 'x' }), []);
});

test('서버만 변했으면 내려받는다', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'x' }, { 'a.md': 'y' }), [
    { kind: 'download', path: 'a.md', sha: 'y' },
  ]);
});

test('서버 신규 파일은 내려받는다', () => {
  assert.deepEqual(plan({}, {}, { 'new.md': 'n' }), [
    { kind: 'download', path: 'new.md', sha: 'n' },
  ]);
});

test('로컬만 변했으면 base_sha 를 실어 올린다', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'y' }, { 'a.md': 'x' }), [
    { kind: 'upload', path: 'a.md', baseSha: 'x' },
  ]);
});

test('로컬 신규 파일은 빈 base_sha 로 올린다', () => {
  assert.deepEqual(plan({}, { 'new.md': 'n' }, {}), [
    { kind: 'upload', path: 'new.md', baseSha: '' },
  ]);
});

test('무한 부활 방지 — 서버가 지운 파일은 로컬을 지우지, 다시 올리지 않는다', () => {
  // 레거시 엔진의 사고: base 없이 "로컬에 있으니 올린다"로 판정해 부활시켰다.
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'x' }, {}), [
    { kind: 'delete-local', path: 'a.md' },
  ]);
});

test('로컬이 지운 파일은 서버에서도 지운다 (base_sha 로 안전하게)', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, {}, { 'a.md': 'x' }), [
    { kind: 'delete-remote', path: 'a.md', baseSha: 'x' },
  ]);
});

test('양쪽 모두 지웠으면 base 만 정리한다', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, {}, {}), [{ kind: 'forget', path: 'a.md' }]);
});

test('양쪽이 다르게 변했으면 충돌 — 서버 채택 + 로컬 보존', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'l' }, { 'a.md': 'r' }), [
    { kind: 'conflict', path: 'a.md', remoteSha: 'r' },
  ]);
});

test('양쪽이 같은 내용으로 변했으면 전송 없이 base 만 맞춘다', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 's' }, { 'a.md': 's' }), [
    { kind: 'adopt', path: 'a.md', sha: 's', size: 1, mtimeMs: 1000 },
  ]);
});

test('서버 삭제 + 로컬 수정 → 로컬을 잃지 않는다 (새 파일로 올림)', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, { 'a.md': 'y' }, {}), [
    { kind: 'upload', path: 'a.md', baseSha: '' },
  ]);
});

test('로컬 삭제 + 서버 수정 → 서버를 잃지 않는다 (되받음)', () => {
  assert.deepEqual(plan({ 'a.md': 'x' }, {}, { 'a.md': 'y' }), [
    { kind: 'download', path: 'a.md', sha: 'y' },
  ]);
});

test('overlayRemote — 델타가 안 온 경로는 base 가 곧 서버 상태다', () => {
  const base: BaseState = new Map([
    ['keep.md', sig('k')],
    ['gone.md', sig('g')],
  ]);
  const remote = overlayRemote(base, [
    { path: 'gone.md', is_dir: false, size: 0, mtime_ns: 0, sha256: '', deleted: true },
    { path: 'new.md', is_dir: false, size: 3, mtime_ns: 2e9, sha256: 'n', deleted: false },
    { path: '폴더', is_dir: true, size: 0, mtime_ns: 0, sha256: '', deleted: false },
  ]);
  assert.equal(remote.get('keep.md')?.sha, 'k');
  assert.equal(remote.has('gone.md'), false);
  assert.equal(remote.get('new.md')?.sha, 'n');
  assert.equal(remote.has('폴더'), false); // 디렉터리는 파일 경로에서 유도
});

test('snapshotRemote — 전체 스냅숏의 tombstone 도 안전하다', () => {
  const remote = snapshotRemote([
    { path: 'a.md', is_dir: false, size: 1, mtime_ns: 1e9, sha256: 'a', deleted: false },
    { path: 'old.md', is_dir: false, size: 0, mtime_ns: 0, sha256: '', deleted: true },
  ]);
  assert.deepEqual([...remote.keys()], ['a.md']);
});

test('기본 무시 목록 — sandbox SKIP_DIRS 미러', () => {
  assert.equal(isIgnoredPath('src/node_modules/pkg/index.js'), true);
  assert.equal(isIgnoredPath('.git/HEAD'), true);
  assert.equal(isIgnoredPath('.xgeny-session/state.json'), true);
  assert.equal(isIgnoredPath('보고서/최종.md'), false);
});

test('서버 sync_ignores 를 얹는다 — *.ext, dir/**, 이름 패턴', () => {
  const ig = ['*.tmp', 'build/**', '.cache'];
  assert.equal(isIgnoredPath('a/b/c.tmp', ig), true);
  assert.equal(isIgnoredPath('build/out.bin', ig), true);
  assert.equal(isIgnoredPath('src/.cache/x', ig), true);
  assert.equal(isIgnoredPath('src/main.ts', ig), false);
});

test('충돌 사본 이름 — 확장자 앞에 기기명·시각이 들어간다', () => {
  const name = conflictCopyName('보고서/최종.md', 'HRJANG-PC', new Date(2026, 7, 21, 14, 32));
  assert.equal(name, '보고서/최종 (충돌 HRJANG-PC 0821-1432).md');
  const noExt = conflictCopyName('README', 'a/b:c', new Date(2026, 7, 21, 14, 32));
  assert.equal(noExt, 'README (충돌 a-b-c 0821-1432)');
});

test('상대 경로 검증 — 폴더 밖을 가리키는 경로는 거른다', () => {
  assert.equal(isSafeRelPath('a/b.md'), true);
  assert.equal(isSafeRelPath('../etc/passwd'), false);
  assert.equal(isSafeRelPath('/abs'), false);
  assert.equal(isSafeRelPath('a/../b'), false);
  assert.equal(isSafeRelPath('a\\b'), false);
  assert.equal(isSafeRelPath(''), false);
});
