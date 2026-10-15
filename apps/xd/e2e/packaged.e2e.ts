/**
 * 설치본 E2E — electron-builder 로 만든 실제 설치본(풀린 폴더)을 띄워, 함께 실린 엔진(resources/engine/python)으로
 * 턴이 끝까지 도는지 본다. 개발 실행과 달리 엔진 자리·asar 안의 앱·업데이트 정보가 설치본의 것이다.
 *
 *   XD_E2E_PACKAGED=<설치본 실행 파일> npx tsx --test e2e/packaged.e2e.ts
 *   (리눅스: release/linux-unpacked/xd, Windows: …/XD.exe, macOS: …/XD.app/Contents/MacOS/XD)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { _electron } from 'playwright-core';

const EXE = process.env.XD_E2E_PACKAGED;

test('설치본: 함께 실린 엔진으로 턴이 끝까지 돈다', { skip: !EXE, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'xd-packaged-'));
  const script = join(mkdtempSync(join(tmpdir(), 'xd-packaged-tmp-')), 'script.json');
  writeFileSync(script, JSON.stringify({ responses: [{ tools: [{ name: 'Write', input: { file_path: 'hello.txt', content: '설치본에서\n' } }] }, { text: 'done' }] }));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), XD_DATA_ROOT: root, XD_ENGINE_FAKE_LLM: script };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.XD_ENGINE_PYTHON; // 설치본의 엔진 자리를 그대로
  env.XD_DISABLE_UPDATES = '1'; // 시험 중에 릴리스를 보러 가지 않는다
  const app = await _electron.launch({ executablePath: EXE!, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => Boolean((window as any).xd?.agents));
    const out = await win.evaluate(async () => {
      const xd = (window as any).xd;
      const account = await xd.accounts.create({ kind: 'xd_fake', label: 'fake' }).then((r: any) => { if (!r.ok) throw new Error(r.error); return r.value; });
      const agent = await xd.agents.create({ name: '설치본', accountId: account.id, model: 'fake-1', options: { memory_distill: false } }).then((r: any) => { if (!r.ok) throw new Error(r.error); return r.value; });
      let resolveEnd!: (e: any) => void;
      const finished = new Promise<any>((r) => (resolveEnd = r));
      const off = xd.onTurnEvent((e: any) => e.type === 'finished' && resolveEnd(e));
      await xd.turn.send({ agentId: agent.id, text: '써 줘' }).then((r: any) => { if (!r.ok) throw new Error(r.error); return r.value; });
      const end = await finished;
      off();
      const engine = await xd.engine.status().then((r: any) => r.value);
      return { status: end.turn.status, engine };
    });
    assert.equal(out.status, 'done');
    assert.equal(readFileSync(join(root, 'workspace', '설치본', 'hello.txt'), 'utf8'), '설치본에서\n');
    // 엔진은 설치본 안의 것 — 개발 실행의 engine/dist 가 아니다
    const log = readFileSync(join(root, '.xd', 'logs', 'engine.log'), 'utf8');
    const res = join(dirname(EXE!), process.platform === 'darwin' ? '../Resources' : 'resources');
    assert.match(log, new RegExp(`engine start .*${join('engine', 'python').replace(/[\\\\/]/g, '[\\\\/]')}`));
    assert.ok(existsSync(join(res, 'engine', 'python')), res);
    assert.equal(out.engine.running, true);
  } finally {
    await app.close();
  }
});
