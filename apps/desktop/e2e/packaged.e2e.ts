/**
 * 설치본으로 띄운다 — electron-builder 가 만든 앱(풀린 폴더)이 실제로 뜨고, 창이 화면을 그리고, OS 키체인 모듈(keytar —
 * 네이티브, asar 밖)과 MCP SDK(asar 밖, ESM)가 실리는지 본다. keytar 는 실리지 않으면 조용히 파일 저장으로 넘어가 겉으로는
 * 드러나지 않는다.
 *
 *   DEX_E2E_PACKAGED=<설치본 실행 파일> npx tsx --test e2e/packaged.e2e.ts
 *
 * CI 의 desktop-package 잡이 세 OS 의 설치본으로 돈다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';

const EXE = process.env.DEX_E2E_PACKAGED;

test('설치본: 창이 화면을 그리고 OS 키체인 모듈·MCP SDK 가 실린다', { skip: !EXE && 'DEX_E2E_PACKAGED 가 없다' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dex-packaged-'));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.ELECTRON_RUN_AS_NODE;
  // 이 PC 의 Dex 설정·세션을 건드리지 않는다(리눅스·맥은 홈 아래에 둔다 — Windows 러너는 매번 새것이다).
  if (process.platform !== 'win32') Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  const app = await _electron.launch({ executablePath: EXE!, args: process.platform === 'linux' ? ['--no-sandbox'] : [], env, timeout: 90_000 });
  try {
    // 메인 창 — 오버레이·빠른 채팅 같은 다른 창이 먼저 뜰 수 있어 주소로 고른다.
    await app.firstWindow({ timeout: 90_000 });
    const isMain = (url: string) => /\/renderer\/index\.html(?:[?#]|$)/.test(url);
    const deadline = Date.now() + 90_000;
    let win = app.windows().find((w) => isMain(w.url()));
    while (!win && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      win = app.windows().find((w) => isMain(w.url()));
    }
    assert.ok(win, `메인 창이 뜨지 않는다: ${app.windows().map((w) => w.url()).join(', ')}`);
    await win.waitForLoadState('domcontentloaded');
    // 화면(React)이 뭔가를 그렸다 — 빈 창이 아니다. (waitForFunction 은 화면의 CSP 가 eval 을 막아 쓰지 않는다.)
    await win.locator('#root > *').first().waitFor({ state: 'attached', timeout: 60_000 });
    const keytar = await app.evaluate(async () => {
      // main 프로세스 — 설치본 안의 모듈을 그대로 실어 본다(keychain.ts 와 같은 길).
      const mod = (process as unknown as { mainModule: NodeJS.Module }).mainModule.require('keytar');
      return typeof mod.getPassword;
    });
    assert.equal(keytar, 'function', 'keytar 가 실리지 않는다');
    // MCP SDK — 앱과 같은 길(asar 안 out/main 의 모듈이 bare specifier 로 import())로 실어 클라이언트를 만든다.
    // SDK 는 asar 밖에 풀리고 그 의존(ajv 등)은 asar 안에 놓일 수 있다 — 그 사이를 ESM 해석기가 건너는지 본다.
    const mcp = await app.evaluate(async () => {
      const Module = process.mainModule!.require('node:module');
      const { join, dirname } = process.mainModule!.require('node:path');
      const filename = join(process.resourcesPath, 'app.asar', 'out', 'main', 'mcp-probe.js');
      const probe = new Module(filename, null);
      probe.filename = filename;
      probe.paths = Module._nodeModulePaths(dirname(filename));
      probe._compile(
        "module.exports = import('@modelcontextprotocol/sdk/client/index.js').then((m) => typeof new m.Client({ name: 'probe', version: '0' }).connect)",
        filename,
      );
      return (await probe.exports) as string;
    });
    assert.equal(mcp, 'function', 'MCP SDK 가 실리지 않는다');
    if (process.platform === 'linux') {
      // 창이 설치되는 xgen-dex.desktop(StartupWMClass=xgen-dex)에 묶이는 이름 — Wayland 의 app_id 가 여기서 온다.
      const desktopName = await app.evaluate(() => process.env.CHROME_DESKTOP ?? null);
      assert.equal(desktopName, 'xgen-dex.desktop');
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});
