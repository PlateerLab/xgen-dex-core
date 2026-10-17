/** Opt-in live acceptance driver. Only a disposable account and mkdtemp folder are permitted. */
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const { bindDesktopNativeSessions } = require('../src/main/native-session-ipc.ts');
const { NativeDeviceKeyStore } = require('@dex/engine/native-device-key-store');
const { getLocalToolProvider } = require('@dex/engine/local-tools');
const { ChatFolderStore } = require('../src/main/chat-folders.ts');
const option = (name) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = option('origin'); const userId = option('user-id'); const sessionId = option('session-id');
assert.equal(origin, 'https://localhost:3443');
assert.match(userId ?? '', /^[1-9][0-9]*$/);
assert.match(sessionId ?? '', /^[a-f0-9-]{36}$/);
assert.equal(option('disposable'), '1');
const directory = mkdtempSync(path.join(tmpdir(), 'dex-native-active-'));
const workspace = path.join(directory, 'workspace'); mkdirSync(workspace);
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
let win; let host; let closing = false;
const marker = path.join(workspace, 'native-active-marker.txt');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const deadline = setTimeout(() => { send({ event: 'deadline' }); app.exit(1); }, 10 * 60 * 1000);
const close = () => { if (closing) return; closing = true; host?.reset(); clearTimeout(deadline); win?.destroy(); app.quit(); };
app.on('will-quit', () => rmSync(directory, { recursive: true, force: true }));
async function until(predicate) {
  for (let i = 0; i < 300; i++) { if (await win.webContents.executeJavaScript(predicate, true)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('UI_CONDITION_TIMEOUT');
}
async function click(selector) {
  await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('CONTROL_UNAVAILABLE');e.click()})()`, true);
}
app.whenReady().then(async () => {
  // This test-owned folder is the only preselected directory. Execution still uses the actual ledger and provider.
  const folders = new ChatFolderStore(path.join(directory, 'folders'), () => JSON.stringify([origin, userId]));
  folders.add(sessionId, [workspace]);
  getLocalToolProvider().configureFolders(context => folders.list(context?.interactionId));
  buildSync({ entryPoints: [path.join(__dirname, 'native-capability-active-renderer.tsx')], bundle: true,
    outfile: path.join(directory, 'ui.js'), platform: 'browser', format: 'iife', tsconfig: path.join(__dirname, '../tsconfig.json') });
  writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{font:14px system-ui;background:#f8fafc;color:#172033;margin:24px}button{padding:8px;margin:4px}pre{white-space:pre-wrap}</style><main id="root"></main><script src="ui.js"></script>');
  const query = { origin, userId, sessionId };
  const trustedUrl = new URL(pathToFileURL(path.join(directory, 'index.html'))); Object.entries(query).forEach(([k,v]) => trustedUrl.searchParams.set(k,v));
  win = new BrowserWindow({ width: 1100, height: 1000, show: true, webPreferences: { contextIsolation: true, sandbox: false,
    backgroundThrottling: false, preload: path.join(__dirname, '../out/preload/index.js') } });
  host = bindDesktopNativeSessions(() => win.webContents, () => ({ origin, userId }), trustedUrl.href);
  await win.loadFile(path.join(directory, 'index.html'), { query }); await until(`!!document.getElementById('capability-connect')`);
  send({ event: 'ready', user_id: userId, agent_session_id: sessionId, real_rpc: true, real_provider: true });
  const lines = createInterface({ input: process.stdin }); let queue = Promise.resolve();
  lines.on('line', line => { queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line); const { method, params = {} } = request; let result;
      if (method === 'rpc') {
        const allowed = ['device','session','conversation','submit-turn','create-agent-session','capabilities','capability-approvals','disconnect-capabilities'];
        assert.ok(allowed.includes(params.method));
        result = await win.webContents.executeJavaScript(`window.xgen.nativeSession.request(${JSON.stringify(params.method)},${JSON.stringify(params.params ?? {})})`, true);
      } else if (method === 'connect') {
        await click('#capability-connect'); await until(`document.body.textContent.includes('작업 요청 대기')`); result = { connected: true };
      } else if (method === 'select') {
        await click('#capability-refresh'); await until(`Array.from(document.querySelectorAll('.native-capabilities__tool')).some(e=>e.querySelector('strong')?.textContent==='WriteFile')`);
        await win.webContents.executeJavaScript(`(()=>{const e=Array.from(document.querySelectorAll('.native-capabilities__tool')).find(e=>e.querySelector('strong')?.textContent==='WriteFile').querySelector('input');if(!e.checked)e.click()})()`, true);
        await click('#capability-save'); await until(`document.body.textContent.includes('저장했습니다')`); result = { selected: 'WriteFile' };
      } else if (method === 'adopt') {
        await click('#capability-refresh'); await until(`Array.from(document.querySelectorAll('.native-capabilities__approvals button')).some(e=>!e.disabled)`);
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.native-capabilities__approvals button')).find(e=>!e.disabled).click()`, true);
        await until(`document.body.textContent.includes('다음 턴에 연결했습니다')`); result = { adopted: true };
      } else if (method === 'confirm') {
        assert.equal(typeof params.allow, 'boolean');
        await until(`!!document.getElementById('capability-allow')&&!document.getElementById('capability-allow').disabled`);
        const shown = JSON.parse(await win.webContents.executeJavaScript(`document.querySelector('pre[aria-label="실행 인자"]').textContent`));
        assert.deepEqual(shown, { path: 'native-active-marker.txt', content: 'native-active-marker\n', mode: 'append' });
        assert.equal(existsSync(marker), false, 'NO_EFFECT_BEFORE_CONFIRMATION');
        if (params.screenshot) {
          assert.ok(path.resolve(params.screenshot).startsWith(path.resolve(option('evidence-dir')) + path.sep));
          await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          writeFileSync(params.screenshot, (await win.webContents.capturePage()).toPNG());
        }
        await click(params.allow ? '#capability-allow' : '#capability-deny');
        await until(`!document.getElementById('capability-allow')`); result = { confirmed: params.allow, exact_args: true, effect_before_confirmation: false };
      } else if (method === 'marker') {
        const content = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
        result = { exists: existsSync(marker), copies: content.split('native-active-marker\n').length - 1,
          exact: content === 'native-active-marker\n' };
      } else if (method === 'cleanup-key') {
        host.reset(); const keys = new NativeDeviceKeyStore(); const scope = { origin, userId, platform: 'desktop' };
        await keys.withSession(scope, async (_identity, _sign, vault) => { await vault.clear(); });
        await keys.remove(scope); result = { exact_scope_removed: true };
      } else if (method === 'shutdown') result = null;
      else throw new Error('UNSUPPORTED_DRIVER_METHOD');
      send({ id: request.id, result }); if (method === 'shutdown') close();
    } catch (error) { send({ id: request?.id, error: { code: 'ACTIVE_DRIVER_REJECTED', reason: error.code ?? error.name ?? 'Error' } }); }
  }); });
  lines.on('close', close);
}).catch(error => { send({ event: 'error', code: error.code ?? error.name ?? 'Error' }); app.exit(1); });
