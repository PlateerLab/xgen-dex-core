import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import type { PresentationVoiceAgent, presentationControls } from '../src/main/voice-presentation';
import type { VoiceAction } from '../src/main/fast-act-voice';
import type { AxApp, PresentationAction } from '../src/main/mac-ax';
import { FINAL, PARTIAL, CONTINUATION, GUARDED, mentions } from '../src/main/voice-segmenter';

const source = ts.transpileModule(readFileSync(new URL('../src/main/voice-presentation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  let apps: AxApp[] = [
    { app: 'Orca', bundleId: 'com.stablyai.orca', pid: 10, path: '/Orca.app', front: true, hidden: false },
    { app: 'Microsoft PowerPoint', bundleId: 'com.microsoft.Powerpoint', pid: 30, path: '/PowerPoint.app', front: false, hidden: false, presenting: true },
  ];
  let ref = 'e9001';
  let verified = true;
  let classification = { ready: 'act_now', gate: 1, single: 1, onscreen: 1 };
  let shows = 0;
  let appsError: Error | null = null;
  const calls: Array<[number, PresentationAction]> = [];
  const actions: VoiceAction[] = [];
  const exported: { PresentationVoiceAgent?: typeof PresentationVoiceAgent; presentationControls?: typeof presentationControls } = {};
  runInNewContext(source, {
    exports: exported, performance, process: { env: {} },
    require(name: string) {
      if (name === './diag-log') return { diag: () => {} };
      if (name === './fast-act') return {
        classify: async () => classification,
        pickElement: async () => ({ ref, confidence: 1 }),
      };
      if (name === './fast-act-desktop') return { screenOf: () => ({}) };
      if (name === './fast-act-runner') return { decisionPost: () => async () => ({}) };
      if (name === './mac-ax') return {
        axApps: async () => { if (appsError) throw appsError; return apps.map(a => ({ ...a })); },
        axPresentation: async (pid: number, action: PresentationAction) => {
          calls.push([pid, action]);
          return { verified, reason: verified ? undefined : '숨겨지지 않음' };
        },
      };
      if (name === './voice-segmenter') return { CONTINUATION, GUARDED, mentions };
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  const agent = new exported.PresentationVoiceAgent!(0, actions, () => { shows++; });
  return {
    calls, actions,
    controls: () => exported.presentationControls!(apps),
    set ref(value: string) { ref = value; },
    set verified(value: boolean) { verified = value; },
    set apps(value: AxApp[]) { apps = value; },
    set appsError(value: Error | null) { appsError = value; },
    set classification(value: typeof classification) { classification = value; },
    get shows() { return shows; },
    handle: (partial = false, text = 'PPT 다음 장 넘겨줘.') => agent.handle(text, partial ? PARTIAL : FINAL, async () => true, () => false),
  };
}

test('presentation controls bind four operations to PowerPoint, not the foreground Orca app', () => {
  const f = fixture();
  const { controls, refs } = f.controls();
  assert.equal(Object.keys(controls).length, 4);
  assert.ok(Object.values(controls).every(c => c.app.pid === 30));
  assert.ok(refs.e9999);
});

test('partial and final speech issue one slide operation to the pinned PID', async () => {
  const f = fixture();
  assert.equal((await f.handle(true))?.acted, false);
  assert.equal(f.calls.length, 0);
  f.apps = [{ app: 'Orca', bundleId: 'com.stablyai.orca', pid: 10, path: '', front: true, hidden: false }];
  await Promise.all([f.handle(), f.handle()]);
  assert.deepEqual(f.calls, [[30, 'next']]);
  assert.equal(f.actions.length, 1);
});

test('previous, hide and restore keep the selected operation and target', async () => {
  for (const [ref, operation] of [['e9002', 'previous'], ['e9003', 'hide'], ['e9004', 'show']] as const) {
    const f = fixture();
    f.ref = ref;
    assert.equal((await f.handle())?.acted, true);
    assert.deepEqual(f.calls, [[30, operation]]);
    assert.equal(f.shows, operation === 'hide' ? 1 : 0);
  }
});

test('an unverified operation stops without replaying or claiming success', async () => {
  const f = fixture();
  f.ref = 'e9003';
  f.verified = false;
  const result = await f.handle();
  assert.ok(result && !result.acted && result.stop);
  await f.handle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.actions.length, 0);
  assert.equal(f.shows, 0);
});

test('an unrelated request returns to ordinary routing without presentation actions', async () => {
  const f = fixture();
  f.ref = 'e9999';
  assert.equal(await f.handle(), null);
  assert.equal(f.calls.length, 0);
});

test('show remains available after the show has ended and PowerPoint is hidden', async () => {
  const f = fixture();
  f.apps = [{ app: 'Microsoft PowerPoint', bundleId: 'com.microsoft.Powerpoint', pid: 30, path: '/PowerPoint.app', front: false, hidden: true, presenting: false }];
  f.ref = 'e9004';
  assert.match(f.controls().refs.e9004.name!, /현재 슬라이드부터 쇼 시작/);
  assert.match(f.controls().refs.e9003.name!, /쇼 종료 후 앱 숨기기/);
  assert.equal((await f.handle(false, 'PPT 띄워줘.'))?.acted, true);
  assert.deepEqual(f.calls, [[30, 'show']]);
  assert.equal(f.shows, 0);
});

test('low presentation relevance returns ordinary speech without blocking or focusing Dex', async () => {
  const f = fixture();
  f.ref = 'e9003';
  f.classification = { ready: 'act_now', gate: 0.97, single: 0.005, onscreen: 0.02 };
  for (const partial of [true, false]) {
    assert.equal(await f.handle(partial, '신상품 자료를 읽고 소개문과 검색 키워드를 써줘.'), null);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.shows, 0);
});

test('a completed presentation action does not consume an unrelated continuation', async () => {
  const f = fixture();
  assert.equal((await f.handle())?.acted, true);
  f.ref = 'e9999';
  assert.equal(await f.handle(false, '상품 소개문을 써줘.'), null);
  assert.equal(f.calls.length, 1);
});

test('a final named slide command may be ready=wait without lowering target confidence', async () => {
  const f = fixture();
  f.classification = { ready: 'wait', gate: 0.1, single: 0.1, onscreen: 1 };
  assert.equal((await f.handle(true, 'PPT 다음 장.'))?.acted, false);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handle(false, 'PPT 다음 장.'))?.acted, true);
  assert.deepEqual(f.calls, [[30, 'next']]);
});

test('a named next-slide phrase cannot use the allowance for previous or hide', async () => {
  for (const [text, ref] of [
    ['PPT 다음 장.', 'e9002'], ['PPT 다음 장.', 'e9003'],
    ['PPT 다음 슬라이드.', 'e9002'], ['PPT 이전 슬라이드.', 'e9001'],
    ['PPT 슬라이드.', 'e9001'], ['PPT 다음 아니 이전 슬라이드.', 'e9001'],
  ]) {
    const f = fixture();
    f.ref = ref;
    f.classification = { ready: 'wait', gate: 0.1, single: 0.1, onscreen: 1 };
    const result = await f.handle(false, text);
    assert.ok(result && !result.acted && result.stop);
    assert.equal(f.calls.length, 0);
  }
});

test('named slide directions remain available with shared slide nouns', async () => {
  for (const [text, ref, action] of [['PPT 다음 슬라이드.', 'e9001', 'next'], ['PPT 이전 슬라이드.', 'e9002', 'previous']] as const) {
    const f = fixture();
    f.ref = ref;
    f.classification = { ready: 'wait', gate: 0.1, single: 0.1, onscreen: 1 };
    assert.equal((await f.handle(false, text))?.acted, true);
    assert.deepEqual(f.calls, [[30, action]]);
  }
});

test('a failed app lookup can recover on the next presentation attempt', async () => {
  const f = fixture();
  f.appsError = new Error('lookup timeout');
  await assert.rejects(f.handle(), /lookup timeout/);
  assert.deepEqual(f.calls, []);
  f.appsError = null;
  assert.equal((await f.handle())?.acted, true);
  assert.deepEqual(f.calls, [[30, 'next']]);
});

test('routed preflight failures fall through but terminal presentation outcomes do not', async () => {
  const code = readFileSync(new URL('../src/main/fast-act-computer.ts', import.meta.url), 'utf8');
  const routed = ts.transpileModule(code.slice(code.indexOf('export class RoutedVoiceAgent')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const mode of ['lookup', 'classify', 'native'] as const) {
    let ordinaryCalls = 0;
    const terminal = { acted: false, stop: true, reason: 'native failure', ms: 0 };
    const ordinary = { acted: false, reason: 'ordinary route', ms: 0 };
    const exported: Partial<typeof import('../src/main/fast-act-computer')> = {};
    runInNewContext(routed, {
      exports: exported, deps: {}, SCOPE: 'test', diag: () => {}, frontCache: null,
      computerActEnabled: () => true, externalFront: async () => null, visiblePage: () => true,
      ComputerVoiceAgent: class {}, LauncherVoiceAgent: class {},
      PresentationVoiceAgent: class { async handle() { if (mode === 'native') return terminal; throw new Error(mode); } },
    });
    const browser = { actions: [], workflow: 'test', handle: async () => { ordinaryCalls++; return ordinary; } };
    const agent = new exported.RoutedVoiceAgent!(browser as unknown as ConstructorParameters<NonNullable<typeof exported.RoutedVoiceAgent>>[0], 0);
    const result = await agent.handle('상품 설명을 써줘.', FINAL, async () => true, () => false, '상품 설명을 써줘.');
    assert.equal(result, mode === 'native' ? terminal : ordinary);
    assert.equal(ordinaryCalls, mode === 'native' ? 0 : 1);
  }
});

test('presentation hide uses a fresh helper per request and rejects mismatched replies', async () => {
  const nativeSource = ts.transpileModule(readFileSync(new URL('../src/main/mac-ax.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported: Partial<typeof import('../src/main/mac-ax')> = {};
  const requests: Array<{ cmd: string; pid: number; action: string; id: number }> = [];
  let executions = 0;
  let wrongId = false;
  runInNewContext(nativeSource, {
    exports: exported, process: { platform: 'darwin' },
    require(name: string) {
      if (name === 'electron') return { app: { isPackaged: false, getAppPath: () => '/desktop' } };
      if (name === 'node:fs') return { accessSync: () => {}, constants: { X_OK: 1 } };
      if (name === 'node:path') return { join: (...parts: string[]) => parts.join('/') };
      if (name === './diag-log') return { diag: () => {} };
      if (name === 'node:child_process') return {
        spawn: () => { throw new Error('hide must not use the shared helper'); },
        execFile: (_path: string, _args: string[], options: { timeout: number; maxBuffer: number }, callback: (err: Error | null, stdout: string) => void) => {
          executions++;
          assert.equal(options.timeout, 12000);
          assert.equal(options.maxBuffer, 65536);
          const stdin = Object.assign(new EventEmitter(), {
            end(input: string) {
              const request = JSON.parse(input);
              requests.push(request);
              callback(null, JSON.stringify({ ...request, id: wrongId ? -1 : request.id, ok: true, verified: true, visibleWindows: 0, hideAttempts: 2, settleMs: 1800 }));
            },
          });
          return { stdin };
        },
      };
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  for (let i = 0; i < 2; i++) {
    const result = await exported.axPresentation!(30, 'hide');
    assert.equal(result.verified, true);
    assert.equal(result.hideAttempts, 2);
    assert.equal(result.settleMs, 1800);
  }
  assert.equal(executions, 2);
  assert.ok(requests.every(r => r.cmd === 'presentation' && r.pid === 30 && r.action === 'hide'));
  assert.notEqual(requests[0].id, requests[1].id);
  wrongId = true;
  await assert.rejects(exported.axPresentation!(30, 'hide'), /응답 오류/);
});
