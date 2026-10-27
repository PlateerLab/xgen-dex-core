import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import type * as Presentation from '../src/main/voice-presentation';
import type { VoiceAction } from '../src/main/fast-act-voice';
import type { AxApp, PresentationAction } from '../src/main/mac-ax';
import { FINAL, PARTIAL, GUARDED, mentions, type Outcome } from '../src/main/voice-segmenter';

const source = ts.transpileModule(readFileSync(new URL('../src/main/voice-presentation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Native = { sent: boolean; verified: boolean; reason?: string };

function fixture() {
  const state = {
    native: { sent: true, verified: true } as Native | Error,
    pick: { ref: 'e9001', confidence: 1 } as { ref: string; confidence: number } | null,
    front: 999 as number,
  };
  const calls: Array<[number, PresentationAction]> = [];
  let shows = 0;
  const m: Partial<typeof Presentation> = {};
  runInNewContext(source, {
    exports: m, performance, setTimeout, process: { env: {}, pid: 999 },
    require(name: string) {
      if (name === './diag-log') return { diag: () => {} };
      if (name === './fast-act') return { pickElement: async () => state.pick && { ...state.pick, top: [] } };
      if (name === './fast-act-e13') return { buildScreen: () => ({}) };
      if (name === './mac-ax') return {
        axFront: async () => ({ pid: state.front }),
        axPresentation: async (pid: number, action: PresentationAction) => {
          calls.push([pid, action]);
          if (state.native instanceof Error) throw state.native;
          return state.native;
        },
      };
      if (name === './voice-segmenter') return { GUARDED, mentions };
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  m.configurePresentation!(() => { shows++; });
  const actions: VoiceAction[] = [];
  const ppt = (over: Partial<AxApp> = {}): AxApp => ({
    app: 'Microsoft PowerPoint', bundleId: 'com.microsoft.Powerpoint', pid: 30, path: '/PowerPoint.app', front: false, hidden: false, presenting: true, ...over,
  });
  const run = (action: 'next' | 'previous' | 'hide', o: { partial?: boolean; confidence?: number; guard?: boolean } = {}): Promise<Outcome> => {
    const { controls } = m.presentationControls!([ppt()], 9001);
    const c = Object.values(controls).find((x) => x.action === action)!;
    return m.runPresentation!(c, {
      said: '다음 장으로 넘겨줘', th: o.partial ? PARTIAL : FINAL, guard: async () => o.guard ?? true, abort: () => false,
      pick: { confidence: o.confidence ?? 1 }, t0: performance.now(), sessionT0: 0, push: (a) => actions.push(a),
    });
  };
  return { m, state, calls, actions, ppt, run, get shows() { return shows; } };
}

test('발표 중이고 숨기지 않은 PowerPoint 에만 다음·이전·쇼 끝내고 내리기를 붙인다', () => {
  const f = fixture();
  const orca: AxApp = { app: 'Orca', bundleId: 'com.stablyai.orca', pid: 10, path: '/Orca.app', front: true, hidden: false };
  const { refs, controls } = f.m.presentationControls!([orca, f.ppt()], 9006);
  assert.deepEqual(Object.keys(refs), ['e9006', 'e9007', 'e9008']);
  assert.deepEqual(Object.values(controls).map((c) => [c.action, c.app.pid]), [['next', 30], ['previous', 30], ['hide', 30]]);
  assert.equal(refs.e9006.name, '다음 슬라이드·다음 장 (PowerPoint 슬라이드 쇼)');
  assert.equal(refs.e9008.name, '슬라이드 쇼 끝내고 PowerPoint 내리기 (발표 화면 내리기)');
  // 편집 중·숨김·다른 앱은 후보가 없다 — 브라우저·앱 요청 화면이 그대로다.
  assert.deepEqual(Object.keys(f.m.presentationControls!([f.ppt({ presenting: false }), f.ppt({ pid: 31, hidden: true }), orca], 9001).refs), []);
});

test('말이 끝난 뒤에만, 고른 확신이 기준 이상일 때만 실행한다 — 내리기는 더 높은 기준', async () => {
  const f = fixture();
  assert.equal((await f.run('next', { partial: true })).acted, false);
  assert.equal((await f.run('next', { confidence: 0.85 })).acted, false);
  // "유튜브 열어줘" → 내리기 0.920(10/27) 같은 확신으로는 쇼를 끝내지 않는다
  assert.equal((await f.run('hide', { confidence: 0.92 })).acted, false);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.run('next', { guard: false })).reason, GUARDED);
  assert.deepEqual(f.calls, []);
});

test('보낸 키는 실행으로 친다 — 장 번호를 확인하지 못하면 키만 보냈다고 답한다', async () => {
  const f = fixture();
  const ok = await f.run('next');
  assert.equal(ok.acted, true);
  assert.equal(f.actions.at(-1)?.sentence, '다음 장으로 넘겼어요.');
  f.state.native = { sent: true, verified: false, reason: '장 번호를 읽지 못해 키만 보냈습니다.' };
  const unverified = await f.run('previous');
  assert.equal(unverified.acted, true);
  assert.equal(f.actions.at(-1)?.sentence, '이전 장 키를 보냈어요.');
  assert.deepEqual(f.calls, [[30, 'next'], [30, 'previous']]);
});

test('키를 보내기 전에 멈추면 서버로 넘기고, 보낸 뒤 확인하지 못했거나 결과를 모르면 멈춘다', async () => {
  const f = fixture();
  f.state.native = { sent: false, verified: false, reason: '발표 창의 초점을 확인하지 못해 슬라이드 키를 보내지 않았습니다.' };
  const before = await f.run('next');
  assert.equal(before.acted, false);
  assert.equal(!before.acted && before.stop, undefined);
  f.state.native = { sent: true, verified: false, reason: '슬라이드 쇼가 종료되지 않아 XGEN으로 전환하지 않았습니다.' };
  const hide = await f.run('hide');
  assert.equal(!hide.acted && hide.stop, true);
  f.state.native = new Error('도우미 응답 시간 초과');
  const lost = await f.run('next');
  assert.equal(!lost.acted && lost.stop, true);
  assert.equal(f.shows, 0);
});

test('내리면 DeX 를 앞으로 가져오고, 남은 말은 새 화면에서 — 그 앱을 다시 띄우면 쇼를 다시 시작한다', async () => {
  const f = fixture();
  f.state.front = 999; // DeX(process.pid) 가 바로 맨 앞
  const o = await f.run('hide');
  assert.equal(o.acted, true);
  assert.equal(o.acted && o.reread, true);
  assert.equal(f.shows, 1);
  assert.equal(f.m.endedShow!(30), true);
  await f.m.restartShow!(30);
  assert.deepEqual(f.calls.at(-1), [30, 'show']);
  assert.equal(f.m.endedShow!(30), false);
});

test('뒤의 앱이 늦게 올라와 DeX 를 덮으면 한 번 더 앞으로', async () => {
  const f = fixture();
  f.state.front = 42;
  await f.m.dexToFront!();
  assert.equal(f.shows, 2);
});

test('발표 조작 이름만 말한 최종 말은 발표 중일 때만, 고른 조작 이름을 가리킬 때만', () => {
  const f = fixture();
  const { controls } = f.m.presentationControls!([f.ppt()], 9001);
  assert.equal(f.m.namedControl!(FINAL, 'wait', controls), true);
  assert.equal(f.m.namedControl!(PARTIAL, 'wait', controls), false);
  assert.equal(f.m.namedControl!(FINAL, 'wait', {}), false);
  assert.equal(f.m.namedControl!(FINAL, 'act_now', controls), false);
  const [next, , hide] = Object.values(controls);
  assert.equal(f.m.namedControlOk!('다음 장', next), true);
  assert.equal(f.m.namedControlOk!('다음 장', hide), false);
});

test('페이지 요소와 다시 고르기 — 발표 조작이 기준 이상으로 이길 때만 발표 조작', async () => {
  const f = fixture();
  const { controls } = f.m.presentationControls!([f.ppt()], 9001);
  const el = { role: 'button', name: '다음 콘텐츠 보기' };
  f.state.pick = { ref: 'e9001', confidence: 0.98 };
  assert.equal((await f.m.presentationRepick!(async () => ({}), 'PPT 다음 장.', 'naver', controls, 'e17', el))?.ref, 'e9001');
  f.state.pick = { ref: 'e9001', confidence: 0.86 };
  assert.equal(await f.m.presentationRepick!(async () => ({}), '다음 장으로 넘겨줘', 'naver', controls, 'e17', el), null);
  f.state.pick = { ref: 'e17', confidence: 1 };
  assert.equal(await f.m.presentationRepick!(async () => ({}), '다음 콘텐츠 보여줘', 'naver', controls, 'e17', el), null);
  // 발표 중이 아니면 묻지 않는다
  f.state.pick = { ref: 'e9001', confidence: 1 };
  assert.equal(await f.m.presentationRepick!(async () => { throw new Error('asked'); }, '다음', 'naver', {}, 'e17', el), null);
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
              callback(null, JSON.stringify({ ...request, id: wrongId ? -1 : request.id, ok: true, sent: true, verified: true, visibleWindows: 0, hideAttempts: 2, settleMs: 1800 }));
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
    assert.equal(result.sent, true);
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
