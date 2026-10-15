import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canWrite,
  chooseDataRoot,
  ensureLayout,
  movedRootFile,
  readMovedRoot,
  rootLayout,
  writeMovedRoot,
} from '../src/main/data-root';

const base = {
  packaged: true,
  platform: 'win32' as NodeJS.Platform,
  exeDir: 'C:\\XD',
  home: '/home/u',
  writable: () => true,
};

test('Windows 설치본은 쓸 수 있으면 설치 폴더가 루트다 — 사용자 결정 "설치 폴더, 안 되면 ~/XD"', () => {
  assert.deepEqual(chooseDataRoot(base).source, 'install');
  assert.deepEqual(chooseDataRoot({ ...base, writable: () => false }), { root: join('/home/u', 'XD'), source: 'home' });
});

test('macOS·Linux 는 앱 묶음·AppImage·/opt 에 쓸 수 없어 홈의 XD 다', () => {
  for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
    assert.deepEqual(chooseDataRoot({ ...base, platform, exeDir: '/opt/XD' }), {
      root: join('/home/u', 'XD'),
      source: 'home',
    });
  }
});

test('환경 변수 > 옮긴 곳 > 개발 실행 순서로 앞선다', () => {
  assert.equal(chooseDataRoot({ ...base, env: '/tmp/x', moved: '/m' }).source, 'env');
  assert.equal(chooseDataRoot({ ...base, moved: '/m' }).source, 'moved');
  assert.deepEqual(chooseDataRoot({ ...base, packaged: false }), { root: join('/home/u', 'XD-dev'), source: 'dev' });
  assert.equal(chooseDataRoot({ ...base, env: '   ' }).source, 'install', '빈 값은 없는 것과 같다');
});

test('루트 아래 구조를 만들고, 옮긴 곳의 표지는 루트 밖에 둔다', () => {
  const root = mkdtempSync(join(tmpdir(), 'xd-root-'));
  const layout = rootLayout(root);
  ensureLayout(layout);
  for (const dir of [layout.workspace, layout.state, layout.electron, layout.logs]) assert.ok(existsSync(dir), dir);
  assert.equal(layout.workspace, join(root, 'workspace'));
  assert.equal(layout.electron, join(root, '.xd', 'electron'), '단일 실행 잠금이 루트 안 — 루트 하나에 앱 하나');
  assert.equal(canWrite(root), true);

  const appData = mkdtempSync(join(tmpdir(), 'xd-appdata-'));
  const file = movedRootFile(appData);
  assert.equal(readMovedRoot(file), undefined);
  writeMovedRoot(file, '/data/XD');
  assert.equal(readMovedRoot(file), '/data/XD');
  assert.match(readFileSync(file, 'utf8'), /"root": "\/data\/XD"/);
  writeMovedRoot(file, null);
  assert.equal(readMovedRoot(file), undefined);
});
