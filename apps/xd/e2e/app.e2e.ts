/**
 * XD 앱 E2E — 실제 Electron + 동봉 Python 엔진 + 가짜 LLM(xd_fake). 키·네트워크 없이 돈다.
 *
 *   node apps/xd/scripts/bundle-engine.mjs && npm --prefix apps/xd run build
 *   xvfb-run -a npm --prefix apps/xd run e2e       (리눅스 CI — 화면이 없으면 xvfb)
 *
 * 엔진은 개발 실행처럼 `apps/xd/engine/dist/<platform>-<arch>/python` 을 쓴다(XD_ENGINE_PYTHON 으로 바꿀 수 있다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';

const APP = resolve(__dirname, '..');
// Electron 43 은 설치 스크립트가 없다 — `require('electron')` 이 실행 파일 경로를 주고, 없으면 그때 내려받는다.
const ELECTRON = createRequire(__filename)('electron') as string;

interface Launched {
  app: ElectronApplication;
  win: Page;
}

function fixture(responses: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'xd-e2e-root-'));
  const tmp = mkdtempSync(join(tmpdir(), 'xd-e2e-tmp-'));
  const script = join(tmp, 'script.json');
  const log = join(tmp, 'requests.jsonl');
  writeFileSync(script, JSON.stringify({ responses }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), XD_DATA_ROOT: root, XD_ENGINE_FAKE_LLM: script, XD_ENGINE_FAKE_LOG: log };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async (): Promise<Launched> => {
    const app = await _electron.launch({ executablePath: ELECTRON, args: [APP, '--no-sandbox'], env });
    const win = await app.firstWindow();
    await win.waitForFunction(() => Boolean((window as unknown as { xd?: { agents?: unknown } }).xd?.agents));
    return { app, win };
  };
  return { root, log, launch };
}

/** 턴을 보내고 끝(finished)까지 기다린다 — 화면 쪽에서 듣는다. */
async function sendAndWait(win: Page, input: { agentId: string; conversationId?: string; text: string }) {
  return win.evaluate(async (input) => {
    const xd = (window as any).xd;
    const events: any[] = [];
    let resolveEnd!: (e: any) => void;
    const finished = new Promise<any>((r) => (resolveEnd = r));
    const off = xd.onTurnEvent((e: any) => {
      events.push(e);
      if (e.type === 'finished') resolveEnd(e);
    });
    const sent = await xd.turn.send(input);
    const end = await finished;
    off();
    return {
      sent,
      turn: end.turn,
      chat: events.filter((e) => e.type === 'chat').map((e) => e.event.kind),
      approvals: events.filter((e) => e.type === 'approval').map((e) => e.command),
    };
  }, input);
}

async function makeAgent(win: Page, name: string) {
  return win.evaluate(async (name) => {
    const xd = (window as any).xd;
    const account = await xd.accounts.create({ kind: 'xd_fake', label: 'fake' });
    return xd.agents.create({ name, accountId: account.id, model: 'fake-1', options: { memory_distill: false } });
  }, name);
}

test('앱을 껐다 켜도 대화가 이어진다 (M2 완료 기준)', { timeout: 180_000 }, async () => {
  const { root, log, launch } = fixture([
    { text: '만들게요.', tools: [{ name: 'Write', input: { file_path: 'hello.txt', content: 'hi' } }] },
    { text: 'hello.txt 를 만들었습니다.' },
  ]);
  let { app, win } = await launch();
  const agent = await makeAgent(win, '리서치 도우미');
  const conversationId = `conn-${agent.id}-1759400000000`; // Dex 화면이 만드는 모양
  const first = await sendAndWait(win, { agentId: agent.id, conversationId, text: 'hello.txt 만들어 줘' });
  assert.equal(first.turn.status, 'done');
  assert.equal(first.turn.answer, 'hello.txt 를 만들었습니다.');
  assert.deepEqual(first.chat, ['tool', 'tool', 'text', 'end']);
  assert.equal(readFileSync(join(root, 'workspace', '리서치 도우미', 'hello.txt'), 'utf8'), 'hi');
  await app.close();

  ({ app, win } = await launch());
  const after = await win.evaluate(async (agentId) => {
    const xd = (window as any).xd;
    const convs = await xd.conversations.list(agentId);
    return { agents: (await xd.agents.list()).length, convs, turns: await xd.conversations.turns(convs[0].id) };
  }, agent.id);
  assert.equal(after.agents, 1);
  assert.deepEqual(
    after.convs.map((c: any) => [c.id, c.title]),
    [[conversationId, 'hello.txt 만들어 줘']],
  );
  assert.equal(after.turns.length, 1);
  assert.equal(after.turns[0].answer, 'hello.txt 를 만들었습니다.');
  assert.deepEqual(
    after.turns[0].process.map((p: any) => p.kind),
    ['tool', 'tool', 'text'],
  );

  const second = await sendAndWait(win, { agentId: agent.id, conversationId, text: '방금 만든 파일 이름이 뭐였지?' });
  assert.equal(second.turn.status, 'done');
  assert.equal(second.turn.seq, 2);
  await app.close();

  // 엔진이 받은 요청의 메시지 수: 1회차 1·3, 2회차는 앞 대화(질문·답) 2개가 붙어 3·5.
  const counts = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).count);
  assert.deepEqual(counts, [1, 3, 3, 5]);
  assert.deepEqual(readdirSync(join(root, '.xd')).sort(), ['agents', 'electron', 'logs', 'xd.db']);
});

test('위험 명령은 Dex 와 같은 확인 창을 거치고, 거부하면 실행되지 않는다', { timeout: 120_000 }, async () => {
  const { root, launch } = fixture([
    { tools: [{ name: 'Bash', input: { command: 'rm -rf keep' } }] },
    { tools: [{ name: 'Bash', input: { command: 'echo safe-command-ran' } }] },
    { text: 'done' },
  ]);
  const { app, win } = await launch();
  // 네이티브 창은 누를 수 없다 — 받은 옵션을 적고 "거부"(0)를 고르게 바꿔 끼운다.
  await app.evaluate(({ dialog }) => {
    (globalThis as any).__asked = [];
    (dialog as any).showMessageBox = async (...args: any[]) => {
      const opts = args.length > 1 ? args[1] : args[0];
      (globalThis as any).__asked.push(opts);
      return { response: 0, checkboxChecked: false };
    };
  });
  const agent = await makeAgent(win, 'Danger');
  mkdirSync(join(root, 'workspace', agent.workspace, 'keep'));
  const result = await sendAndWait(win, { agentId: agent.id, text: 'clean up' });
  const asked = await app.evaluate(() => (globalThis as any).__asked);
  await app.close();

  assert.equal(result.turn.status, 'done');
  // 엔진이 Dex 규칙을 받았다 — 위험한 것만 묻는다.
  assert.deepEqual(result.approvals, ['rm -rf keep']);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].buttons, ['거부', '이번만 허용', '이 대화에서 계속 허용']);
  assert.equal(asked[0].defaultId, 0);
  assert.equal(asked[0].cancelId, 0);
  assert.equal(asked[0].message, 'XD 에이전트가 이 PC 에서 되돌리기 어려운 명령을 실행하려 합니다.');
  assert.equal(asked[0].detail, 'rm -rf keep');
  const tools = result.turn.process.filter((p: any) => p.kind === 'tool').map((p: any) => p.event);
  assert.match(String(tools[1].result ?? tools[1].error), /user_denied/);
  assert.match(String(tools[3].result), /safe-command-ran/);
  assert.ok(existsSync(join(root, 'workspace', agent.workspace, 'keep')));
});
