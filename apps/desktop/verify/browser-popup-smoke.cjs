const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  const popup = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('popup handler was not called')), 5000);
    win.webContents.once('did-attach-webview', (_event, guest) => {
      guest.setWindowOpenHandler(({ url, postBody }) => {
        clearTimeout(timer);
        resolve({ url, postBody: postBody ?? null });
        return { action: 'deny' };
      });
      guest.once('did-finish-load', () => {
        void guest.executeJavaScript("document.querySelector('#popup-link').click()");
      });
    });
  });

  const guestHtml = [
    '<!doctype html>',
    '<a id="popup-link" href="https://labs.plateer.com/"',
    ' target="_blank" rel="noopener noreferrer">open</a>',
  ].join('');
  const guestUrl = `data:text/html;charset=utf-8,${encodeURIComponent(guestHtml)}`;
  const hostHtml = `<!doctype html><webview allowpopups src="${guestUrl}"></webview>`;

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hostHtml)}`);
    const result = await popup;
    if (result.url !== 'https://labs.plateer.com/') {
      throw new Error(`unexpected popup URL: ${result.url}`);
    }
    if (result.postBody !== null) throw new Error('plain anchor unexpectedly contained POST data');
    process.stdout.write('browser popup request reached the denying handler\n');
    win.destroy();
    app.quit();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    win.destroy();
    app.exit(1);
  }
});
