/** 설치된 앱 찾기 — 앱 이름 → 번들(순수). */
import assert from 'assert';
import { test } from 'node:test';
import { listInstalledApps, matchApp, normalizeAppName, type InstalledApp } from '@dex/engine/app-launch';

const dirs: Record<string, string[]> = {
  '/Applications': ['Microsoft PowerPoint.app', 'Microsoft Excel.app', 'Google Chrome.app', '.hidden.app', 'notes.txt'],
  '/System/Applications': ['Calculator.app', 'Notes.app', 'Google Chrome.app'],
};
const readDir = async (dir: string) => {
  if (!dirs[dir]) throw new Error('ENOENT');
  return [...dirs[dir]];
};
const names = (a: InstalledApp) => [a.name];

test('설치된 앱 목록 — .app 만, 숨김 제외, 같은 이름은 앞 폴더의 것, 읽지 못하는 폴더는 건너뛴다', async () => {
  const apps = await listInstalledApps(['/Applications', '/nope', '/System/Applications'], readDir, ['/System/Library/CoreServices/Finder.app']);
  assert.deepEqual(apps.map((a) => a.name), ['Google Chrome', 'Microsoft Excel', 'Microsoft PowerPoint', 'Calculator', 'Notes', 'Finder']);
  assert.equal(apps.find((a) => a.name === 'Google Chrome')?.path, '/Applications/Google Chrome.app');
});

test('앱 이름 맞추기 — 같은 이름, 하나뿐인 부분 이름, 여럿, 없음', async () => {
  const apps = await listInstalledApps(['/Applications', '/System/Applications'], readDir, []);
  const pick = (q: string) => {
    const m = matchApp(q, apps, names);
    return m.kind === 'one' ? m.app.name : m.kind === 'many' ? m.apps.map((a) => a.name) : null;
  };
  assert.equal(pick('Microsoft PowerPoint'), 'Microsoft PowerPoint');
  assert.equal(pick('powerpoint'), 'Microsoft PowerPoint');
  assert.equal(pick('PowerPoint 앱'), 'Microsoft PowerPoint');
  assert.equal(pick('PowerPoint.app'), 'Microsoft PowerPoint');
  assert.equal(pick('notes'), 'Notes');
  assert.deepEqual(pick('Microsoft'), ['Microsoft Excel', 'Microsoft PowerPoint']);
  assert.equal(pick('PPT'), null);
  assert.equal(pick('  '), null);
  assert.equal(normalizeAppName('Microsoft  Power-Point'), 'microsoftpowerpoint');
});

test('앱마다 이름이 여럿이면 어느 이름으로도 찾는다 — 실행 중인 앱의 한국어 이름', () => {
  const running = [{ app: '카카오톡', file: 'KakaoTalk' }, { app: 'Code', file: 'Visual Studio Code' }];
  const both = (a: { app: string; file: string }) => [a.app, a.file];
  const one = (q: string) => {
    const m = matchApp(q, running, both);
    return m.kind === 'one' ? m.app.app : null;
  };
  assert.equal(one('카카오톡'), '카카오톡');
  assert.equal(one('kakaotalk'), '카카오톡');
  assert.equal(one('visual studio'), 'Code');
});
