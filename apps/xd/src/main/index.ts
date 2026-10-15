/**
 * XD — 서버 없이 이 PC 에서 에이전트를 돌리는 로컬용 XGEN Dex. main 프로세스.
 *
 * 정체성은 Dex 와 **나란히 설치되도록** 모두 따로다: 앱 이름(userData)·appId·작업 표시줄 id·단일 실행
 * 잠금. 루트 폴더와 그 아래 구조는 data-root.ts 가 정한다.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DANGEROUS_COMMAND_ANSWERS,
  DANGEROUS_COMMAND_CHOICES,
  dangerousCommandPrompt,
} from '@dex/engine/dangerous-commands';
import { CHANNELS, type ApiResult, type IdeResult, type XdInfo } from './ipc';
import { canWrite, chooseDataRoot, ensureLayout, movedRootFile, readMovedRoot, rootLayout } from './data-root';
import { EngineService, enginePythonPath } from './engine-service';
import { Secrets } from './secrets';
import { Store } from './store';
import { augmentedPath } from '@dex/engine/exec-resolve';
import { CliService, type CliEvent } from './cli/service';
import { FolderFsError } from './dex';
import { IdeService } from './ide-service';
import { checkForUpdates, downloadMacUpdate, onUpdateState, startUpdater, updateState } from './updater';
import { BusyError, TurnRunner, type XdTurnEvent } from './turn-runner';
import { createXdApi, XdError, type XdApi } from './xd-api';

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

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 위험 명령 확인 — Dex 데스크톱과 같은 문구·버튼(거부가 기본값·Esc). 에이전트가 여럿이라 누가 묻는지를 주어로
 * 넣는다("XD 의 리서치 도우미 에이전트가 …").
 */
async function confirmDangerous(command: string, agentName: string): Promise<'once' | 'session' | 'deny'> {
  // 문장이 "… 에이전트가" 로 이어진다 — 이름이 이미 "에이전트" 로 끝나면 겹치지 않게 뗀다.
  const name = agentName.replace(/\s*에이전트$/, '').trim();
  const prompt = dangerousCommandPrompt(name ? `XD 의 ${name}` : 'XD');
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
  const send = (channel: string, event: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, event);
    }
  };
  const broadcast = (event: XdTurnEvent): void => send(CHANNELS.turnEvent, event);
  const cli = new CliService({
    cliDir: join(layout.state, 'cli'),
    pathStr: augmentedPath,
    emit: (event: CliEvent) => {
      // 로그인이 끝나면 그 CLI 의 계정을 여기서 만든다 — 화면이 그 사이 닫혀 있어도, 여러 번 로그인해도 하나만.
      if (event.type === 'login' && event.event.type === 'done' && event.event.ok) {
        try {
          api.cliAccountEnsure(event.cli);
        } catch (err) {
          console.error('[xd] CLI account', err);
        }
      }
      send(CHANNELS.cliEvent, event);
    },
  });
  const runner = new TurnRunner({
    store,
    engine,
    secret: (accountId) => secrets.get(accountId),
    cli: (name) => {
      const binary = cli.binary(name);
      return binary ? { binary, home: cli.home(name) } : null;
    },
    emit: broadcast,
    confirmDangerous: (command, context) => confirmDangerous(command, context.agentName),
    allowFakeProvider,
  });
  const api: XdApi = createXdApi({
    store,
    secrets,
    runner,
    engine,
    cli,
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
      const code = err instanceof BusyError ? 'busy' : err instanceof XdError ? err.code : undefined;
      return { ok: false, error: (err as Error).message ?? String(err), code };
    }
  });

  // 끌 때 — 도는 턴을 엔진이 취소로 마무리하고(저장까지) 저장소를 닫은 뒤에 끝낸다.
  let closing = false;
  /** 엔진(과 그 MCP 서버)을 멈추고 저장소를 닫는다 — 끌 때도, 업데이트로 바꾸기 전에도. 한 번만 돈다. */
  let shuttingDown: Promise<void> | null = null;
  const shutdown = (): Promise<void> =>
    (shuttingDown ??= engine
      .stop()
      .catch(() => undefined)
      .then(() => new Promise<void>((r) => setTimeout(r, 0)))
      .finally(() => store.close()));
  app.on('before-quit', (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    void shutdown().finally(() => app.quit());
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
    // 이 창은 앱 화면만 연다 — 새 창은 띄우지 않고(https 링크만 브라우저로), 앱 밖으로 옮겨 가지 않는다.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttps(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== win?.webContents.getURL()) {
        event.preventDefault();
        if (isHttps(url)) void shell.openExternal(url);
      }
    });
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
  ipcMain.handle(CHANNELS.openFolder, async (_e, which: unknown, agentId?: unknown, index?: unknown) => {
    let target = which === 'root' ? layout.root : layout.workspace;
    if (which === 'linked') {
      // 화면은 경로가 아니라 몇 번째 연결 폴더인지만 준다 — 아무 경로나 열게 하지 않는다.
      const agent = typeof agentId === 'string' ? store.getAgent(agentId) : null;
      const folder = agent && typeof index === 'number' ? agent.folders[index] : undefined;
      if (!folder) return { ok: false, error: 'no linked folder' };
      target = folder;
    } else if (which === 'agent') {
      const agent = typeof agentId === 'string' ? store.getAgent(agentId) : null;
      if (!agent) return { ok: false, error: 'no agent' };
      target = join(layout.workspace, agent.workspace);
      try {
        mkdirSync(target, { recursive: true });
      } catch (err) {
        return { ok: false, error: String((err as Error).message ?? err) };
      }
    }
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle(CHANNELS.pickFolder, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = await (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options));
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
  });
  ipcMain.handle(CHANNELS.openExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string' || !isHttps(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  // 작업 공간 IDE — 에이전트의 작업 공간·연결 폴더(몇 번째)만. 지우면 휴지통으로.
  const ide = new IdeService({
    store,
    workspaceDir: layout.workspace,
    stateDir: layout.state,
    trash: (abs) => shell.trashItem(abs),
    reveal: (abs) => shell.showItemInFolder(abs),
  });
  ipcMain.handle(CHANNELS.ide, async (_e, agentId: unknown, root: unknown, op: unknown, args: unknown): Promise<IdeResult<unknown>> => {
    try {
      if (typeof agentId !== 'string' || typeof op !== 'string' || typeof root !== 'string') throw new FolderFsError('bad_request', '잘못된 요청입니다');
      const value = await ide.call(agentId, root, op, args && typeof args === 'object' ? (args as Record<string, unknown>) : {});
      return { ok: true, value };
    } catch (err) {
      if (err instanceof FolderFsError) return { ok: false, code: err.code, message: err.message, detail: err.detail };
      // 운영체제의 실패 — 영어 원문·절대 경로를 화면에 내지 않는다(원문은 로그에).
      const code = (err as NodeJS.ErrnoException)?.code;
      console.error('[xd] ide', op, err);
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, code: 'forbidden', message: '이 파일에 접근할 권한이 없습니다' };
      if (code === 'ENOENT') return { ok: false, code: 'not_found', message: '파일이 없습니다' };
      if (code === 'ENOSPC') return { ok: false, code: 'error', message: '디스크에 남은 공간이 없습니다' };
      return { ok: false, code: 'error', message: '파일 작업을 마치지 못했습니다' };
    }
  });
  ipcMain.handle(CHANNELS.ideFolders, (_e, agentId: unknown) => (typeof agentId === 'string' ? ide.folders(agentId) : []));
  ipcMain.handle(CHANNELS.clipboardWrite, (_e, text: unknown) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle(CHANNELS.updateState, () => updateState());
  ipcMain.handle(CHANNELS.updateCheck, () => checkForUpdates());
  ipcMain.handle(CHANNELS.updateDownload, () => downloadMacUpdate());
  onUpdateState((state) => send(CHANNELS.updateEvent, state));

  void app.whenReady().then(() => {
    createWindow();
    // 바꾸기 전에 엔진을 먼저 멈춘다 — 설치 프로그램이 XD 를 끝내기 전에 엔진 파일의 잠금이 풀려 있어야 한다.
    startUpdater({
      beforeInstall: async () => {
        closing = true;
        await shutdown();
      },
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
