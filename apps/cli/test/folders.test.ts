/** CLI 대화의 폴더 — 시작한 폴더가 작업 공간, 홈·루트는 붙이지 않는다. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { chatFolders, defaultWorkingFolders } from '../src/folders';

const home = homedir();
const repo = join(home, 'work', 'repo');

test('저장소에서 시작하면 그 폴더가 대화의 작업 공간이다', () => {
  assert.deepEqual(defaultWorkingFolders(repo, home), [resolve(repo)]);
});

test('홈이나 드라이브 루트에서 시작하면 폴더를 붙이지 않는다', () => {
  assert.deepEqual(defaultWorkingFolders(home, home), []);
  assert.deepEqual(defaultWorkingFolders(parse(resolve(repo)).root, home), []);
});

test('--folder 는 시작 폴더 기준으로 풀고, --no-folder 는 아무것도 붙이지 않는다', () => {
  assert.deepEqual(chatFolders({ folders: ['.', 'docs', 'docs'], cwd: repo }), [
    resolve(repo),
    resolve(repo, 'docs'),
  ]);
  assert.deepEqual(chatFolders({ noFolder: true, folders: ['docs'], cwd: repo }), []);
  assert.deepEqual(chatFolders({ cwd: repo }), [resolve(repo)]);
});
