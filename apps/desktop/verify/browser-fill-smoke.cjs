const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { app } = require('electron');
const { runSteps, MAX_FILL_STEPS } = require('../src/main/fast-act-batch.ts');
const { BrowserVoiceAgent } = require('../src/main/fast-act-voice.ts');
const { getBrowserRuntime } = require('../src/main/browser-runtime.ts');
const { configureFastAct } = require('../src/main/fast-act-runner.ts');

async function main() {
  await app.whenReady();
  const t = { mock };
  const runtime = getBrowserRuntime();
  const page = { pageId: 'form', workflowId: 'w', mode: 'shared' };
  let open = true;
  const savedUrl = process.env.DEX_FAST_ACT_URL;
  delete process.env.DEX_FAST_ACT_URL;
  configureFastAct({ enabled: () => true, post: async () => ({}) });
  t.mock.method(runtime, 'get', () => open ? page : null);
  t.mock.method(runtime, 'isEnabled', () => true);
  t.mock.method(runtime, 'state', () => ({ pages: open ? [page] : [], activeByWorkflow: { w: 'form' } }));
  const steps = ['메모 입력', '파일 업로드', '알림 체크'];
  try {
    let calls = 0;
    const handle = t.mock.method(BrowserVoiceAgent.prototype, 'handle', async () => {
      calls++;
      open = false;
      return { acted: true, kind: 'type', target: '메모', ms: 0, effect: 'ok' };
    });
    let rows = await runSteps('w', 'form', 'i', steps);
    assert.deepEqual(rows.map(r => r.status), ['done', 'skipped', 'skipped']);
    assert.match(rows[1].note, /닫혔/);
    assert.equal(calls, 1);

    open = true;
    calls = 0;
    let started;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const active = new Promise(resolve => { started = resolve; });
    handle.mock.mockImplementation(async () => {
      calls++;
      if (calls === 2) { started(); await pending; }
      return { acted: true, kind: 'type', target: '메모', ms: 0, effect: 'ok' };
    });
    const controller = new AbortController();
    const filling = runSteps('w', 'form', 'i', steps, controller.signal);
    await active;
    controller.abort();
    rows = await filling;
    assert.deepEqual(rows.map(r => r.status), ['done', 'failed', 'skipped']);
    assert.match(rows[1].note, /일부 반영/);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(rows[1].status, 'failed');

    calls = 0;
    let finishTimedStep;
    const timedStep = new Promise(resolve => { finishTimedStep = resolve; });
    handle.mock.mockImplementation(async () => {
      calls++;
      if (calls === 2) await timedStep;
      return { acted: true, kind: 'type', target: '메모', ms: 0, effect: 'ok' };
    });
    rows = await runSteps('w', 'form', 'i', steps, undefined, Date.now() + 2_020);
    assert.deepEqual(rows.map(r => r.status), ['done', 'failed', 'skipped']);
    assert.match(rows[2].note, /시간 한도/);
    finishTimedStep();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);

    calls = 0;
    rows = await runSteps('w', 'form', 'i', steps, undefined, Date.now());
    assert.ok(rows.every(r => r.status === 'skipped'));
    assert.equal(calls, 0);
    await assert.rejects(runSteps('w', 'form', 'i', Array(MAX_FILL_STEPS + 1).fill('메모 입력')), /50줄/);
    assert.equal(calls, 0);
  } finally {
    configureFastAct({ enabled: () => false, post: async () => ({}) });
    if (savedUrl === undefined) delete process.env.DEX_FAST_ACT_URL;
    else process.env.DEX_FAST_ACT_URL = savedUrl;
  }
}

void main().then(() => { console.log('BrowserFill partial-result smoke passed'); app.quit(); }, error => { console.error(error); app.exit(1); });
