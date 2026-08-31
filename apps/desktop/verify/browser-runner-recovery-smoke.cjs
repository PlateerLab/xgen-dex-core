/* Manual/CI smoke for a genuine CDP port replacement through AgentBrowserRunner. */
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { join } = require('node:path');

const proxyModule = process.argv[2];
const runnerModule = process.argv[3];
if (!proxyModule || !runnerModule) {
  throw new Error('usage: electron browser-runner-recovery-smoke.cjs <proxy.cjs> <runner.cjs>');
}
const { CdpPageProxy } = require(proxyModule);
const { AgentBrowserRunner } = require(runnerModule);

function helperPid(pageId) {
  try {
    return Number(
      readFileSync(join(app.getPath('home'), '.agent-browser', `xgen-page-${pageId}.pid`), 'utf8'),
    );
  } catch {
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function closedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no loopback port'));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

app
  .whenReady()
  .then(async () => {
    const pageId = `runner-smoke-${Date.now()}`;
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const runner = new AgentBrowserRunner();
    let proxy = null;
    try {
      await win.loadURL('data:text/html,<button>Runner recovery</button>');
      proxy = new CdpPageProxy(pageId, win.webContents, () => {});
      const first = await runner.run(pageId, proxy, ['snapshot', '-i']);
      if (!JSON.stringify(first).includes('Runner recovery')) throw new Error('first snapshot failed');
      const firstPort = proxy.port;

      // A real WebContents replacement cannot retain its old proxy. Verify the
      // fallback path fully retires the old daemon before reusing the session.
      await proxy.stop();
      proxy = new CdpPageProxy(pageId, win.webContents, () => {});
      const second = await runner.run(pageId, proxy, ['snapshot', '-i']);
      if (!JSON.stringify(second).includes('Runner recovery')) throw new Error('recovery failed');
      if (!proxy.port || proxy.port === firstPort) throw new Error('expected a replacement port');

      const firstPid = helperPid(pageId);
      await runner.cancelPage(pageId);
      await proxy.stop();

      // agent-browser reports connection failures inside JSON even when its CLI
      // exits successfully. Feed one closed port, then the real stable proxy,
      // and verify AgentBrowserRunner performs exactly one clean reconnect.
      const refusedPageId = `runner-refused-${Date.now()}`;
      proxy = new CdpPageProxy(refusedPageId, win.webContents, () => {});
      const livePort = await proxy.start();
      const refusedPort = await closedLoopbackPort();
      let starts = 0;
      const flakyProxy = {
        start: async () => (++starts === 1 ? refusedPort : livePort),
      };
      const retried = await runner.run(refusedPageId, flakyProxy, ['snapshot', '-i']);
      if (!JSON.stringify(retried).includes('Runner recovery')) {
        throw new Error('connection-refused retry failed');
      }

      const refusedPid = helperPid(refusedPageId);
      await runner.closeAll();
      if (alive(firstPid) || alive(refusedPid)) {
        throw new Error(`agent-browser helper still alive: ${firstPid}, ${refusedPid}`);
      }
      console.log('browser runner recovery smoke: ok');
    } finally {
      await runner.closeAll().catch(() => undefined);
      await proxy?.stop().catch(() => undefined);
      if (!win.isDestroyed()) win.destroy();
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
