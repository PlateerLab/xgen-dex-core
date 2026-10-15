import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseFolderName, isValidFolderName, uniqueFolderName } from '../src/main/workspace-name';

const tricky = [
  '리서치 도우미',
  'My Agent',
  '../escape',
  '.hidden',
  'a/b\\c',
  'what?*',
  'trail.  ',
  'CON',
  'con.txt',
  'lpt9',
  '   ',
  '',
  'tab\tand\nnewline',
  '가'.repeat(200),
  'x:y',
];

test('어떤 이름이든 엔진이 받는 폴더 이름이 된다', () => {
  for (const name of tricky) {
    const out = baseFolderName(name);
    assert.ok(isValidFolderName(out), `${JSON.stringify(name)} → ${JSON.stringify(out)}`);
  }
});

test('읽을 수 있는 이름은 그대로 둔다', () => {
  assert.equal(baseFolderName('리서치 도우미'), '리서치 도우미');
  assert.equal(baseFolderName('  My   Agent  '), 'My Agent');
  assert.equal(baseFolderName('a/b'), 'a-b');
  assert.equal(baseFolderName('CON'), '_CON');
  assert.equal(baseFolderName(''), 'agent');
});

test('겹치면 (2), (3) 을 붙인다', () => {
  const used = new Set(['research', 'research (2)']);
  assert.equal(uniqueFolderName('Research', (n) => used.has(n.toLowerCase())), 'Research (3)');
  assert.equal(uniqueFolderName('Other', (n) => used.has(n.toLowerCase())), 'Other');
});

test('검사기는 엔진과 같은 것을 거부한다', () => {
  for (const bad of ['', '.', '..', '.x', 'a/b', 'a:b', 'x.', 'x ', 'NUL', 'com1.txt', 'a\u0001b', '가'.repeat(90)]) {
    assert.equal(isValidFolderName(bad), false, bad);
  }
});
