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
let lastState; let persisted = null; let sessionStep = '';
const rpc = new DexRpcClient({ process: { command: node, args: ['apps/cli/dist/cli.js', 'serve', '--stdio', '--native-platform', 'vscode'],
  env: { ...process.env } }, clientVersion: 'vscode-ui-fixture' });
let lastRpcFailure = ''; let catalogReadCount = 0;
const requestRpc = rpc.request.bind(rpc);
rpc.request = async (method, params) => {
  if (method === 'native/agent-sessions') catalogReadCount++;
  try { return await requestRpc(method, params); } catch (error) { lastRpcFailure = `${method}:${error.engineCode ?? 'transport'}`; throw error; }
};
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
async function untilState(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate(lastState)) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('VSCode production state fixture deadline');
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
      else if (method === 'verify/attachment-ui') {
        const actions = [];
        native.pickAttachments = async () => { actions.push({ method: 'pick' }); return true; };
        native.uploadAttachment = async (selectionId) => { actions.push({ method: 'upload', selectionId }); return true; };
        native.recoverAttachment = async (selectionId) => { actions.push({ method: 'recover', selectionId }); return true; };
        native.cancelAttachment = async (selectionId) => { actions.push({ method: 'cancel', selectionId }); return true; };
        native.discardAttachments = async () => { actions.push({ method: 'discard' }); return true; };
        native.submitTurn = async (text) => { actions.push({ method: 'submit', text }); };
        chat.canonicalMode = true; chat.screen = 'chat';
        const turn = { status: 'idle', canSubmit: true, canRetry: false, canStop: false };
        const attachment = { selection_id: 'opaque-selection-action', filename: 'visible.bin', size_bytes: 1536,
          media_type: 'application/octet-stream', sha256: 'a'.repeat(64), status: 'selected',
          attachment_id: '00000000-0000-4000-8000-000000000099', receipt: { private: 'must-not-cross' } };
        const view = { status: 'connected', focus: null, conversation: null, hasMore: false,
          scope: { platform_type: 'vscode', profile: 'fixture', server_url: origin, user_id: userId }, turn,
          attachments: { items: [attachment], busy: false, notice: '파일을 업로드해 주세요.' }, connectionVersion: 1 };
        chat.updateNative(view);
        await until(`document.body.textContent.includes('visible.bin') && document.body.textContent.includes('1.5 KB')
          && document.body.textContent.includes('선택됨') && document.getElementById('send').disabled
          && !document.getElementById('attach').classList.contains('hidden')`);
        const body = await win.webContents.executeJavaScript(`document.body.textContent`, true);
        if (body.includes(attachment.sha256) || body.includes(attachment.selection_id)
          || body.includes(attachment.attachment_id) || body.includes('must-not-cross')) {
          throw new Error('Canonical attachment private values rendered in the webview');
        }
        await win.webContents.executeJavaScript(`document.getElementById('attach').click();Array.from(document.querySelectorAll('.canonical-attachment-actions button')).find((button)=>button.textContent==='업로드').click()`, true);
        await untilState(() => actions.some((action) => action.method === 'pick') && actions.some((action) => action.method === 'upload'));
        const second = { ...attachment, selection_id: 'opaque-second-action', filename: 'second.bin' };
        chat.updateNative({ ...view, attachments: { items: [{ ...attachment, status: 'uncertain' }, second], busy: false,
          notice: '업로드 결과를 확인해 주세요.' } });
        await until(`document.querySelector('.canonical-attachment-discard') && document.body.textContent.includes('확인 필요')`);
        const names = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.canonical-attachment-copy b')).map((item)=>item.textContent)`, true);
        if (JSON.stringify(names) !== JSON.stringify(['visible.bin', 'second.bin'])) throw new Error('Attachment order changed');
        await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.canonical-attachment-actions button')).find((button)=>button.textContent==='상태 복구').click();document.querySelector('.canonical-attachment-discard').click()`, true);
        await untilState(() => actions.some((action) => action.method === 'recover') && actions.some((action) => action.method === 'discard'));
        chat.updateNative({ ...view, turn: { ...turn, status: 'unknown', canSubmit: false },
          attachments: { items: [{ ...attachment, status: 'uncertain' }, second], busy: false } });
        await until(`Array.from(document.querySelectorAll('.canonical-attachment-actions button,.canonical-attachment-discard')).every((button)=>button.disabled)`);
        chat.updateNative({ ...view, attachments: { items: [{ ...attachment, status: 'ready' }], busy: false,
          notice: '첨부 파일 업로드를 확인했습니다.' } });
        await until(`!document.getElementById('send').disabled && document.body.textContent.includes('준비 완료')`);
        await win.webContents.executeJavaScript(`document.getElementById('input').value='attachment-ui-submit';document.getElementById('send').click();Array.from(document.querySelectorAll('.canonical-attachment-actions button')).find((button)=>button.textContent==='취소').click()`, true);
        await untilState(() => actions.some((action) => action.method === 'submit' && action.text === 'attachment-ui-submit')
          && actions.some((action) => action.method === 'cancel'));
        result = { ui: 'passed', shell: 'electron-adapter', actions: actions.map((action) => action.method),
          ordered_files: true, unknown_turn_actions_locked: true, private_values_rendered: false };
      }
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
      } else if (method === 'verify/session-ui') {
        suppressNotifications = true;
        try {
          sessionStep = 'initial-read';
          await native.conversation('fixture', userId);
          sessionStep = 'enter-mode';
          await win.webContents.executeJavaScript(`document.getElementById('canonical-mode').click()`, true);
          await untilState((state) => state?.canonical?.active && state.canonical.catalog?.focus?.version === 0
            && !state.canonical.catalog.busy);
          sessionStep = 'open-controls';
          await win.webContents.executeJavaScript(`document.getElementById('change-agent').click()`, true);
          await until(`!document.getElementById('canonical-session-controls').classList.contains('hidden') && !document.getElementById('canonical-session-refresh').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-refresh').click()`, true);
          await untilState((state) => state?.canonical?.catalog?.focus?.version === 0 && !state.canonical.catalog.busy);
          await win.webContents.executeJavaScript(`(()=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;const workflow=document.getElementById('canonical-session-workflow');const title=document.getElementById('canonical-session-title');setter.call(workflow,'native-fixture');workflow.dispatchEvent(new Event('input',{bubbles:true}));setter.call(title,'Native created conversation');title.dispatchEvent(new Event('input',{bubbles:true}));})()`, true);
          await until(`!document.getElementById('canonical-session-create').disabled`);
          sessionStep = 'create-unknown';
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-create').click();document.getElementById('canonical-session-create').click()`, true);
          await untilState((state) => state?.canonical?.catalog?.writeBlocked === true);
          await until(`document.body.textContent.includes('작업 완료 여부를 확인할 수 없습니다') && document.getElementById('canonical-session-create').disabled && document.getElementById('canonical-session-switch').disabled`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-refresh').click()`, true);
          await untilState((state) => {
            const catalog = state?.canonical?.catalog;
            const created = catalog?.items?.filter((item) => item.title === 'Native created conversation') ?? [];
            return created.length === 1 && catalog.focus?.active_agent_session_id === created[0].id && !catalog.busy && !catalog.writeBlocked;
          });
          sessionStep = 'created-recovery';
          const createdId = lastState.canonical.catalog.items.find((item) => item.title === 'Native created conversation').id;
          await untilState((state) => state?.canonical?.title === 'Native created conversation'
            && state.canonical.catalog?.focus?.active_agent_session_id === createdId);
          if (option('catalog-pages')) {
            sessionStep = 'catalog-latest-page';
            await untilState((state) => state?.canonical?.catalog?.page === 1 && state.canonical.catalog.hasMore
              && state.canonical.catalog.items.length === 100 && !state.canonical.catalog.busy);
            const beforeIdentity = lastState.canonical.identity;
            await win.webContents.executeJavaScript(`document.getElementById('input').value='catalog draft stays local';document.getElementById('canonical-session-older').click();document.getElementById('canonical-session-older').click()`, true);
            await untilState((state) => state?.canonical?.catalog?.page === 2 && state.canonical.catalog.items.length === 100
              && state.canonical.catalog.hasMore && !state.canonical.catalog.busy);
            if (lastState.canonical.identity !== beforeIdentity) {
              throw new Error('VSCode catalog page changed the active conversation');
            }
            await until(`document.getElementById('input').value==='catalog draft stays local' && document.getElementById('canonical-session-page').textContent.includes('페이지 2')`);
            sessionStep = 'catalog-terminal-page';
            await win.webContents.executeJavaScript(`document.getElementById('canonical-session-older').click()`, true);
            await untilState((state) => state?.canonical?.catalog?.page === 3 && state.canonical.catalog.items.length === 8
              && !state.canonical.catalog.hasMore && state.canonical.catalog.nextCursor === null && !state.canonical.catalog.busy);
            if (lastState.canonical.identity !== beforeIdentity) {
              throw new Error('VSCode terminal catalog page changed the active conversation');
            }
            await until(`document.getElementById('input').value==='catalog draft stays local' && document.getElementById('canonical-session-page').textContent.includes('페이지 3') && document.getElementById('canonical-session-older').disabled`);
            const readsAtEnd = catalogReadCount;
            await win.webContents.executeJavaScript(`document.getElementById('canonical-session-older').click()`, true);
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (catalogReadCount !== readsAtEnd || lastState.canonical.catalog.page !== 3) {
              throw new Error('VSCode terminal catalog page issued another read');
            }
            await win.webContents.executeJavaScript(`document.getElementById('canonical-session-page').scrollIntoView({block:'center'})`, true);
            if (option('screenshot')) writeFileSync(option('screenshot').replace(/\.png$/, '-catalog.png'), (await win.webContents.capturePage()).toPNG());
            sessionStep = 'catalog-return-latest';
            await win.webContents.executeJavaScript(`document.getElementById('canonical-session-refresh').click()`, true);
            await untilState((state) => state?.canonical?.catalog?.page === 1 && state.canonical.catalog.items.length === 100
              && state.canonical.catalog.hasMore && !state.canonical.catalog.busy);
            if (lastState.canonical.identity !== beforeIdentity) {
              throw new Error('VSCode latest catalog refresh changed the active conversation');
            }
            await until(`document.getElementById('input').value==='catalog draft stays local' && document.getElementById('canonical-session-page').textContent.includes('페이지 1')`);
            await win.webContents.executeJavaScript(`document.getElementById('input').value=''`, true);
          }
          sessionStep = 'select-owned';
          const sharedId = await win.webContents.executeJavaScript(`(()=>{const select=document.getElementById('canonical-session-select');const option=Array.from(select.options).find(item=>item.textContent.includes('Native shared conversation'));if(!option) return '';const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,option.value);select.dispatchEvent(new Event('change',{bubbles:true}));return option.value;})()`, true);
          if (!sharedId) throw new Error('VSCode shared Agent session option missing');
          await until(`!document.getElementById('canonical-session-switch').disabled`);
          sessionStep = 'switch-owned';
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-switch').click()`, true);
          await untilState((state) => state?.canonical?.catalog?.focus?.active_agent_session_id === sharedId
            && state.canonical.title === 'Native shared conversation');
          sessionStep = 'clear-focus';
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-clear').click()`, true);
          await untilState((state) => state?.canonical?.catalog?.focus?.active_agent_session_id === null
            && state.canonical.catalog.notice === '현재 Agent 세션 포커스를 변경했습니다.');
          await until(`document.getElementById('canonical-session-clear').disabled && document.body.textContent.includes('현재 Agent 세션 포커스를 변경했습니다.')`);
          await win.webContents.executeJavaScript(`document.getElementById('canonical-session-controls').scrollIntoView({block:'center'})`, true);
          if (option('screenshot')) writeFileSync(option('screenshot'), (await win.webContents.capturePage()).toPNG());
          result = { ui: 'passed', shell: 'electron-adapter', session_lifecycle: 'passed',
            ...(option('catalog-pages') ? { catalog_pages: 'passed', catalog_page_sizes: [100, 100, 8, 100],
              catalog_terminal_guard: 'passed' } : {}) };
        } finally { suppressNotifications = false; }
      } else if (method.startsWith('native/')) result = await rpc.request(method, params);
      else throw new Error('Unsupported fixture method');
      send({ jsonrpc: '2.0', id: request.id, result });
      if (method === 'shutdown' || method === 'exit') setImmediate(close);
    } catch (error) {
      if (request?.method === 'verify/session-ui' && option('screenshot')) writeFileSync(option('screenshot').replace('.png', '-failed.png'), (await win.webContents.capturePage()).toPNG());
      if (request?.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: error.rpcCode ?? -32000,
        message: error.rpcCode ? error.message : `VSCode fixture operation failed${request?.method === 'verify/session-ui' ? ` at ${sessionStep} (${lastRpcFailure || 'no-rpc-rejection'})` : ''}`, ...(error.data ? { data: error.data } : {}) } });
      else void close();
    }
  })(); });
  lines.on('close', () => void close());
}).catch(() => { process.stderr.write('VSCode production UI fixture startup failed\n'); void close(); app.exit(1); });
