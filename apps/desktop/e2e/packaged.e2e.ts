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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright-core';

const EXE = process.env.DEX_E2E_PACKAGED;
const LIVE_SERVER = process.env.DEX_E2E_SERVER_URL;
const LIVE_CREDENTIALS = process.env.DEX_E2E_LIVE_CREDENTIALS;
const LIVE_FIXTURE = process.env.DEX_E2E_LIVE_FIXTURE;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} 응답 모양이 올바르지 않다`,
  );
  return value as JsonObject;
}

async function jsonRequest(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, init);
  assert.ok(response.ok, `${path} 요청 실패 (${response.status})`);
  return object(await response.json(), path);
}

function bearer(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function stringField(value: unknown, label: string): string {
  assert.equal(typeof value, 'string', `${label} 값이 문자열이 아니다`);
  assert.ok(value, `${label} 값이 비었다`);
  return value as string;
}

function rawSecret(value: string): string {
  return `raw:${Buffer.from(value, 'utf8').toString('base64')}`;
}

/** Fixture 전용 독립 관측기. 제품 parser 를 다시 불러 같은 버그를 함께 재현하지 않고,
 * 서버 원문에서 정해진 text marker 한 개를 걷어 실제 표시할 바이트를 고정한다. */
function signedFixtureText(value: string): string {
  const prefix = '<!--XGEN_GENERATED_CONTENT_V1 ';
  const start = value.indexOf(prefix);
  assert.ok(start >= 0, 'fixture 텍스트 marker 가 없다');
  const end = value.indexOf('-->', start + prefix.length);
  assert.ok(end > start, 'fixture 텍스트 marker 가 닫히지 않았다');
  const marker = value.slice(start, end + 3);
  assert.match(marker, /\bproof=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\s|-->)/);
  assert.equal(value.indexOf(prefix, end + 3), -1, 'fixture 에 텍스트 marker 가 둘 이상 있다');
  const before = value.slice(0, start);
  return `${before.endsWith('\n') ? before.slice(0, -1) : before}${value.slice(end + 3)}`;
}

async function waitForMainWindow(app: Awaited<ReturnType<typeof _electron.launch>>) {
  await app.firstWindow({ timeout: 90_000 });
  const isMain = (url: string) => /\/renderer\/index\.html(?:[?#]|$)/.test(url);
  const deadline = Date.now() + 90_000;
  let win = app.windows().find((w) => isMain(w.url()));
  while (!win && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    win = app.windows().find((w) => isMain(w.url()));
  }
  assert.ok(
    win,
    `메인 창이 뜨지 않는다: ${app
      .windows()
      .map((w) => w.url())
      .join(', ')}`,
  );
  await win.waitForLoadState('domcontentloaded');
  await win.locator('#root > *').first().waitFor({ state: 'attached', timeout: 60_000 });
  return win;
}

test(
  '설치본: 창이 화면을 그리고 OS 키체인 모듈·MCP SDK 가 실린다',
  { skip: !EXE && 'DEX_E2E_PACKAGED 가 없다', concurrency: false },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'dex-packaged-'));
    const userData = join(home, 'user-data');
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.ELECTRON_RUN_AS_NODE;
    // 이 PC 의 Dex 설정·세션을 건드리지 않는다(리눅스·맥은 홈 아래에 둔다 — Windows 러너는 매번 새것이다).
    if (process.platform !== 'win32')
      Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
    const args = [
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ];
    const app = await _electron.launch({ executablePath: EXE!, args, env, timeout: 90_000 });
    try {
      // 메인 창 — 오버레이·빠른 채팅 같은 다른 창이 먼저 뜰 수 있어 주소로 고른다.
      const win = await waitForMainWindow(app);
      // 화면(React)이 뭔가를 그렸다 — 빈 창이 아니다. (waitForFunction 은 화면의 CSP 가 eval 을 막아 쓰지 않는다.)
      const keytar = await app.evaluate(async () => {
        // main 프로세스 — 설치본 안의 모듈을 그대로 실어 본다(keychain.ts 와 같은 길).
        const mod = (process as unknown as { mainModule: NodeJS.Module }).mainModule.require(
          'keytar',
        );
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
      const nativeProbe = await app.evaluate(async ({ app }, temporary) => {
        const require = process.mainModule!.require.bind(process.mainModule);
        const fs = require('node:fs');
        const path = require('node:path');
        const crypto = require('node:crypto');
        const triple = `${process.platform}-${process.arch}`;
        const base = path.join(app.getAppPath(), 'out', 'native');
        const binary = path.join(base, triple, 'native-fs.node');
        const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
        if (crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== manifest[triple]) {
          throw new Error('Packaged native binding digest mismatch');
        }
        const native = require(binary);
        const rootPath = path.join(temporary, 'native-grant');
        const stagePath = path.join(temporary, 'native-probe-stage');
        fs.mkdirSync(rootPath, { mode: 0o700 }); fs.mkdirSync(stagePath, { mode: 0o700 });
        native.configureStage(stagePath);
        const root = native.openRoot(rootPath);
        let source: { id: bigint } | undefined;
        try {
          native.atomicWrite(root.id, 'intended.txt', Buffer.from('packaged native bytes'), false);
          let collision = false;
          try { native.atomicWrite(root.id, 'intended.txt', Buffer.from('wrong bytes'), false); }
          catch (error) { collision = (error as NodeJS.ErrnoException).code === 'EEXIST'; }
          if (!collision) throw new Error('Packaged native no-replace failed');
          source = native.openSource(root.id, 'intended.txt');
          return { text: Buffer.from(native.readSource(source!.id, 0, 21)).toString(), triple };
        } finally {
          if (source) native.closeSource(source.id);
          native.closeRoot(root.id);
          native.configureStage(path.join(app.getPath('userData'), 'native-stage'));
        }
      }, home);
      assert.equal(nativeProbe.text, 'packaged native bytes');
      assert.equal(nativeProbe.triple, `${process.platform}-${process.arch}`);
      if (process.platform === 'linux') {
        // 창이 설치되는 xgen-dex.desktop(StartupWMClass=xgen-dex)에 묶이는 이름 — Wayland 의 app_id 가 여기서 온다.
        const desktopName = await app.evaluate(() => process.env.CHROME_DESKTOP ?? null);
        assert.equal(desktopName, 'xgen-dex.desktop');
      }
    } finally {
      await app.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test(
  '설치본 실제 서버: 서명 본문을 숨겨 표시하고 현재 본문을 검증하며 인증 전환에 상태를 남기지 않는다',
  {
    skip:
      !EXE || !LIVE_SERVER || !LIVE_CREDENTIALS || !LIVE_FIXTURE
        ? 'DEX_E2E_PACKAGED, DEX_E2E_SERVER_URL, DEX_E2E_LIVE_CREDENTIALS, DEX_E2E_LIVE_FIXTURE 가 모두 필요하다'
        : false,
    timeout: 180_000,
    concurrency: false,
  },
  async () => {
    const credentials = object(JSON.parse(readFileSync(LIVE_CREDENTIALS!, 'utf8')), 'credentials');
    const userCredentials = object(credentials.user, 'credentials.user');
    const email = stringField(userCredentials.email, 'credentials.user.email');
    const passwordHash = stringField(
      userCredentials.password_hash,
      'credentials.user.password_hash',
    );
    const fixture = object(JSON.parse(readFileSync(LIVE_FIXTURE!, 'utf8')), 'fixture');
    const workflowId = stringField(fixture.workflow_id, 'fixture.workflow_id');

    // 별도 로그인 세션만 만들고 토큰 값은 출력하지 않는다. 이 fixture 를 소유한 사용자의
    // 실제 저장 이력 중 서명 봉투가 있는 대화를 고르므로 새 모델 호출이나 메시지가 없다.
    const login = await jsonRequest(LIVE_SERVER!, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: passwordHash, token: null }),
    });
    const accessToken = stringField(login.access_token, 'login.access_token');
    const refreshToken = typeof login.refresh_token === 'string' ? login.refresh_token : null;
    const query = new URLSearchParams({ limit: '100', workflow_id: workflowId });
    const page = await jsonRequest(LIVE_SERVER!, `/api/interaction/conversations?${query}`, {
      headers: bearer(accessToken),
    });
    assert.ok(Array.isArray(page.conversations), 'fixture 대화 목록이 없다');

    let selected: {
      interactionId: string;
      title: string;
      workflowName: string;
      visibleText: string;
    } | null = null;
    for (const rawConversation of page.conversations) {
      const conversation = object(rawConversation, 'conversation');
      const interactionId =
        typeof conversation.interaction_id === 'string' ? conversation.interaction_id : '';
      if (!interactionId) continue;
      const historyQuery = new URLSearchParams({
        workflow_id: workflowId,
        interaction_id: interactionId,
      });
      const history = await jsonRequest(LIVE_SERVER!, `/api/chat/io-logs?${historyQuery}`, {
        headers: bearer(accessToken),
      });
      if (!Array.isArray(history.in_out_logs)) continue;
      for (const rawTurn of history.in_out_logs) {
        const turn = object(rawTurn, 'history turn');
        if (
          typeof turn.output_data !== 'string' ||
          !turn.output_data.includes('<!--XGEN_GENERATED_CONTENT_V1 ')
        )
          continue;
        selected = {
          interactionId,
          title: stringField(conversation.title, 'conversation.title'),
          workflowName: stringField(conversation.workflow_name, 'conversation.workflow_name'),
          visibleText: signedFixtureText(turn.output_data),
        };
        // The fixture can gain another signed turn during peer-sync E2E.
        // Compare the renderer's last assistant bubble with the latest signed turn.
      }
      if (selected) break;
    }
    assert.ok(selected, '로그인 사용자가 소유한 서명 fixture 대화를 찾지 못했다');

    const home = mkdtempSync(join(tmpdir(), 'dex-packaged-live-'));
    const userData = join(home, 'user-data');
    mkdirSync(userData, { recursive: true });
    const configPath = join(userData, 'connector.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        serverUrl: LIVE_SERVER,
        autoUpdate: false,
        autoLaunch: false,
        browser: { enabled: false },
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(configPath, 0o600);
    const storePath = join(userData, 'secure-store.json');
    writeFileSync(
      storePath,
      JSON.stringify({
        xgen_access_token: rawSecret(accessToken),
        ...(refreshToken ? { xgen_refresh_token: rawSecret(refreshToken) } : {}),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(storePath, 0o600);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DEX_PROFILE: `packaged-live-${process.pid}-${Date.now()}`,
      XGEN_SERVER_URL: LIVE_SERVER!,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (process.platform !== 'win32')
      Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
    const args = [
      `--user-data-dir=${userData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ];
    const app = await _electron.launch({ executablePath: EXE!, args, env, timeout: 90_000 });
    try {
      const win = await waitForMainWindow(app);
      const row = win.locator('.conv-row-main').filter({ hasText: selected.title }).first();
      await row.waitFor({ state: 'visible', timeout: 60_000 });
      await row.click();

      const answer = win.locator('.msg-row.assistant .bubble.assistant').last();
      await answer.waitFor({ state: 'visible', timeout: 60_000 });
      assert.equal(
        await answer.innerText(),
        selected.visibleText,
        '표시 본문 바이트가 서버의 실제 서명 본문과 다르다',
      );
      const root = win.locator('#root');
      assert.doesNotMatch((await root.textContent()) ?? '', /XGEN_GENERATED_(?:CONTENT|MEDIA)_V1/);
      assert.doesNotMatch(
        await win.locator('body').ariaSnapshot(),
        /XGEN_GENERATED_(?:CONTENT|MEDIA)_V1/,
      );

      const status = win.locator('.generated-content-status').last();
      await status.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await status.getAttribute('aria-label'), 'AI 생성 · 확인 전');
      await status.getByRole('button', { name: '검증', exact: true }).click();
      await status
        .filter({ has: win.getByText('검증됨', { exact: true }) })
        .waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await status.getAttribute('aria-label'), 'AI 생성 · 검증됨');

      // 검증 결과는 화면의 현재 revision 에만 속한다. 새로고침으로 이력을 다시 읽을 때
      // 이전 React state 를 재사용하지 않고 확인 전부터 다시 검증해야 한다.
      await win.reload({ waitUntil: 'domcontentloaded' });
      await win.locator('#root > *').first().waitFor({ state: 'attached', timeout: 60_000 });
      const restoredRow = win.locator('.conv-row-main').filter({ hasText: selected.title }).first();
      if (!(await win.locator('.generated-content-status').count())) {
        await restoredRow.waitFor({ state: 'visible', timeout: 60_000 });
        await restoredRow.click();
      }
      const restored = win.locator('.generated-content-status').last();
      await restored.waitFor({ state: 'visible', timeout: 60_000 });
      assert.equal(await restored.getAttribute('aria-label'), 'AI 생성 · 확인 전');
      assert.doesNotMatch(
        (await win.locator('#root').textContent()) ?? '',
        /XGEN_GENERATED_(?:CONTENT|MEDIA)_V1/,
      );

      // Exercise the installed renderer -> preload -> host grant ledger -> native
      // boundary. Only the native chooser is supplied a temporary test folder.
      const folderRoot = join(home, 'ipc-folder');
      const movedRoot = join(home, 'ipc-folder-moved');
      mkdirSync(folderRoot);
      writeFileSync(join(folderRoot, 'value.txt'), 'pinned-original');
      writeFileSync(join(home, 'outside.txt'), 'outside-sentinel');
      const folderInteraction = `native-e2e-${process.pid}-${Date.now()}`;
      await app.evaluate(({ dialog }, folder) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = (async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths: [folder] };
        }) as typeof dialog.showOpenDialog;
      }, folderRoot);
      const folders = await win.evaluate(async (interaction) => {
        const api = (window as unknown as { xgen: {
          chatFolders: { add(id: string): Promise<Array<{ id: string }>> };
        } }).xgen;
        return api.chatFolders.add(interaction);
      }, folderInteraction);
      assert.equal(folders.length, 1);
      const folderId = folders[0]!.id;
      const folderCall = (op: string, args: JsonObject) => win.evaluate(async (input) => {
        const api = (window as unknown as { xgen: { chatFolders: {
          fs(id: string, root: string, op: string, args: JsonObject): Promise<{ ok: boolean; value?: { bytes?: number[] }; code?: string }>;
        } } }).xgen;
        return api.chatFolders.fs(input.interaction, input.folderId, input.op, input.args);
      }, { interaction: folderInteraction, folderId, op, args });
      const initial = await folderCall('read', { path: 'value.txt' });
      assert.equal(initial.ok, true);
      assert.equal(Buffer.from(initial.value!.bytes!).toString(), 'pinned-original');
      assert.equal((await folderCall('read', { path: '../outside.txt' })).ok, false);
      renameSync(folderRoot, movedRoot);
      mkdirSync(folderRoot);
      writeFileSync(join(folderRoot, 'value.txt'), 'replacement-object');
      const pinned = await folderCall('read', { path: 'value.txt' });
      assert.equal(pinned.ok, true);
      assert.equal(Buffer.from(pinned.value!.bytes!).toString(), 'pinned-original');
      await win.evaluate(async (input) => {
        const api = (window as unknown as { xgen: { chatFolders: {
          remove(id: string, folder: string): Promise<unknown>;
        } } }).xgen;
        await api.chatFolders.remove(input.interaction, input.folderId);
      }, { interaction: folderInteraction, folderId });
      assert.equal((await folderCall('read', { path: 'value.txt' })).code, 'not_found');
      assert.equal(readFileSync(join(home, 'outside.txt'), 'utf8'), 'outside-sentinel');

      // 실제 계정 메뉴의 로그아웃 경로로 auth context 를 없앤다. 검증 badge 와 대화
      // 본문은 로그인 화면에 남지 않아야 하며 임시 서버 세션도 폐기된다.
      await win.locator('.ab-account > button').click();
      await win.getByRole('button', { name: '로그아웃', exact: true }).click();
      await win.locator('.auth-shell').waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await win.locator('.generated-content-status').count(), 0);
      assert.doesNotMatch(
        (await win.locator('#root').textContent()) ?? '',
        /XGEN_GENERATED_(?:CONTENT|MEDIA)_V1|검증됨/,
      );
    } finally {
      await app.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  },
);
