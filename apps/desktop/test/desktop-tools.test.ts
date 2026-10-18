/**
 * 데스크탑 앱 도구 — 에이전트가 맥 앱을 열고·읽고·조작한다. 맥 기능은 가짜로 바꿔 끼워 규칙만 본다:
 *   · 열기: 실행 중이면 그 앱을 앞으로, 아니면 설치된 앱을 실행. 한국어 이름("카카오톡")으로도 찾는다.
 *   · 입력·키·누르기는 대상 앱을 맨 앞으로 가져와 확인한 뒤에만 — 못 가져오면 보내지 않는다. DeX 자신은 대상이 아니다.
 *   · 되돌릴 수 없을 수 있는 항목·단축키는 누르지 않는다. 다른 기기에서 온 턴은 거부한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_APPS_TOOL,
  DESKTOP_INTERACT_TOOL,
  DESKTOP_SNAPSHOT_TOOL,
  DesktopToolProvider,
  formatSnapshot,
  isBlockedCombo,
  type DesktopPort,
} from '../src/main/desktop-tools';
import type { AxApp, AxSnapshot } from '../src/main/mac-ax';

const SELF = 1;
const app = (name: string, pid: number, path: string, front = false): AxApp => ({ app: name, bundleId: '', pid, path, front, hidden: false });

function fakeMac(opts: { frontStuck?: boolean } = {}) {
  const calls: string[] = [];
  let running: AxApp[] = [
    app('XGen Dex', SELF, '/x/Electron.app', true),
    app('카카오톡', 20, '/Applications/KakaoTalk.app'),
    app('Microsoft PowerPoint', 30, '/Applications/Microsoft PowerPoint.app'),
  ];
  let gen = 0;
  const setFront = (pid: number) => (running = running.map((a) => ({ ...a, front: a.pid === pid })));
  const snap = (pid: number): AxSnapshot => ({
    gen: ++gen,
    app: running.find((a) => a.pid === pid)?.app ?? '',
    bundleId: '',
    pid,
    presenting: false,
    window: '프레젠테이션1',
    windowCount: 2,
    refs: [
      { ref: 'e1', role: 'button', name: '새 슬라이드' },
      { ref: 'e2', role: 'textbox', name: '제목', value: '분기 실적' },
      { ref: 'e3', role: 'menuitem', name: '파일 > 닫기' },
      { ref: 'e4', role: 'menuitem', name: '삽입 > 새 슬라이드' },
    ],
    ms: 5,
  });
  const port: DesktopPort = {
    trusted: async () => true,
    apps: async () => running,
    installed: async () => [
      { name: 'Microsoft Excel', path: '/Applications/Microsoft Excel.app' },
      { name: 'Microsoft PowerPoint', path: '/Applications/Microsoft PowerPoint.app' },
      { name: 'Calculator', path: '/System/Applications/Calculator.app' },
    ],
    front: async () => {
      const f = running.find((a) => a.front)!;
      return { app: f.app, bundleId: '', pid: f.pid, presenting: false };
    },
    open: async (path) => {
      calls.push(`open ${path}`);
      if (opts.frontStuck) return '';
      const hit = running.find((a) => a.path === path);
      if (hit) setFront(hit.pid);
      else {
        running = [...running, app(path.split('/').pop()!.replace('.app', ''), 99, path)];
        setFront(99);
      }
      return '';
    },
    activate: async (pid) => void calls.push(`activate ${pid}`),
    hide: async (pid) => void calls.push(`hide ${pid}`),
    snapshot: async (pid) => snap(pid),
    press: async (ref, g) => {
      if (g !== gen) throw new Error('stale');
      calls.push(`press ${ref}`);
    },
    focus: async (ref) => void calls.push(`focus ${ref}`),
    setValue: async (ref, _g, t) => void calls.push(`set ${ref}=${t}`),
    type: async (t) => void calls.push(`type ${t}`),
    keys: async (k) => void calls.push(`keys ${k}`),
    sleep: async () => undefined,
  };
  return { port, calls };
}

function provider(opts: { frontStuck?: boolean; enabled?: boolean } = {}) {
  const mac = fakeMac(opts);
  const shown: string[] = [];
  const p = new DesktopToolProvider({ enabled: () => opts.enabled ?? true, showDex: () => shown.push('dex'), selfPid: SELF, port: mac.port });
  const call = async (tool: string, args: Record<string, unknown>) => (await p.callTool(tool, args)).content[0].text;
  return { p, call, calls: mac.calls, shown };
}

test('설정이 꺼져 있으면 광고하지 않는다', () => {
  assert.deepEqual(provider({ enabled: false }).p.advertise(), []);
  assert.deepEqual(provider().p.advertise().map((t) => t.name), [DESKTOP_APPS_TOOL, DESKTOP_SNAPSHOT_TOOL, DESKTOP_INTERACT_TOOL]);
});

test('목록에는 DeX 자신이 없고, 실행 중·설치된 앱을 함께 보인다', async () => {
  const { call } = provider();
  const out = await call(DESKTOP_APPS_TOOL, { action: 'list' });
  assert.match(out, /^Running: 카카오톡, Microsoft PowerPoint\nInstalled: Microsoft Excel, Microsoft PowerPoint, Calculator$/);
});

test('열기 — 실행 중이면 앞으로(한국어·번들 이름 모두), 아니면 설치된 앱을 실행, 못 찾으면 목록', async () => {
  const { call, calls } = provider();
  assert.match(await call(DESKTOP_APPS_TOOL, { action: 'open', app: 'kakaotalk' }), /열었습니다: 카카오톡 \(맨 앞\)/);
  assert.match(await call(DESKTOP_APPS_TOOL, { action: 'open', app: 'PowerPoint' }), /열었습니다: Microsoft PowerPoint/);
  assert.match(await call(DESKTOP_APPS_TOOL, { action: 'open', app: '계산기 앱' }), /찾지 못했습니다.*\n설치됨: .*Calculator/);
  assert.match(await call(DESKTOP_APPS_TOOL, { action: 'open', app: 'calculator' }), /열었습니다: Calculator \(맨 앞\)/);
  assert.deepEqual(calls, [
    'open /Applications/KakaoTalk.app',
    'open /Applications/Microsoft PowerPoint.app',
    'open /System/Applications/Calculator.app',
  ]);
});

test('숨기기 — DeX 를 먼저 앞으로, 그다음 숨긴다', async () => {
  const { call, calls, shown } = provider();
  assert.match(await call(DESKTOP_APPS_TOOL, { action: 'hide', app: 'PowerPoint' }), /숨겼습니다: Microsoft PowerPoint/);
  assert.deepEqual([shown, calls], [['dex'], ['hide 30']]);
});

test('스냅샷 — 창 요소 먼저·메뉴 뒤, 입력칸 값, 되돌릴 수 없는 항목 표시, filter', async () => {
  const { call } = provider();
  const out = await call(DESKTOP_SNAPSHOT_TOOL, { app: 'PowerPoint' });
  assert.equal(
    out,
    [
      'app: Microsoft PowerPoint (behind — type/keys/press bring it to the front)',
      'window: "프레젠테이션1"',
      '## window',
      'e1 | button | 새 슬라이드',
      'e2 | textbox | 제목 = "분기 실적"',
      '## menu bar',
      'e3 | menuitem | 파일 > 닫기 [직접]',
      'e4 | menuitem | 삽입 > 새 슬라이드',
    ].join('\n'),
  );
  assert.match(await call(DESKTOP_SNAPSHOT_TOOL, { filter: '새 슬라이드' }), /e1 \| button[^]*e4 \| menuitem/);
  assert.doesNotMatch(await call(DESKTOP_SNAPSHOT_TOOL, { filter: '새 슬라이드' }), /e2/);
});

test('조작 — 앞으로 가져온 뒤 누르기·입력, 되돌릴 수 없는 항목·단축키는 거부', async () => {
  const { call, calls } = provider();
  await call(DESKTOP_SNAPSHOT_TOOL, { app: 'PowerPoint' });
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'press', ref: 'e4' }), /눌렀습니다: e4 \(menuitem "삽입 > 새 슬라이드"\)/);
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'type', ref: 'e2', text: '3분기' }), /입력했습니다: 3자/);
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'press', ref: 'e3' }), /누르지 않았습니다/);
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'keys', keys: 'cmd+q' }), /보내지 않았습니다/);
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'keys', keys: 'cmd+n' }), /보냈습니다: cmd\+n/);
  assert.deepEqual(calls, ['open /Applications/Microsoft PowerPoint.app', 'press e4', 'focus e2', 'type 3분기', 'keys cmd+n']);
});

test('앞으로 가져오지 못하면 입력하지 않는다 — 다른 앱에 글자가 들어가지 않게', async () => {
  const { call, calls } = provider({ frontStuck: true });
  await call(DESKTOP_SNAPSHOT_TOOL, { app: 'PowerPoint' });
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'type', text: '안녕' }), /맨 앞으로 가져오지 못해 조작하지 않았습니다/);
  assert.ok(!calls.some((c) => c.startsWith('type')));
});

test('스냅샷 전이거나 다시 읽은 뒤의 옛 번호는 쓰지 않는다', async () => {
  const { call } = provider();
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'press', app: 'PowerPoint', ref: 'e1' }), /DesktopSnapshot 을 먼저/);
  await call(DESKTOP_SNAPSHOT_TOOL, { app: 'PowerPoint' });
  assert.match(await call(DESKTOP_INTERACT_TOOL, { action: 'press', ref: 'e9' }), /마지막 스냅샷에 없습니다/);
});

test('DeX 자신은 조작 대상이 아니고, 다른 기기에서 온 턴은 거부한다', async () => {
  const { p, call } = provider();
  assert.match(await call(DESKTOP_SNAPSHOT_TOOL, { app: 'XGen Dex' }), /실행 중이 아닙니다/);
  await assert.rejects(() => p.callTool(DESKTOP_APPS_TOOL, { action: 'list' }, { remote: true, originName: '웹' }), /이 PC 앞에서/);
});

test('막는 단축키 — 종료·닫기·저장·삭제·강제 종료', () => {
  for (const k of ['cmd+q', 'Cmd+W', 'command+s', 'cmd+delete', 'cmd+option+esc', 'cmd+shift+s']) assert.equal(isBlockedCombo(k), true, k);
  for (const k of ['cmd+n', 'return', 'escape', 'cmd+c', 'cmd+v', 'shift+tab']) assert.equal(isBlockedCombo(k), false, k);
});

test('스냅샷이 길면 자르고 filter 를 권한다', () => {
  const refs = Array.from({ length: 320 }, (_, i) => ({ ref: `e${i + 1}`, role: 'button', name: `b${i + 1}` }));
  const out = formatSnapshot({ gen: 1, app: 'A', bundleId: '', pid: 2, presenting: false, windowCount: 320, refs, ms: 1 }, true);
  assert.match(out, /e300 \| button \| b300\n… 20 more items — pass filter to narrow\.$/);
});
