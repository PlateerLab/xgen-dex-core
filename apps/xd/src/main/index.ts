/**
 * XD — 서버 없이 이 PC 에서 에이전트를 돌리는 로컬용 XGEN Dex. main 프로세스.
 *
 * 정체성은 Dex 와 **나란히 설치되도록** 모두 따로다: 앱 이름(userData)·appId·작업 표시줄 id·단일 실행
 * 잠금. 루트 폴더와 그 아래 구조는 data-root.ts 가 정한다.
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DANGEROUS_COMMAND_ANSWERS,
  DANGEROUS_COMMAND_CHOICES,
  dangerousCommandPrompt,
} from '@dex/engine/dangerous-commands';
import { CHANNELS, type ApiResult, type XdInfo } from './ipc';
import { canWrite, chooseDataRoot, ensureLayout, movedRootFile, readMovedRoot, rootLayout } from './data-root';
import { EngineService, enginePythonPath } from './engine-service';
import { Secrets } from './secrets';
import { Store } from './store';
import { BusyError, TurnRunner, type XdTurnEvent } from './turn-runner';
import { createXdApi, type XdApi } from './xd-api';

app.setName('XD');
if (process.platform === 'win32') app.setAppUserModelId('com.plateerlab.xd');

const chosen = chooseDataRoot({
  env: process.env.XD_DATA_ROOT,
  moved: readMovedRoot(movedRootFile(app.getPath('appData'))),
  packaged: app.isPackaged,
  platform: process.platform,
  exeDir: dirname(app.getPath('exe')),
  home: homedir(),
  writable: canWrite,
});
const layout = rootLayout(chosen.root);
ensureLayout(layout);
// userData 를 루트 안으로 — 단일 실행 잠금이 userData 에 있으므로 "루트 하나에 앱 하나" 가 된다.
app.setPath('userData', layout.electron);

/** 위험 명령 확인 — Dex 데스크톱과 같은 문구·버튼(거부가 기본값·Esc). */
async function confirmDangerous(command: string): Promise<'once' | 'session' | 'deny'> {
  const prompt = dangerousCommandPrompt('XD');
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  const options = {
    type: 'warning' as const,
    buttons: [...DANGEROUS_COMMAND_CHOICES],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: prompt.title,
    message: prompt.message,
    detail: prompt.detail(command),
  };
  const result = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return DANGEROUS_COMMAND_ANSWERS[result.response] ?? 'deny';
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;

  // 시험용 가짜 LLM — 엔진이 그 변수로 xd_fake 를 등록할 때만(앱은 설정하지 않는다).
  const allowFakeProvider = Boolean(process.env.XD_ENGINE_FAKE_LLM);
  const store = new Store(join(layout.state, 'xd.db'));
  const secrets = new Secrets(join(layout.state, 'secrets'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : ''),
  });
  const engine = new EngineService({
    python: enginePythonPath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    root: layout.root,
    logDir: layout.logs,
  });
  const broadcast = (event: XdTurnEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(CHANNELS.turnEvent, event);
    }
  };
  const runner = new TurnRunner({
    store,
    engine,
    secret: (accountId) => secrets.get(accountId),
    emit: broadcast,
    confirmDangerous: (command) => confirmDangerous(command),
    allowFakeProvider,
  });
  const api: XdApi = createXdApi({
    store,
    secrets,
    runner,
    engine,
    workspaceDir: layout.workspace,
    stateDir: layout.state,
    allowFakeProvider,
  });

  ipcMain.handle(CHANNELS.api, async (_e, method: unknown, args: unknown): Promise<ApiResult<unknown>> => {
    const fn = typeof method === 'string' && Object.hasOwn(api, method) ? (api as Record<string, unknown>)[method] : null;
    if (typeof fn !== 'function') return { ok: false, error: `unknown method ${String(method)}` };
    try {
      return { ok: true, value: await fn(...(Array.isArray(args) ? args : [])) };
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err), code: err instanceof BusyError ? 'busy' : undefined };
    }
  });

  // 끌 때 — 도는 턴을 엔진이 취소로 마무리하고(저장까지) 저장소를 닫은 뒤에 끝낸다.
  let closing = false;
  app.on('before-quit', (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    void engine
      .stop()
      .catch(() => undefined)
      .then(() => new Promise((r) => setTimeout(r, 0)))
      .finally(() => {
        store.close();
        app.quit();
      });
  });

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 880,
      minHeight: 560,
      title: 'XD',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.once('ready-to-show', () => win?.show());
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void win.loadFile(join(__dirname, '../renderer/index.html'));
  };

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  ipcMain.handle(CHANNELS.info, (): XdInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    root: layout.root,
    rootSource: chosen.source,
    workspace: layout.workspace,
  }));
  ipcMain.handle(CHANNELS.openFolder, async (_e, which: unknown) => {
    const target = which === 'root' ? layout.root : layout.workspace;
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });

  void app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
