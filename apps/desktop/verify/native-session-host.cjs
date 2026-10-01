/** Opt-in stdio driver for real production Electron IPC/preload/renderer against a supplied HTTPS fixture. */
const { app, BrowserWindow } = require('electron');
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
if (!origin || !userId) throw new Error('Disposable fixture origin and user ID are required');
const directory = mkdtempSync(path.join(tmpdir(), 'dex-desktop-native-ui-'));
mkdirSync(path.join(directory, 'profile'));
app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
let win; let host; let initialized = false; let closing = false; let suppressNotifications = false;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const deadline = setTimeout(() => app.exit(1), 60000);
const close = () => { if (closing) return; closing = true; host?.reset(); clearTimeout(deadline); win?.destroy(); app.quit(); };
app.on('will-quit', () => rmSync(directory, { recursive: true, force: true }));
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript(predicate, true)) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('Desktop fixture UI deadline');
}
app.whenReady().then(async () => {
  buildSync({ entryPoints: [path.join(__dirname, 'native-session-renderer.tsx')], bundle: true, outfile: path.join(directory, 'ui.js'), platform: 'browser', format: 'iife', loader: { '.woff2': 'file' }, tsconfig: path.join(__dirname, '../tsconfig.json') });
  writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ui.css"></head><body><main id="root" class="settings-panel"></main><script src="ui.js"></script></body></html>');
  win = new BrowserWindow({ width: 1050, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, '../out/preload/index.js') } });
  const rendererUrl = new URL(pathToFileURL(path.join(directory, 'index.html')));
  rendererUrl.searchParams.set('origin', origin);
  host = bindDesktopNativeSessions(() => win?.webContents ?? null, () => ({ origin, userId }), rendererUrl.href);
  // Notifications go through the production channel and renderer, then to this test driver's stdout.
  const originalSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, notice) => {
    originalSend(channel, notice);
    if (channel === CHANNELS.nativeSessionUpdate && notice.type === 'update' && initialized && !closing && !suppressNotifications) {
      send({ jsonrpc: '2.0', method: notice.value.view === 'conversation' ? 'native/conversation' : 'native/focus', params: notice.value });
    }
  };
  await win.loadFile(path.join(directory, 'index.html'), { query: { origin } });
  await until(`document.querySelectorAll('button').length >= 10 && !!window.xgen.nativeSession`);
  // Another first-party window still cannot manage this main renderer's native account.
  const guest = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, '../out/preload/index.js') } });
  await guest.loadURL('about:blank');
  const denied = await guest.webContents.executeJavaScript(`window.xgen.nativeSession.request('session', {action:'status'})`);
  guest.destroy(); if (denied.ok || denied.code !== 'auth_required') throw new Error('Desktop fixture IPC sender isolation failed');
  // Even the designated main frame loses native access after navigating away.
  await win.loadURL('about:blank');
  const navigated = await win.webContents.executeJavaScript(`window.xgen.nativeSession.request('session', {action:'status'})`);
  if (navigated.ok || navigated.code !== 'auth_required') throw new Error('Desktop fixture renderer URL isolation failed');
  await win.loadFile(path.join(directory, 'index.html'), { query: { origin } });
  await until(`document.querySelectorAll('button').length >= 10 && !!window.xgen.nativeSession`);
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
    } catch { if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Desktop fixture operation failed' } }); else close(); }
  })(); });
  lines.on('close', close);
}).catch(() => { process.stderr.write('Desktop native fixture startup failed\n'); close(); app.exit(1); });
