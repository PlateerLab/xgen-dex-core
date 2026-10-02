/**
 * XD — 서버 없이 이 PC 에서 에이전트를 돌리는 로컬용 XGEN Dex. main 프로세스.
 *
 * 정체성은 Dex 와 **나란히 설치되도록** 모두 따로다: 앱 이름(userData)·appId·작업 표시줄 id·단일 실행
 * 잠금. 루트 폴더와 그 아래 구조는 data-root.ts 가 정한다.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CHANNELS, type XdInfo } from './ipc';
import { canWrite, chooseDataRoot, ensureLayout, movedRootFile, readMovedRoot, rootLayout } from './data-root';

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;

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
