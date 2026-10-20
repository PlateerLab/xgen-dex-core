const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync } = require('node:fs');
const { buildSync } = require('esbuild');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { BrowserRuntime } = require('../src/main/browser-runtime.ts');
const { executeBrowserStep } = require('../src/main/browser-step.ts');
const { allowsDeciderAction } = require('../src/main/fast-act.ts');

app.setPath('userData', mkdtempSync(join(tmpdir(), 'dex-popup-smoke-')));
app.commandLine.appendSwitch('disable-gpu');

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('popup smoke timed out');
}

async function main() {
  await app.whenReady();
  let hostHtml = '';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/host') return response.end(hostHtml);
    if (request.url === '/surface') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const { pageId, rect } = JSON.parse(body);
        runtime.updatePopupSurface(pageId, rect);
        response.end('{}');
      });
      return;
    }
    if (request.url === '/vendor') {
      response.end(`<!doctype html><button id="validate">검증</button><button id="confirm" onclick="
        window.opener.pickVendor('플래티어');
        window.opener.postMessage('vendor-selected', location.origin);
        window.close();">확인</button>`);
    } else {
      response.setHeader('set-cookie', 'smoke=present; Path=/; SameSite=Lax');
      response.end(`<!doctype html><input id="vendor" aria-label="협력사"><input type="checkbox" aria-label="사용"><button id="open" onclick="
        window.vendorWindow = window.open('/vendor', 'vendor', 'width=420,height=300');">협력사</button>
        <a id="link" href="/vendor" target="_blank" rel="noopener">새 탭 링크</a>
        <script>
          window.pickVendor = name => document.querySelector('#vendor').value = name;
          window.addEventListener('message', e => {
            if (e.origin === location.origin) window.vendorMessage = e.data;
          });
        </script>`);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const runtime = new BrowserRuntime();
  runtime.configure({ enabled: true, serverUrl: origin, userId: 'smoke' });
  const parent = await runtime.create({ workflowId: 'smoke', mode: 'shared', url: origin });
  const host = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  runtime.setPopupHostWindow(host);
  try {
    let guest;
    host.webContents.once('did-attach-webview', (_event, contents) => {
      guest = contents;
      runtime.registerSharedGuest(guest);
      runtime.bindSharedPage(parent.pageId, guest.id);
    });
    hostHtml = `<webview allowpopups partition="${runtime.partition()}" src="${origin}"></webview><div id="popup-ui"></div>`;
    await host.loadURL(`${origin}/host`);
    await waitFor(() => guest && !guest.isLoading() && guest.getURL() === `${origin}/`);

    // The fixture chooses the model's answer; snapshot/ref execution and readback use real CDP.
    const post = async ({ state, questions }) => {
      const name = state.endsWith('검증 클릭') ? '검증' : '확인';
      const chosen = state.match(new RegExp(`^(e\\d+) \\| button \\| "${name}"`, 'm'))?.[1];
      assert.ok(chosen, state);
      return Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, {
        choice: chosen,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map(ref => [ref, ref === chosen ? 0.99 : 0.005])),
      }]));
    };
    const step = (page, args) => executeBrowserStep(runtime, post, page, args, () => {}, allowsDeciderAction);
    const filled = await step(parent, { operation: 'fill', instruction: '협력사 입력', text: '한글 "정확한 입력"', expect: [{ kind: 'value', target: '협력사', value: '한글 "정확한 입력"' }] });
    assert.equal(filled.result.status, 'completed', JSON.stringify(filled.result));
    const checked = await step(runtime.get(parent.pageId), { operation: 'check', instruction: '사용 체크', expect: [{ kind: 'checked', target: '사용', checked: true }] });
    assert.equal(checked.result.status, 'completed', JSON.stringify(checked.result));

    await guest.executeJavaScript("document.querySelector('#open').click()");
    await waitFor(() => runtime.state().popupRequests.length === 1);
    assert.equal(runtime.list('smoke').length, 1);
    await runtime.resolvePopup({
      requestId: runtime.state().popupRequests[0].requestId,
      decision: 'allow_session',
    });
    assert.equal(runtime.list('smoke').length, 1, 'approval must not replay the URL');

    await guest.executeJavaScript("document.querySelector('#open').click()");
    await waitFor(() => runtime.list('smoke').some((page) => page.mode === 'popup'));
    const popup = runtime.list('smoke').find((page) => page.mode === 'popup');
    const popupRuntime = await runtime.resolvePage('smoke', popup.pageId, false);
    const child = popupRuntime.contents;
    runtime.updatePopupSurface(popup.pageId, { x: 0, y: 50, width: 600, height: 400 });
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'popup must stay inside the main window');
    assert.equal(host.contentView.children.includes(popupRuntime.view), true);
    assert.equal(popupRuntime.view.getVisible(), true);
    assert.deepEqual(popupRuntime.view.getBounds(), { x: 0, y: 50, width: 600, height: 400 });
    await waitFor(() => !child.isLoading() && child.getURL() === `${origin}/vendor`);
    assert.equal(child.session, guest.session);
    assert.equal(await child.executeJavaScript('window.opener !== null'), true);
    assert.equal(await child.executeJavaScript('document.cookie'), 'smoke=present');
    assert.equal(await guest.executeJavaScript('window.vendorWindow !== null'), true);
    const prefs = child.getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.webSecurity, true);
    assert.equal(prefs.webviewTag, false);
    assert.equal(await child.executeJavaScript('typeof require'), 'undefined');

    const ui = buildSync({
      stdin: { contents: `
        import { createRoot } from 'react-dom/client';
        window.xgen = { browser: { popupSurface: (pageId, rect) =>
          fetch('/surface', {method: 'POST', body: JSON.stringify({pageId, rect})}) } };
        import('./src/renderer/src/views/BrowserSurface').then(({BrowserSurface}) => {
          const root = createRoot(document.getElementById('popup-ui')), noop = () => {};
          window.renderPopup = page => root.render(<BrowserSurface pages={[page]}
            rects={{[page.pageId]: {left:0,top:50,width:600,height:400}}} dragging={false} selection={null}
            onFocusPage={noop} onSelectionComplete={noop} onSelectionCancel={noop} onSelectionError={noop} />);
        });`, resolveDir: join(__dirname, '..'), loader: 'tsx' },
      bundle: true, platform: 'browser', write: false, tsconfig: join(__dirname, '../tsconfig.json'),
    }).outputFiles[0].text;
    await host.webContents.executeJavaScript(ui);
    await waitFor(async () => host.webContents.executeJavaScript('typeof window.renderPopup === "function"'));
    await host.webContents.executeJavaScript(`window.renderPopup(${JSON.stringify(popup)})`);
    await waitFor(() => popupRuntime.view.getVisible());
    await host.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<div id="outer" class="modal-backdrop" style="position:fixed;inset:0"></div>')`);
    await waitFor(() => !popupRuntime.view.getVisible());
    await host.webContents.executeJavaScript(`
      document.body.insertAdjacentHTML('beforeend', '<div id="nested" class="modal-backdrop" style="position:fixed;inset:0"></div>');
      document.getElementById('outer').remove();
    `);
    assert.equal(popupRuntime.view.getVisible(), false, 'closing one of two dialogs must keep the popup hidden');
    await host.webContents.executeJavaScript('document.getElementById("nested").hidden = true');
    await waitFor(() => popupRuntime.view.getVisible());
    await host.webContents.executeJavaScript('document.getElementById("nested").hidden = false');
    await waitFor(() => !popupRuntime.view.getVisible());
    await host.webContents.executeJavaScript('document.getElementById("nested").remove()');
    await waitFor(() => popupRuntime.view.getVisible());
    assert.equal(child.isDestroyed(), false, 'hide/show must preserve popup contents and opener');

    const snapshot = await runtime.runAgentCommand('smoke', popup.pageId, ['snapshot', '-i']);
    assert.match(JSON.stringify(snapshot.result), /확인/);
    const unchanged = await step(popup, { operation: 'click', instruction: '검증 클릭', expect: [{ kind: 'popup_closed' }] });
    assert.equal(unchanged.result.status, 'needs_replan', JSON.stringify(unchanged.result));
    assert.ok(
      runtime.get(popup.pageId),
      'a confirmation button that keeps the page open must not close its tab',
    );
    assert.equal(runtime.state().activeByWorkflow.smoke, popup.pageId);
    const confirmed = await step(runtime.get(popup.pageId), { operation: 'click', instruction: '확인 클릭', expect: [{ kind: 'popup_closed' }, { kind: 'value', target: '협력사', value: '플래티어' }] });
    assert.equal(confirmed.result.status, 'completed', JSON.stringify(confirmed.result));
    await waitFor(() => runtime.get(popup.pageId) === null);
    await waitFor(() => runtime.state().activeByWorkflow.smoke === parent.pageId);
    assert.equal(host.contentView.children.includes(popupRuntime.view), false);
    assert.equal(
      await guest.executeJavaScript("document.querySelector('#vendor').value"),
      '플래티어',
    );
    await waitFor(
      async () => (await guest.executeJavaScript('window.vendorMessage')) === 'vendor-selected',
    );
    assert.equal(await guest.executeJavaScript('window.vendorWindow.closed'), true);

    await guest.executeJavaScript("document.querySelector('#link').click()");
    await waitFor(() => runtime.list('smoke').some((page) => page.mode === 'popup'));
    const linked = runtime.list('smoke').find((page) => page.mode === 'popup');
    const linkedContents = (await runtime.resolvePage('smoke', linked.pageId, false)).contents;
    await waitFor(
      () => !linkedContents.isLoading() && linkedContents.getURL() === `${origin}/vendor`,
    );
    assert.equal(await linkedContents.executeJavaScript('window.opener === null'), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await runtime.close(linked.pageId);

    await guest.executeJavaScript("document.querySelector('#open').click()");
    await waitFor(() => runtime.list('smoke').some((page) => page.mode === 'popup'));
    const second = runtime.list('smoke').find((page) => page.mode === 'popup');
    const secondContents = (await runtime.resolvePage('smoke', second.pageId, false)).contents;
    await runtime.close(parent.pageId);
    await waitFor(() => secondContents.isDestroyed());
    assert.equal(runtime.list('smoke').length, 0);
    process.stdout.write(
      'browser popup tab smoke ok: exact fill, checkbox readback, unchanged step rejection, verified parent callback, modal stacking, nested dialogs, hidden dialogs, popup restoration, single OS window, embedded view, opener, postMessage, close, session, sandbox, agent control, parent cleanup\n',
    );
  } finally {
    await runtime.closeAll();
    host.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

void main()
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    app.exit(1);
  });
