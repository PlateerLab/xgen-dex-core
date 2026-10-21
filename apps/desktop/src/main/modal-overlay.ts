import { BrowserWindow } from 'electron';

/** Renderer modals need a native sibling above popup WebContentsViews. */
export function installModalOverlay(
  host: BrowserWindow,
  openExternal: (url: string) => void,
): void {
  host.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const modalUrl = new URL('modal.html', host.webContents.getURL()).href;
    if (url !== modalUrl || frameName !== 'xgen-modal-overlay') {
      openExternal(url);
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      createWindow: (options) => {
        const webPreferences = { ...options.webPreferences };
        delete webPreferences.preload;
        const overlay = new BrowserWindow({
          ...options,
          ...host.getContentBounds(),
          parent: host,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
          hasShadow: false,
          skipTaskbar: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          show: host.isVisible(),
          webPreferences: {
            ...webPreferences,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
          },
        });
        const syncBounds = (): void => overlay.setBounds(host.getContentBounds());
        const show = (): void => {
          if (host.isVisible() && !host.isMinimized()) overlay.show();
        };
        const hide = (): void => overlay.hide();
        host.on('move', syncBounds);
        host.on('resize', syncBounds);
        host.on('show', show);
        host.on('hide', hide);
        host.on('minimize', hide);
        host.on('restore', show);
        overlay.once('closed', () => {
          host.removeListener('move', syncBounds);
          host.removeListener('resize', syncBounds);
          host.removeListener('show', show);
          host.removeListener('hide', hide);
          host.removeListener('minimize', hide);
          host.removeListener('restore', show);
        });
        let loaded = false;
        overlay.webContents.on('did-finish-load', () => {
          if (overlay.webContents.getURL() === modalUrl) loaded = true;
        });
        overlay.webContents.on('will-navigate', (event, target) => {
          if (loaded || target !== modalUrl) event.preventDefault();
        });
        overlay.webContents.setWindowOpenHandler(({ url: target }) => {
          openExternal(target);
          return { action: 'deny' };
        });
        return overlay.webContents;
      },
    };
  });
}
