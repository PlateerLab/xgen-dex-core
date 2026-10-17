/** Real production React/model with a deterministic IPC port fixture; no account credentials. */
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const session = '00000000-0000-4000-8000-000000000001';
const version = '00000000-0000-4000-8000-000000000002';
const device = '00000000-0000-4000-8000-000000000003';
const capId = `cap://device/${device}/mcp/local/Shell`;
const expires = Math.floor(Date.now() / 1000) + 60;
const envelope = { platform_type: 'desktop', profile: 'desktop', server_url: 'https://fixture.example.test', user_id: '7' };
const calls = [];
const directory = mkdtempSync(path.join(tmpdir(), 'dex-native-capability-ui-'));
const screenshot = process.argv.find((x) => x.startsWith('--screenshot='))?.slice(13);
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
let win;
const deadline = setTimeout(() => app.exit(1), 45000);
async function until(predicate) {
  for (let i = 0; i < 120; i++) { if (await win.webContents.executeJavaScript(predicate)) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`UI condition failed: ${predicate}`);
}
async function click(selector) { await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`); }
function notice(snapshot, userId = '7') { win.webContents.send('fixture-update', { type: 'update', value: { ...envelope, user_id: userId, view: 'capabilities', snapshot } }); }

app.whenReady().then(async () => {
  try {
    buildSync({ entryPoints: [path.join(__dirname, 'native-capability-renderer.tsx')], bundle: true,
      outfile: path.join(directory, 'ui.js'), platform: 'browser', format: 'iife', tsconfig: path.join(__dirname, '../tsconfig.json') });
    writeFileSync(path.join(directory, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{font:14px system-ui;background:#f8fafc;color:#172033;margin:32px}button{padding:8px 12px;border:1px solid #b3bfcc;border-radius:6px;background:white;cursor:pointer}button:disabled{opacity:.45}button:not(.secondary){background:#2246ba;color:white}small{margin-top:3px}</style><main id="root"></main><script src="ui.js"></script>');
    writeFileSync(path.join(directory, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('xgen',{nativeSession:{request:(m,p)=>ipcRenderer.invoke('fixture-request',m,p),onUpdate:(fn)=>{const h=(_e,n)=>fn(n);ipcRenderer.on('fixture-update',h);return()=>ipcRenderer.removeListener('fixture-update',h)}}});`);
    ipcMain.handle('fixture-request', (event, method, params = {}) => {
      assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame);
      calls.push({ method, params }); const value = { ...envelope };
      if (method === 'capabilities') value.capability_catalog = { authScope: 'a'.repeat(64), version, expires_at: expires,
        selected_capability_ids: [], capabilities: [{ capability_id: capId, device_id: device, name: 'Shell', server: 'local',
          description: '선택한 PC의 로컬 작업', inputSchema: { type: 'object' }, risk: 'high', approval_mode: 'per_call',
          connection_id: version, epoch: version, descriptor_hash: 'b'.repeat(64) }] };
      if (method === 'capability-approvals') assert.equal(params.expected_auth_scope, 'a'.repeat(64));
      if (method === 'capability-approvals') value.capability_approvals = { approvals: [{ approval_id: 19, intent_version: version,
        status: 'approved', capability_id: capId, tool_name: 'Shell', target_device_id: device, args_sha256: 'c'.repeat(64), source_turn_id: session, expires_at: expires }] };
      if (method === 'select-capabilities') value.capability_selection = { version, selected_capability_ids: params.capability_ids, expires_at: expires };
      if (method === 'adopt-capability-approval') value.capability_adoption = { approval_id: 19, intent_version: version, status: 'armed', expires_at: expires };
      if (method === 'connect-capabilities') value.capability_connection = { state: 'ready', confirmation: null };
      if (method === 'disconnect-capabilities') value.capability_connection = { state: 'closed', confirmation: null };
      if (method === 'confirm-capability') value.capability_connection = { state: params.confirmed ? 'executing' : 'ready', confirmation: null };
      return { ok: true, value };
    });
    win = new BrowserWindow({ show: false, width: 1000, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload: path.join(directory, 'preload.cjs') } });
    await win.loadFile(path.join(directory, 'index.html'));
    await until(`!!document.querySelector('#capability-refresh')`);
    assert.equal(calls.length, 0);
    await click('#capability-refresh'); await until(`document.querySelectorAll('input[type=checkbox]').length===1`);
    await click('input[type=checkbox]'); await click('#capability-save');
    await until(`document.body.textContent.includes('저장했습니다')`);
    assert.deepEqual(calls.find((c) => c.method === 'select-capabilities').params.capability_ids, [capId]);
    await click('#capability-refresh'); await until(`document.querySelectorAll('.native-capabilities__approvals button').length===1`);
    await click('.native-capabilities__approvals button'); await until(`document.body.textContent.includes('다음 턴에 연결했습니다')`);
    assert.equal(calls.filter((c) => c.method === 'adopt-capability-approval').length, 1);
    await click('#capability-connect'); await until(`document.body.textContent.includes('작업 요청 대기')`);
    const pending = { state: 'confirmation_required', confirmation: { requestId: version, server: 'local', tool: 'Shell',
      args: { command: 'echo "확인한 작업만 실행"', data: '<script>window.injected=true</script>' }, expiresAt: expires, argsSha256: 'd'.repeat(64) } };
    notice(pending, '8'); await new Promise((r) => setTimeout(r, 50));
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('#capability-allow')`), false);
    notice(pending); await until(`!!document.querySelector('#capability-allow')`);
    assert.equal(await win.webContents.executeJavaScript('window.injected'), undefined);
    assert.equal(calls.some((c) => c.method === 'confirm-capability'), false);
    if (screenshot) {
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    }
    await click('#capability-allow'); await until(`!document.querySelector('#capability-allow')`);
    assert.equal(calls.filter((c) => c.method === 'confirm-capability').length, 1);
    assert.equal(calls.find((c) => c.method === 'confirm-capability').params.confirmed, true);
    notice({ ...pending, confirmation: { ...pending.confirmation, requestId: session, expiresAt: 1 } });
    await until(`!!document.querySelector('#capability-allow')?.disabled`);
    await click('#capability-deny'); await until(`!document.querySelector('#capability-deny')`);
    assert.equal(calls.filter((c) => c.method === 'confirm-capability').at(-1).params.confirmed, false);
    win.webContents.send('fixture-update', { type: 'cleared' });
    await until(`!document.querySelector('pre')`);
    process.stdout.write('Native capability UI fixture passed: explicit selection, delayed adoption, foreign-scope filtering, escaped exact args, one acknowledgement, expiry rejection, reset.\n');
  } finally { clearTimeout(deadline); win?.destroy(); rmSync(directory, { recursive: true, force: true }); app.quit(); }
}).catch((error) => { process.stderr.write(`${error.stack}\n`); app.exit(1); });
