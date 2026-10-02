/** Opt-in stdio driver for real production Electron IPC/preload/renderer against a supplied HTTPS fixture. */
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const { buildSync } = require('esbuild');
const { bindDesktopNativeSessions } = require('../src/main/native-session-ipc.ts');
const { CHANNELS } = require('../src/main/ipc.ts');
const { NativeDeviceKeyStore } = require('@dex/engine/native-device-key-store');

const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = option('origin'); const userId = option('user-id');
const workspaceUi = option('workspace-ui') === '1';
const catalogPages = option('catalog-pages') === '1';
if (!origin || !userId) throw new Error('Disposable fixture origin and user ID are required');
const directory = mkdtempSync(path.join(tmpdir(), 'dex-desktop-native-ui-'));
mkdirSync(path.join(directory, 'profile'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
let win; let host; let initialized = false; let closing = false; let suppressNotifications = false;
let legacyDispatches = 0; const savedConfig = [];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const deadline = setTimeout(() => app.exit(1), workspaceUi ? 90000 : 60000);
const close = () => { if (closing) return; closing = true; host?.reset(); clearTimeout(deadline); win?.destroy(); app.quit(); };
app.on('will-quit', () => rmSync(directory, { recursive: true, force: true }));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(predicate, true)) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('Desktop fixture UI deadline');
}
app.whenReady().then(async () => {
  if (workspaceUi) {
    // Only unrelated legacy chrome APIs are inert. Native IPC, OS vault,
    // proof signing, HTTPS and conversation transport remain production code.
    const values = new Map([
      [CHANNELS.agentsList, { items: [], pagination: { page: 1, totalPages: 1 } }],
      [CHANNELS.historyConversations, []], [CHANNELS.teamsRooms, []],
      [CHANNELS.browserState, { enabled: false, pages: [], activeByWorkflow: {}, popupRequests: [] }],
      [CHANNELS.notificationStatus, { supported: false, platform: 'fixture', developmentMode: true }],
      [CHANNELS.notificationPreferences, require('@dex/protocol/notifications').defaultNotificationProfile()],
      [CHANNELS.notificationContext, null], [CHANNELS.notificationConsumeTarget, null],
      [CHANNELS.artifactGallery, { items: [], failed: 0, scanned: 0 }], [CHANNELS.fsStatus, null],
      [CHANNELS.quickChatGetHotkey, ''], [CHANNELS.autostartGet, false], [CHANNELS.appVersion, 'fixture'],
    ]);
    for (const [channel, value] of values) ipcMain.handle(channel, () => value);
    ipcMain.handle(CHANNELS.configSet, (_event, patch) => { savedConfig.push(patch); return { serverUrl: origin }; });
    ipcMain.handle(CHANNELS.systemMetrics, () => { throw new Error('Fixture metrics unavailable'); });
    for (const channel of [CHANNELS.chatStart, CHANNELS.chatStop, CHANNELS.chatEndSession]) {
      ipcMain.handle(channel, () => { legacyDispatches++; throw new Error('Canonical UI cannot dispatch legacy chat'); });
    }
  }
  buildSync({ entryPoints: [path.join(__dirname, 'native-session-renderer.tsx')], bundle: true, outfile: path.join(directory, 'ui.js'), platform: 'browser', format: 'iife', external: ['node:crypto'], loader: { '.woff2': 'file' }, tsconfig: path.join(__dirname, '../tsconfig.json') });
  writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><main id="root" class="settings-panel"></main><script src="ui.js"></script></body></html>');
  win = new BrowserWindow({ width: 1050, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, '../out/preload/index.js') } });
  const rendererUrl = new URL(pathToFileURL(path.join(directory, 'index.html')));
  rendererUrl.searchParams.set('origin', origin);
  if (workspaceUi) { rendererUrl.searchParams.set('workspace', '1'); rendererUrl.searchParams.set('userId', userId); }
  host = bindDesktopNativeSessions(() => win?.webContents ?? null, () => ({ origin, userId }), rendererUrl.href);
  // Notifications go through the production channel and renderer, then to this test driver's stdout.
  const originalSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, notice) => {
    originalSend(channel, notice);
    if (channel === CHANNELS.nativeSessionUpdate && notice.type === 'update' && initialized && !closing && !suppressNotifications) {
      send({ jsonrpc: '2.0', method: notice.value.view === 'conversation' ? 'native/conversation' : 'native/focus', params: notice.value });
    }
  };
  const rendererQuery = { origin, ...(workspaceUi ? { workspace: '1', userId } : {}) };
  const rendererReady = workspaceUi ? `!!document.getElementById('canonical-chat-open') && !!window.xgen.nativeSession`
    : `document.querySelectorAll('button').length >= 10 && !!window.xgen.nativeSession`;
  await win.loadFile(path.join(directory, 'index.html'), { query: rendererQuery });
  await until(rendererReady);
  // Another first-party window still cannot manage this main renderer's native account.
  const guest = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, '../out/preload/index.js') } });
  await guest.loadURL('about:blank');
  const denied = await guest.webContents.executeJavaScript(`window.xgen.nativeSession.request('session', {action:'status'})`);
  guest.destroy(); if (denied.ok || denied.code !== 'auth_required') throw new Error('Desktop fixture IPC sender isolation failed');
  // Even the designated main frame loses native access after navigating away.
  await win.loadURL('about:blank');
  const navigated = await win.webContents.executeJavaScript(`window.xgen.nativeSession.request('session', {action:'status'})`);
  if (navigated.ok || navigated.code !== 'auth_required') throw new Error('Desktop fixture renderer URL isolation failed');
  await win.loadFile(path.join(directory, 'index.html'), { query: rendererQuery });
  await until(rendererReady);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => { void (async () => {
    let request;
    try {
      request = JSON.parse(line); const { method, params = {} } = request;
      let result;
      if (method === 'initialize') { initialized = true; result = { protocolVersion: 1, server: { name: 'desktop-native-fixture', version: 'fixture' }, capabilities: { nativePlatformSession: { platform: 'desktop', storage: 'os-keychain-software', canonicalConversation: true, canonicalLive: true, canonicalTurns: true, canonicalSessions: true } } }; }
      else if (method === 'shutdown' || method === 'exit') { result = null; }
      else if (method === 'verify/cleanup-key') {
        host.reset();
        const keys = new NativeDeviceKeyStore(); const scope = { origin, userId, platform: 'desktop' };
        await keys.withSession(scope, async (_identity, _sign, vault) => { await vault.clear(); });
        await keys.remove(scope); result = { removed: true };
      }
      else if (method === 'verify/ui') {
        if (workspaceUi) {
          await win.webContents.executeJavaScript(`document.querySelector('button[title="설정"]').click()`, true);
          await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='기기·세션')`);
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='기기·세션').click()`, true);
          await until(`!!document.getElementById('native-session-refresh')`);
        }
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='세션 상태').click()`, true);
        await until(`document.body.textContent.includes('세션: 사용 가능') && document.body.textContent.includes('연결됨')`);
        const safe = await win.webContents.executeJavaScript(`({password:document.querySelector('input[type=password]').value, labels:Array.from(document.querySelectorAll('button')).map(b=>b.textContent)})`);
        if (safe.password || !safe.labels.includes('기기 등록') || !safe.labels.includes('선택 기기에 승인 요청')) throw new Error('Desktop fixture UI boundary failed');
        if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='작업·구독 중단').click()`, true);
        await until(`document.body.textContent.includes('구독 안 함')`);
        result = { ui: 'passed', sender_isolation: 'passed', password_input: 'empty' };
      } else if (method === 'verify/conversation-ui') {
        suppressNotifications = true;
        try {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='공유 대화 읽기').click()`, true);
          await until(`document.body.textContent.includes('Native shared conversation') && document.body.textContent.includes('native-message-answer')`);
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='공유 대화 폴링').click()`, true);
          await until(`document.body.textContent.includes('연결됨') && document.body.textContent.includes('Native shared conversation') && document.body.textContent.includes('native-message-answer')`);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='대화 연결·폴링 중단').click()`, true);
          await until(`document.body.textContent.includes('구독 안 함') && !document.body.textContent.includes('native-message-answer')`);
          result = { ui: 'passed', conversation: 'passed' };
        } finally { suppressNotifications = false; }
      } else if (method === 'verify/live-ui') {
        suppressNotifications = true;
        try {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='공유 대화 실시간 연결').click()`, true);
          await until(`document.body.textContent.includes('실시간 연결') && document.body.textContent.includes('연결됨') && document.body.textContent.includes('Native shared conversation') && document.body.textContent.includes('native-message-answer')`);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='대화 연결·폴링 중단').click()`, true);
          await until(`document.body.textContent.includes('구독 안 함') && !document.body.textContent.includes('native-message-answer')`);
          result = { ui: 'passed', live: 'passed' };
        } finally { suppressNotifications = false; }
      } else if (method === 'verify/turn-ui') {
        suppressNotifications = true;
        try {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='공유 대화 읽기').click()`, true);
          await until(`!!document.getElementById('native-turn-input') && !document.getElementById('native-turn-input').disabled`);
          await win.webContents.executeJavaScript(`const input=document.getElementById('native-turn-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'native-ui-question\\nexact tail\\n');input.dispatchEvent(new Event('input',{bubbles:true}));`, true);
          await until(`document.getElementById('native-turn-input').value.length>0 && !document.getElementById('native-turn-submit').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-turn-submit').click();document.getElementById('native-turn-submit').click()`, true);
          await until(`!!document.getElementById('native-turn-retry') && !document.getElementById('native-turn-retry').disabled`);
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='작업·구독 중단').click()`, true);
          await until(`document.body.textContent.includes('구독 안 함') && document.getElementById('native-turn-input').disabled`);
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='공유 대화 읽기').click()`, true);
          await until(`!document.getElementById('native-turn-retry').disabled && document.getElementById('native-turn-input').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-turn-retry').click()`, true);
          await until(`!!document.getElementById('native-turn-stop') && !document.getElementById('native-turn-stop').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-turn-stop').click()`, true);
          await until(`document.body.textContent.includes('native-ui-answer') && !document.getElementById('native-turn-input').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-turn-input').scrollIntoView({block:'center'})`, true);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='대화 연결·폴링 중단').click()`, true);
          await until(`!document.body.textContent.includes('native-ui-answer')`);
          result = { ui: 'passed', sender_isolation: 'passed' };
        } finally { suppressNotifications = false; }
      } else if (method === 'verify/workspace-enrollment') {
        await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-open').click()`, true);
        await until(`document.body.textContent.includes('로그인 확인 필요') && !!document.getElementById('canonical-chat-input')`);
        const disabled = await win.webContents.executeJavaScript(`['canonical-chat-input','canonical-chat-submit','canonical-chat-create','canonical-chat-switch','canonical-chat-stop'].every(id=>document.getElementById(id).disabled)`, true);
        if (!disabled || legacyDispatches) throw new Error('Workspace enrollment boundary failed');
        result = { ui: 'passed', legacy_dispatches: legacyDispatches };
      } else if (method === 'verify/workspace-ui') {
        suppressNotifications = true;
        try {
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-open').click()`, true);
          await until(`!!document.getElementById('canonical-chat-workflow') && !document.getElementById('canonical-chat-workflow').disabled`);
          await win.webContents.executeJavaScript(`document.querySelector('.canonical-chat__sessions').open=true`, true);
          await win.webContents.executeJavaScript(`(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const [id,value] of [['canonical-chat-workflow','native-fixture'],['canonical-chat-title','Native created conversation']]){const input=document.getElementById(id);setter.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`, true);
          await until(`!document.getElementById('canonical-chat-create').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-create').click();document.getElementById('canonical-chat-create').click()`, true);
          await until(`document.body.textContent.includes('작업 완료 여부를 확인할 수 없습니다') && document.getElementById('canonical-chat-create').disabled`);
          // Switching to settings must not dispose the shared model or unlock an uncertain create.
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-settings').click()`, true);
          await until(`!!document.getElementById('native-session-create') && document.getElementById('native-session-create').disabled && document.body.textContent.includes('작업 완료 여부를 확인')`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-open').click()`, true);
          await until(`!!document.getElementById('canonical-chat-refresh') && document.getElementById('canonical-chat-create').disabled`);
          await win.webContents.executeJavaScript(`document.querySelector('.canonical-chat__sessions').open=true`, true);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-refresh').click()`, true);
          await until(`Array.from(document.getElementById('canonical-chat-select').options).some(option=>option.textContent.includes('Native created conversation')) && !document.getElementById('canonical-chat-refresh').disabled`);
          await until(`!!document.getElementById('canonical-chat-input') && !document.getElementById('canonical-chat-input').disabled && !document.body.textContent.includes('native-message-answer')`);
          if (catalogPages) {
            await until(`document.getElementById('canonical-chat-page-status').textContent.includes('최신 세션 페이지 · 100개 표시') && !document.getElementById('canonical-chat-older').disabled`);
            await win.webContents.executeJavaScript(`(()=>{const input=document.getElementById('canonical-chat-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'catalog-page-draft');input.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
            await until(`document.getElementById('canonical-chat-input').value==='catalog-page-draft'`);
            const initialFocus = await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-focus-status').textContent`, true);
            // A same-tick double click must dispatch one bounded older-page read.
            await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-older').click();document.getElementById('canonical-chat-older').click()`, true);
            await until(`document.getElementById('canonical-chat-page-status').textContent.includes('이전 세션 페이지 · 100개 표시') && !!document.getElementById('canonical-chat-latest') && !document.getElementById('canonical-chat-older').disabled`);
            const middle = await win.webContents.executeJavaScript(`({rows:document.getElementById('canonical-chat-select').options.length-1,focus:document.getElementById('canonical-chat-focus-status').textContent,draft:document.getElementById('canonical-chat-input').value})`, true);
            if (middle.rows !== 100 || middle.focus !== initialFocus || middle.draft !== 'catalog-page-draft') throw new Error('Desktop middle catalog page changed focus or draft');
            await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-older').click()`, true);
            await until(`document.getElementById('canonical-chat-page-status').textContent.includes('이전 세션 페이지 · 8개 표시') && document.getElementById('canonical-chat-older').disabled`);
            const terminal = await win.webContents.executeJavaScript(`({rows:document.getElementById('canonical-chat-select').options.length-1,focus:document.getElementById('canonical-chat-focus-status').textContent,draft:document.getElementById('canonical-chat-input').value})`, true);
            if (terminal.rows !== 8 || terminal.focus !== initialFocus || terminal.draft !== 'catalog-page-draft') throw new Error('Desktop terminal catalog page changed focus or draft');
            await win.webContents.executeJavaScript(`document.querySelector('.canonical-chat__sessions').open=true;document.getElementById('canonical-chat-page-status').scrollIntoView({block:'center'});document.getElementById('canonical-chat-older').click()`, true);
            if (option('screenshot')) writeFileSync(option('screenshot').replace(/\.png$/, '-catalog.png'), (await win.webContents.capturePage()).toPNG());
            await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-latest').click()`, true);
            await until(`document.getElementById('canonical-chat-page-status').textContent.includes('최신 세션 페이지 · 100개 표시') && !document.getElementById('canonical-chat-older').disabled && !document.getElementById('canonical-chat-latest')`);
            const latest = await win.webContents.executeJavaScript(`({rows:document.getElementById('canonical-chat-select').options.length-1,focus:document.getElementById('canonical-chat-focus-status').textContent,draft:document.getElementById('canonical-chat-input').value})`, true);
            // The latest page has 100 owned rows; one archived row is intentionally not selectable.
            if (latest.rows !== 99) throw new Error('Desktop latest catalog return selectable row count failed');
            if (latest.focus !== initialFocus) throw new Error('Desktop latest catalog return changed focus');
            if (latest.draft !== 'catalog-page-draft') throw new Error('Desktop latest catalog return changed draft');
          }
          await win.webContents.executeJavaScript(`(()=>{const select=document.getElementById('canonical-chat-select');const option=Array.from(select.options).find(item=>item.textContent.includes('Native shared conversation'));const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));})()`, true);
          await until(`!document.getElementById('canonical-chat-switch').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-switch').click()`, true);
          await until(`document.body.textContent.includes('native-message-answer') && !document.getElementById('canonical-chat-input').disabled`);
          await win.webContents.executeJavaScript(`(()=>{const input=document.getElementById('canonical-chat-input');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,'native-ui-question\\nexact tail\\n');input.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
          await until(`!document.getElementById('canonical-chat-submit').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-read').click()`, true);
          await until(`document.getElementById('canonical-chat-input').value==='native-ui-question\\nexact tail\\n' && !document.getElementById('canonical-chat-submit').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-submit').click();document.getElementById('canonical-chat-submit').click()`, true);
          await until(`!document.getElementById('canonical-chat-retry').disabled`);
          // Close/reopen and visit settings while the original turn's receipt is unknown.
          await win.webContents.executeJavaScript(`document.querySelector('[data-tab-id="canonical-chat"] .tab-close').click()`, true);
          await until(`!document.getElementById('canonical-chat-input')`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-open').click()`, true);
          await until(`!!document.getElementById('canonical-chat-retry') && !document.getElementById('canonical-chat-retry').disabled && document.getElementById('canonical-chat-input').disabled`);
          await win.webContents.executeJavaScript(`document.querySelector('[data-tab-id="settings"]').click()`, true);
          await until(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='기기·세션')`);
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='기기·세션').click()`, true);
          await until(`!!document.getElementById('native-turn-retry') && !document.getElementById('native-turn-retry').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-open').click()`, true);
          await until(`!!document.getElementById('canonical-chat-retry') && !document.getElementById('canonical-chat-retry').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-retry').click()`, true);
          await until(`!document.getElementById('canonical-chat-stop').disabled && document.getElementById('canonical-chat-input').value===''`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-stop').click()`, true);
          await until(`document.body.textContent.includes('native-ui-answer') && !document.getElementById('canonical-chat-input').disabled`);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript(`document.getElementById('canonical-chat-clear').click()`, true);
          await until(`!document.body.textContent.includes('native-ui-answer') && document.getElementById('canonical-chat-input').value==='' && document.getElementById('canonical-chat-input').disabled`);
          const serialized = JSON.stringify(savedConfig);
          for (const forbidden of ['native-ui-question', 'Native created conversation', 'private-server-secret', 'accessToken', 'refreshToken', 'privateKeyPkcs8']) {
            if (serialized.includes(forbidden)) throw new Error('Canonical data persisted into legacy configuration');
          }
          if (legacyDispatches) throw new Error('Legacy chat dispatched from Canonical pane');
          result = { ui: 'passed', sender_isolation: 'passed', legacy_dispatches: legacyDispatches,
            ...(catalogPages ? { catalog_pages: 'passed' } : {}) };
        } finally { suppressNotifications = false; }
      } else if (method === 'verify/session-ui') {
        suppressNotifications = true;
        try {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='세션 상태').click()`, true);
          await until(`document.body.textContent.includes('세션: 사용 가능') && !!document.getElementById('native-session-refresh') && !document.getElementById('native-session-refresh').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-refresh').click()`, true);
          await until(`document.body.textContent.includes('Agent 세션 목록과 현재 포커스를 다시 확인했습니다.') && !document.getElementById('native-session-refresh').disabled`);
          await win.webContents.executeJavaScript(`(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;const workflow=document.getElementById('native-session-workflow');const title=document.getElementById('native-session-title');setter.call(workflow,'native-fixture');workflow.dispatchEvent(new Event('input',{bubbles:true}));setter.call(title,'Native created conversation');title.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
          await until(`document.getElementById('native-session-workflow').value==='native-fixture' && document.getElementById('native-session-title').value==='Native created conversation' && !document.getElementById('native-session-create').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-create').click();document.getElementById('native-session-create').click()`, true);
          await until(`document.body.textContent.includes('작업 완료 여부를 확인할 수 없습니다') && document.getElementById('native-session-create').disabled && document.getElementById('native-session-switch').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-refresh').click()`, true);
          await until(`document.body.textContent.includes('Agent 세션 목록과 현재 포커스를 다시 확인했습니다.') && Array.from(document.getElementById('native-session-select').options).filter(option=>option.textContent.includes('Native created conversation')).length===1 && !document.getElementById('native-session-refresh').disabled`);
          const createdId = await win.webContents.executeJavaScript(`(()=>{const select=document.getElementById('native-session-select');const options=Array.from(select.options).filter(option=>option.textContent.includes('Native created conversation'));return options.length===1&&select.value===options[0].value?options[0].value:'';})()`, true);
          if (!createdId) throw new Error('Desktop recovered Agent session focus missing');
          await until(`document.body.textContent.includes('Native created conversation') && document.body.textContent.includes('현재 대화: ${createdId}')`);
          const sharedId = await win.webContents.executeJavaScript(`(()=>{const select=document.getElementById('native-session-select');const option=Array.from(select.options).find(item=>item.textContent.includes('Native shared conversation'));if(!option) return '';const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));return option.value;})()`, true);
          if (!sharedId) throw new Error('Desktop shared Agent session option missing');
          await until(`!document.getElementById('native-session-switch').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-switch').click()`, true);
          await until(`document.body.textContent.includes('Native shared conversation') && document.body.textContent.includes('현재 대화: ${sharedId}')`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-clear').click()`, true);
          await until(`document.body.textContent.includes('현재 대화: 없음') && document.body.textContent.includes('현재 Agent 세션 포커스를 변경했습니다.') && document.getElementById('native-session-clear').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('native-session-select').scrollIntoView({block:'center'})`, true);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          result = { ui: 'passed', sender_isolation: 'passed', session_lifecycle: 'passed' };
        } finally { suppressNotifications = false; }
      } else if (method.startsWith('native/')) {
        const { user_id, profile, ...body } = params;
        if (user_id && user_id !== userId) throw new Error('Fixture account mismatch');
        const reply = await win.webContents.executeJavaScript(`window.xgen.nativeSession.request(${JSON.stringify(method.slice(7))},${JSON.stringify(body)})`, true);
        if (!reply.ok) { send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: reply.message, data: { code: reply.code,
          ...(reply.outcome ? { details: { outcome: reply.outcome, ...(reply.status ? { status: reply.status } : {}), ...(reply.conflict ? { conflict: reply.conflict } : {}) } } : {}) } } }); return; }
        result = reply.value;
      } else throw new Error('Unsupported fixture method');
      send({ jsonrpc: '2.0', id: request.id, result });
      if (method === 'shutdown' || method === 'exit') setImmediate(close);
    } catch (error) { if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000,
      message: error instanceof Error && error.message.startsWith('Desktop ') ? error.message : 'Desktop fixture operation failed' } }); else close(); }
  })(); });
  lines.on('close', close);
}).catch(() => { process.stderr.write('Desktop native fixture startup failed\n'); close(); app.exit(1); });
