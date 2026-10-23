const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { buildSync } = require('esbuild');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { BrowserRuntime } = require('../src/main/browser-runtime.ts');
const { BrowserToolProvider, BROWSER_INTERACT_TOOL } = require('../src/main/browser-tools.ts');
const { executeBrowserStep } = require('../src/main/browser-step.ts');
const { allowsDeciderAction } = require('../src/main/fast-act.ts');
const { installModalOverlay } = require('../src/main/modal-overlay.ts');

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
    if (request.url === '/modal.html')
      return response.end('<!doctype html><body><script>window.opener.postMessage("xgen-modal-ready", "*")</script>');
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  runtime.setPopupHostWindow(host);
  installModalOverlay(host, () => {});
  try {
    let guest;
    host.webContents.once('did-attach-webview', (_event, contents) => {
      guest = contents;
      runtime.registerSharedGuest(guest);
      runtime.bindSharedPage(parent.pageId, guest.id);
    });
    hostHtml = `<style>${readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')}</style><webview allowpopups webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no" partition="${runtime.partition()}" src="${origin}"></webview><div id="popup-ui"></div>`;
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

    const provider = new BrowserToolProvider(runtime);
    provider.configure(true);
    const opened = JSON.parse((await provider.callTool(BROWSER_INTERACT_TOOL,
      { action: 'click', page_id: parent.pageId, ref: '#open' }, { workflowId: 'smoke' })).content[0].text);
    assert.equal(opened.page_id, parent.pageId);
    assert.equal(opened.result.opened_pages.length, 1);
    const popup = runtime.list('smoke').find((page) => page.mode === 'popup');
    assert.equal(opened.result.opened_pages[0].page_id, popup.pageId);
    assert.equal(opened.result.opened_pages[0].url, `${origin}/vendor`);
    assert.match(opened.result.next_step, /BrowserSnapshot/);
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
        Promise.all([
          import('./src/renderer/src/views/BrowserSurface'),
          import('./src/renderer/src/views/ToolLogModal'),
          import('./src/renderer/src/views/ModalPortal'),
          import('./src/renderer/src/views/use-modal-dismiss'),
          import('./src/renderer/src/views/Selector'),
        ]).then(([{BrowserSurface}, {ToolLogModal}, {ModalPortal}, {useModalDismiss}, {Selector}]) => {
          const root = createRoot(document.getElementById('popup-ui')), noop = () => {};
          const modalRoot = createRoot(document.body.appendChild(document.createElement('div')));
          const close = () => modalRoot.render(null);
          const SettingsFixture = () => {
            useModalDismiss(close);
            return <ModalPortal onClose={close}><div className="modal-backdrop"><div className="modal">
              <Selector value="one" options={[{value:'one',label:'첫 번째'},{value:'two',label:'두 번째'}]}
                onChange={value => window.selectedSetting = value} />
            </div></div></ModalPortal>;
          };
          window.renderModal = settings => modalRoot.render(settings ? <SettingsFixture /> :
            <ModalPortal onClose={close}><ToolLogModal events={[]} onClose={close} /></ModalPortal>);
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
    const modalPopupRuntime = await runtime.resolvePage('smoke', second.pageId, false);
    await secondContents.executeJavaScript('document.body.insertAdjacentHTML("beforeend", \'<input id="draft" value="작성 중인 내용">\')');
    await host.webContents.executeJavaScript(`window.renderPopup(${JSON.stringify(second)})`);
    await waitFor(() => modalPopupRuntime.view.getVisible());
    await host.webContents.executeJavaScript('window.renderModal(false)');
    await waitFor(() => BrowserWindow.getAllWindows().length === 2);
    let overlay = BrowserWindow.getAllWindows().find(window => window !== host);
    await waitFor(async () => overlay.webContents.executeJavaScript('!!document.querySelector(".toollog")'));
    assert.equal(overlay.getParentWindow(), host);
    assert.equal(overlay.isVisible(), false, 'hidden host must not expose a modal window');
    assert.equal(modalPopupRuntime.view.getVisible(), true, 'modal must keep the popup visible');
    assert.deepEqual(modalPopupRuntime.view.getBounds(), { x: 0, y: 50, width: 600, height: 400 });
    assert.equal(overlay.webContents.getLastWebPreferences().preload, undefined);
    assert.equal(overlay.webContents.getLastWebPreferences().sandbox, true);
    host.showInactive();
    await waitFor(() => overlay.isVisible());
    const image = await overlay.webContents.capturePage();
    writeFileSync(join(app.getPath('userData'), 'modal-overlay.png'), image.toPNG());
    assert.ok(image.toBitmap()[3] < 255, 'modal background must remain translucent');
    host.setContentSize(820, 620);
    await waitFor(() => overlay.getBounds().width === host.getContentBounds().width);
    host.hide();
    await waitFor(() => !overlay.isVisible());
    await overlay.webContents.executeJavaScript('document.querySelector(\'[aria-label="닫기"]\').click()');
    await waitFor(() => BrowserWindow.getAllWindows().length === 1);
    await host.webContents.executeJavaScript('window.renderModal(true)');
    await waitFor(() => BrowserWindow.getAllWindows().length === 2);
    overlay = BrowserWindow.getAllWindows().find(window => window !== host);
    await waitFor(async () => overlay.webContents.executeJavaScript('!!document.querySelector(".selector-trigger")'));
    await overlay.webContents.executeJavaScript('document.querySelector(".selector-trigger").click()');
    await waitFor(async () => overlay.webContents.executeJavaScript('!!document.querySelector(\'[role="option"]\')'));
    await overlay.webContents.executeJavaScript('document.querySelectorAll(\'[role="option"]\')[1].click()');
    assert.equal(await host.webContents.executeJavaScript('window.selectedSetting'), 'two');
    await overlay.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true}))');
    await waitFor(() => BrowserWindow.getAllWindows().length === 1);
    assert.equal(modalPopupRuntime.view.getVisible(), true);
    await host.webContents.executeJavaScript('window.renderModal(false)');
    await waitFor(() => BrowserWindow.getAllWindows().length === 2);
    overlay = BrowserWindow.getAllWindows().find(window => window !== host);
    await waitFor(async () => overlay.webContents.executeJavaScript('!!document.querySelector(".toollog")'));
    overlay.close();
    await waitFor(() => BrowserWindow.getAllWindows().length === 1);
    assert.equal(runtime.state().activeByWorkflow.smoke, second.pageId);
    assert.equal(await secondContents.executeJavaScript('document.querySelector("#draft").value'), '작성 중인 내용');
    await runtime.close(parent.pageId);
    await waitFor(() => secondContents.isDestroyed());
    assert.equal(runtime.list('smoke').length, 0);
    process.stdout.write(
      'browser popup tab smoke ok: exact fill, checkbox readback, unchanged step rejection, verified parent callback, native modal layering without hiding popup, transparent backdrop, modal close and Escape, settings selector, resize and host visibility, modal stacking, nested dialogs, hidden dialogs, popup restoration, single OS window, embedded view, opener, postMessage, close, session, sandbox, agent control, parent cleanup\n',
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
