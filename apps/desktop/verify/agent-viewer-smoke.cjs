/** Chromium regression checks. Run: electron verify/agent-viewer-smoke.cjs
 * Isolated hidden window with fixtures; never connects to a user account.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { app, BrowserWindow } = require('electron');
const desktop = path.resolve(__dirname, '..');
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentViewerState } from './src/renderer/src/views/agent-viewer-state';
const files = Array.from({length: 40}, (_, i) => ({filename: i + '.md', title: 'Note ' + i,
 category: i % 2 ? 'conversations' : 'daily', tags: ['sample'], first_paragraph: 'Preview ' + i,
 modified: new Date(Date.UTC(2026, 8, 9) - i * 86400000).toISOString()}));
window.fixture = { empty: false, slow: null, pending: {}, fail: false, copy: '' };
const detail = (wf, filename) => ({...files.find(f => f.filename === filename),
 body: '# Body ' + wf + ' / ' + filename + '\\n\\n' + ('A paragraph for scrolling.\\n\\n').repeat(100) + '\\n[[1.md|Linked note]]'});
window.xgen = {
 clipboard: {write: async text => {window.fixture.copy = text; return true;}},
 agentData: {
  memoryList: async () => {if(window.fixture.fail) throw Error('fixture load error'); return {files: window.fixture.empty ? [] : files};},
  memoryRead: (wf, filename) => window.fixture.slow === filename
   ? new Promise(resolve => {window.fixture.pending[filename] = () => resolve(detail(wf, filename));})
   : Promise.resolve(detail(wf, filename)),
  tasksList: async () => ({tasks: [], jobs: []}), toolsList: async () => ({tools: []}),
  workspaceTree: async () => ({files: []}), traceList: async () => ({traces: []}),
 }, artifacts: {list: async () => ({artifacts: []})}
};
import('./src/renderer/src/views/AgentViewer').then(({AgentViewer}) => {
 const nav = {a: createAgentViewerState(), b: createAgentViewerState()};
 function Fixture() {
  const [shown, show] = useState(true);
  const [wf, workflow] = useState('a');
  const [subs, setSubs] = useState({a: 'memory', b: 'memory'});
  return <><div style={{height: 30}}><button id="toggle" onClick={() => show(v => !v)}>Toggle viewer</button>
   <button id="workflow" onClick={() => workflow(v => v === 'a' ? 'b' : 'a')}>Switch agent</button></div>
   <div style={{height: 'calc(100vh - 30px)'}}>{shown && <AgentViewer key={wf} workflowId={wf} workflowName={'Agent ' + wf}
    navigation={nav[wf]} initialSub={subs[wf]} onSubChange={sub => setSubs(v => ({...v, [wf]: sub}))}/>}</div></>;
 }
 createRoot(document.getElementById('root')).render(<Fixture/>);
});
`;
let win;
let tmp;
async function main() {
  await app.whenReady();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xgen-viewer-smoke-'));
  const bundled = buildSync({
    stdin: { contents: fixture, resolveDir: desktop, sourcefile: 'fixture.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    tsconfig: path.join(desktop, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(tmp, 'fixture.js'), bundled.outputFiles[0].text);
  fs.writeFileSync(
    path.join(tmp, 'index.html'),
    `<!doctype html><html data-theme="dark"><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(desktop, 'src/renderer/src/styles.css'))}"><style>body{margin:0;display:block}#root{height:100vh;width:100vw}</style><div id="root"></div><script src="fixture.js"></script></html>`,
  );
  win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  await win.loadFile(path.join(tmp, 'index.html'));
  const run = (script) => win.webContents.executeJavaScript(script);
  const waitFor = async (script, label) => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (await run(script)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(
      'Timed out: ' +
        label +
        '\n' +
        (await run(
          'JSON.stringify({text: document.body.innerText.slice(0,500), list: document.querySelector(".memory-list")?.scrollTop, detail: document.querySelector(".memory-reader")?.scrollTop})',
        )) +
        '\n' +
        errors.join('\n'),
    );
  };
  const clickTab = async (label) => {
    await run(
      `[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent === ${JSON.stringify(label)}).click()`,
    );
  };
  const type = async (text) => {
    await run(
      `{const input=document.querySelector('[aria-label="메모리 검색"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));}`,
    );
  };
  const clickNote = async (index) => {
    await run(
      `[...document.querySelectorAll('.memory-item')].find(el => el.querySelector('.memory-item-heading').textContent === 'Note ${index}').click()`,
    );
  };
  const selected = (index) =>
    `document.querySelector('.memory-document h1')?.textContent === 'Note ${index}'`;
  await waitFor(selected(0), 'auto-select newest');
  await type('Note');
  await clickNote(10);
  await waitFor(selected(10), 'select note 10');
  await run(
    `document.querySelector('.memory-list').scrollTop=500;document.querySelector('.memory-reader').scrollTop=400;`,
  );
  await waitFor(`document.querySelector('.memory-reader').scrollTop === 400`, 'scroll');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await clickTab('작업');
  await waitFor(`document.body.innerText.includes('아직 등록된 작업이 없습니다')`, 'tasks empty');
  assert.equal(await run(`document.body.innerText.includes('왼쪽에서 작업')`), false);
  await clickTab('메모리');
  await waitFor(selected(10), 'restore selection across subtabs');
  assert.equal(await run(`document.querySelector('[aria-label="메모리 검색"]').value`), 'Note');
  await waitFor(
    `document.querySelector('.memory-list').scrollTop === 500 && document.querySelector('.memory-reader').scrollTop === 400`,
    'restore both scroll positions',
  );
  await run(`document.getElementById('toggle').click()`);
  await waitFor(`!document.querySelector('.agent-viewer')`, 'unmount viewer');
  await run(`document.getElementById('toggle').click()`);
  await waitFor(selected(10), 'restore after outer unmount');
  await run(`document.getElementById('workflow').click()`);
  await waitFor(
    `document.querySelector('.viewer-title')?.textContent === 'Agent b' && ${selected(0)}`,
    'agent isolation',
  );
  assert.equal(await run(`document.querySelector('[aria-label="메모리 검색"]').value`), '');
  await run(`document.getElementById('workflow').click()`);
  await waitFor(selected(10), 'restore first agent');
  await run(`window.fixture.slow='11.md'`);
  await clickNote(11);
  await waitFor(`!!window.fixture.pending['11.md']`, 'slow request');
  await clickNote(12);
  await waitFor(selected(12), 'fast request');
  await run(`window.fixture.pending['11.md']();window.fixture.slow=null;`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await run(selected(12)), true, 'late response must not replace selection');
  await type('no such note');
  await waitFor(`document.body.innerText.includes('검색 결과가 없습니다')`, 'no results');
  await run(`document.querySelector('.memory-reset').click()`);
  await waitFor(selected(0), 'clear filters');
  await run(
    `document.querySelector('.memory-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`,
  );
  assert.equal(
    await run(`document.querySelector('.memory-resize').getAttribute('aria-valuenow')`),
    '360',
  );
  await clickTab('도구');
  await waitFor(`document.body.innerText.includes('아직 제작된 도구가 없습니다')`, 'tools empty');
  assert.equal(await run(`document.body.innerText.includes('왼쪽에서 도구')`), false);
  await clickTab('메모리');
  await waitFor(selected(0), 'responsive preparation');
  win.setSize(600, 850);
  await waitFor(
    `getComputedStyle(document.querySelector('.memory-resize')).display === 'none'`,
    'narrow layout',
  );
  assert.equal(
    await run(`document.documentElement.scrollWidth <= innerWidth`),
    true,
    'no window horizontal overflow',
  );
  assert.equal(
    await run(
      `document.querySelector('.memory-reader').clientHeight > 100 && document.querySelector('.memory-list').clientHeight > 0`,
    ),
    true,
  );
  win.setSize(1200, 900);
  await run(
    `window.fixture.empty=true;document.querySelector('[aria-label="메모리 새로고침"]').click()`,
  );
  await waitFor(
    `document.body.innerText.includes('아직 저장된 메모리가 없습니다')`,
    'empty memory',
  );
  assert.equal(await run(`document.querySelector('.memory-split') === null`), true);
  await run(`window.fixture.fail=true;document.querySelector('.viewer-empty button').click()`);
  await waitFor(
    `document.body.innerText.includes('메모리를 불러오지 못했습니다')`,
    'error separate from empty',
  );
  await run(
    `window.fixture.fail=false;window.fixture.empty=false;document.querySelector('.viewer-empty button').click()`,
  );
  await waitFor(selected(0), 'retry recovers');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: selection/search/scroll restoration, agent isolation, late-response protection, filter reset, resizing, narrow layout, empty/error/retry states',
  );
}
main()
  .then(() => {
    win?.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    win?.destroy();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(1);
  });
