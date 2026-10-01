/** Actual production provider, controller and webview script in an Electron VSCode-shell adapter.
 * Credentials and transport are the real built CLI subprocess and disposable OS keychain.
 * This does not verify installation in the VSCode extension host.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createInterface } = require('node:readline');
const Module = require('node:module');
const { DexRpcClient } = require('@dex/rpc/client');
const { NativeSessionController } = require('../src/native-session-controller.ts');
const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = option('origin'); const userId = option('user-id'); const node = option('node');
if (!origin || !userId || !node) throw new Error('Disposable fixture context is required');
const directory = mkdtempSync(path.join(tmpdir(), 'dex-vscode-native-turn-ui-'));
mkdirSync(path.join(directory, 'profile')); app.setPath('userData', path.join(directory, 'profile'));
app.disableHardwareAcceleration();
const uri = (filename) => ({ fsPath: filename, toString: () => pathToFileURL(filename).href });
const shell = {
  Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), file: uri },
  workspace: { workspaceFolders: [] },
  commands: { executeCommand: async () => undefined },
  window: { showErrorMessage: async () => undefined, showInformationMessage: async () => undefined },
};
const load = Module._load;
Module._load = function (name, ...args) { return name === 'vscode' ? shell : load.call(this, name, ...args); };
const { ChatViewProvider } = require('../src/chat-view-provider.ts');
Module._load = load;
let win; let initialized = false; let closing = false; let suppressNotifications = false; let receiver;
let lastState; let persisted = null;
const rpc = new DexRpcClient({ process: { command: node, args: ['apps/cli/dist/cli.js', 'serve', '--stdio', '--native-platform', 'vscode'],
  env: { ...process.env } }, clientVersion: 'vscode-ui-fixture' });
const context = { extensionUri: uri(path.resolve('apps/vscode')), subscriptions: [], globalState: { get: () => undefined, update: async () => undefined } };
const service = { rpc, request: (method, params = {}) => rpc.request(method, params), profileParams: () => ({ profile: 'fixture' }) };
const chat = new ChatViewProvider(context, service);
const native = new NativeSessionController(rpc, (state) => chat.updateNative(state));
chat.attachNative(native);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const deadline = setTimeout(() => app.exit(1), 90000);
async function close() {
  if (closing) return; closing = true; clearTimeout(deadline); native.dispose(); chat.dispose();
  await rpc.stop(); win?.destroy(); app.quit();
}
app.on('will-quit', () => rmSync(directory, { recursive: true, force: true }));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (await win.webContents.executeJavaScript(predicate, true)) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('VSCode production UI fixture deadline');
}
rpc.onNotification((notice) => { if (initialized && !closing && !suppressNotifications) send(notice); });
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 850, height: 1050, show: false,
    webPreferences: { contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'native-turn-preload.cjs') } });
  const webview = {
    cspSource: 'file:', asWebviewUri: (value) => value.toString(),
    postMessage: async (value) => {
      lastState = value.state;
      if (!win?.isDestroyed()) await win.webContents.executeJavaScript(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(value)}}))`);
      return true;
    },
  };
  chat.view = { webview, show: () => undefined };
  receiver = (value) => chat.onWebviewMessage(value);
  ipcMain.on('fixture/message', (event, value) => { if (event.sender === win.webContents) void receiver(value); });
  ipcMain.on('fixture/persist', (event, value) => { if (event.sender === win.webContents) persisted = value; });
  writeFileSync(path.join(directory, 'index.html'), chat.html(webview));
  await win.loadFile(path.join(directory, 'index.html'));
  await until(`!!document.getElementById('input') && !!document.getElementById('canonical-mode')`);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => { void (async () => {
    let request;
    try {
      request = JSON.parse(line); const { method, params = {} } = request; let result;
      if (method === 'initialize') { initialized = true; result = await rpc.start(); }
      else if (method === 'shutdown' || method === 'exit') result = null;
      else if (method === 'verify/turn-ui') {
        suppressNotifications = true;
        try {
          await native.conversation('fixture', userId);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-mode').click()`, true);
          await until(`!document.getElementById('input').disabled && !document.getElementById('send').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('input').value='한'.repeat(90000);document.getElementById('send').click()`, true);
          await until(`document.getElementById('input').value.length===90000`);
          await win.webContents.executeJavaScript(`document.getElementById('input').value='native-ui-question\\nexact tail\\n';document.getElementById('send').click();document.getElementById('send').click()`, true);
          await until(`!document.getElementById('canonical-retry').disabled && !document.getElementById('canonical-retry').classList.contains('hidden')`);
          if (!lastState?.canonical) throw new Error('Canonical production UI state missing');
          const originalKey = lastState.canonical.turn.request.idempotency_key;
          await native.stopWatch();
          await native.conversation('fixture', userId);
          await native.watchLive('fixture', userId);
          await until(`!document.getElementById('canonical-retry').disabled && !document.getElementById('canonical-retry').classList.contains('hidden')`);
          if (lastState.canonical.turn.request.idempotency_key !== originalKey) throw new Error('Uncertain request was replaced after reconnect');
          await win.webContents.executeJavaScript(`document.getElementById('canonical-retry').click()`, true);
          await until(`!document.getElementById('cancel').disabled && !document.getElementById('cancel').classList.contains('hidden')`);
          await win.webContents.executeJavaScript(`document.getElementById('cancel').click()`, true);
          await until(`document.body.textContent.includes('native-ui-answer') && !document.getElementById('send').disabled`);
          if (JSON.stringify(persisted).includes('native-ui-question')) throw new Error('Canonical draft was persisted');
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          await native.stopWatch();
          result = { ui: 'passed', shell: 'electron-adapter', persisted_draft: false };
        } finally { suppressNotifications = false; }
      } else if (method.startsWith('native/')) result = await rpc.request(method, params);
      else throw new Error('Unsupported fixture method');
      send({ jsonrpc: '2.0', id: request.id, result });
      if (method === 'shutdown' || method === 'exit') setImmediate(close);
    } catch (error) {
      if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: error.rpcCode ?? -32000,
        message: error.rpcCode ? error.message : 'VSCode fixture operation failed', ...(error.data ? { data: error.data } : {}) } });
      else void close();
    }
  })(); });
  lines.on('close', () => void close());
}).catch(() => { process.stderr.write('VSCode production UI fixture startup failed\n'); void close(); app.exit(1); });
