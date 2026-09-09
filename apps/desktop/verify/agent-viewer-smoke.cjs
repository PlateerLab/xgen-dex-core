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
const traces = Array.from({length: 23}, (_, i) => ({trace_id: 'trace-' + i, model_name: 'model-' + i, provider: 'fixture', status: i === 1 ? 'failed' : i === 2 ? 'partial' : i === 3 ? 'running' : 'completed', error_message: i === 1 ? 'network unavailable' : undefined, total_spans: 3, total_tool_calls: 1, total_llm_calls: 1, created_at: '2026-09-09T00:00:00Z', duration_ms: 1200}));
const surface = {available: true, note: '', prompt: {full_prompt: 'full instructions', sections: [{key: 'role', title: '역할', text: 'role instructions'}]}, tools: [], skills: [], provision: {stages: [{key: 'main', groups: [{key: 'a', title: '파일', kind: 'tools', tools: [{name: 'read_file', description: 'Read a document'}, {name: 'search_files', description: 'Find a document'}]}, {key: 'b', title: '검색', kind: 'tools', tools: [{name: 'read_file', description: 'Duplicate'}, {name: 'web_search', description: 'Search the web'}]}]}]}};
window.fixture = { empty: false, slow: null, pending: {}, fail: false, copy: '', lists: [], details: [], detailFail: null, slowTrace: null, slowPage: null };

const detail = (wf, filename) => ({...files.find(f => f.filename === filename),
 body: '# Body ' + wf + ' / ' + filename + '\\n\\n' + ('A paragraph for scrolling.\\n\\n').repeat(100) + '\\n[[1.md|Linked note]]'});
window.xgen = {
 clipboard: {write: async text => {window.fixture.copy = text; return true;}},
 agentData: {
  memoryList: async () => {if(window.fixture.fail) throw Error('fixture load error'); return {files: window.fixture.empty ? [] : files};},
  memoryRead: (wf, filename) => window.fixture.slow === filename
   ? new Promise(resolve => {window.fixture.pending[filename] = () => resolve(detail(wf, filename));})
   : Promise.resolve(detail(wf, filename)),
  basicInfo: async () => ({model: 'fixture-model', provider: 'fixture-provider', errors: [], surfaces: {connector: surface}}),
  tasksList: async () => ({tasks: [], jobs: []}), toolsList: async () => ({tools: []}),
  workspaceTree: async () => ({files: []}),
  traceList: (wf, page = 1, pageSize = 50) => {
   window.fixture.lists.push({wf, page, pageSize});
   const result = {traces: traces.slice((page-1)*pageSize, page*pageSize), total: traces.length, page, page_size: pageSize};
   return window.fixture.slowPage === page ? new Promise(resolve => {window.fixture.pending['page'+page] = () => resolve(result);}) : Promise.resolve(result);
  },
  traceDetail: (id) => {
   window.fixture.details.push(id);
   const result = {trace: traces.find(t => t.trace_id === id), spans: [{span_order: 2, span_type: 'tool_call', tool_name: 'read_file', input_data: 'path'}, {span_order: 1, span_type: 'llm_call'}, {span_order: 3, span_type: 'error', error_message: 'step failed'}]};
   return window.fixture.detailFail === id ? Promise.reject(Error('fixture detail error')) : window.fixture.slowTrace === id ? new Promise(resolve => {window.fixture.pending[id] = () => resolve(result);}) : Promise.resolve(result);
  },
 }, artifacts: {list: async () => ({artifacts: []})}
};
import('./src/renderer/src/views/AgentViewer').then(({AgentViewer}) => {
 const nav = {a: createAgentViewerState(), b: createAgentViewerState()};
 function Fixture() {
  const [shown, show] = useState(true);
  const [wf, workflow] = useState('a');
  const [subs, setSubs] = useState({a: undefined, b: 'memory'});
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
  await waitFor(
    `document.querySelector('.overview-model h2')?.textContent === 'fixture-model' && document.querySelectorAll('.overview-execution').length === 5`,
    'overview default and recent summaries',
  );
  assert.equal(
    await run(`document.querySelector('[aria-label="연결된 도구 상세 보기"] strong').textContent`),
    '3',
    'deduplicate tools across groups',
  );
  assert.equal(
    await run(`document.querySelector('.overview-prompt-body') === null`),
    true,
    'prompt starts collapsed',
  );
  assert.equal(
    await run(`window.fixture.details.length`),
    0,
    'overview does not fetch execution details',
  );
  assert.deepEqual(await run(`window.fixture.lists[0]`), { wf: 'a', page: 1, pageSize: 5 });
  await clickTab('메모리');
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
  await clickTab('제작한 도구');
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
  // Phase 2: overview routing, unified tools, pagination, and lazy execution detail.
  await clickTab('개요');
  await waitFor(`document.querySelectorAll('.overview-execution').length === 5`, 'overview loads');
  await run(`document.querySelector('.overview-disclosure').click()`);
  await waitFor(`!!document.querySelector('.prompt-section')`, 'prompt disclosure');
  await run(`window.fixture.fail=true;document.querySelector('.inspector-toolbar button').click()`);
  await waitFor(
    `document.querySelector('[aria-label="메모리 상세 보기"] strong')?.textContent === '확인 불가'`,
    'overview partial failure',
  );
  assert.equal(
    await run(`document.querySelector('[aria-label="작업 상세 보기"] strong').textContent`),
    '0',
    'independent counts survive partial failure',
  );
  await run(
    `window.fixture.fail=false;document.querySelector('[aria-label="연결된 도구 상세 보기"]').click()`,
  );
  await waitFor(
    `document.querySelectorAll('.tools-list .viewer-listitem').length === 3`,
    'connected tools',
  );
  await run(`document.querySelectorAll('.tools-list .viewer-listitem')[2].click()`);
  await waitFor(
    `document.querySelector('.tools-document h2')?.textContent === 'web_search'`,
    'connected tool selection',
  );
  await clickTab('작업');
  await clickTab('도구');
  await waitFor(
    `document.querySelector('.tools-document h2')?.textContent === 'web_search'`,
    'connected tool state restoration',
  );
  await run(
    `{const input=document.querySelector('[aria-label="연결된 도구 검색"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'document');input.dispatchEvent(new Event('input',{bubbles:true}));}`,
  );
  await waitFor(
    `document.querySelectorAll('.tools-list .viewer-listitem').length === 2`,
    'search tool descriptions',
  );
  await clickTab('실행 기록');
  await waitFor(`document.querySelectorAll('.execution-card').length === 20`, 'first page');
  assert.equal(
    await run(`window.fixture.details.length`),
    0,
    'collapsed runs do not request details',
  );
  assert.deepEqual(await run(`window.fixture.lists.at(-1)`), { wf: 'a', page: 1, pageSize: 20 });
  const clickText = async (selector, text) =>
    run(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent === ${JSON.stringify(text)}).click()`,
    );
  await clickText('.execution-controls button', '실패·부분 실패');
  await waitFor(
    `document.querySelectorAll('.execution-card').length === 2`,
    'error filter excludes completed cards',
  );
  await run(
    `window.fixture.detailFail='trace-1';document.querySelector('[data-trace-id="trace-1"] .execution-head').click()`,
  );
  await waitFor(
    `document.body.innerText.includes('fixture detail error')`,
    'detail failure visible',
  );
  assert.equal(await run(`window.fixture.details.length`), 1, 'only selected detail requested');
  await run(
    `window.fixture.detailFail=null;document.querySelector('.execution-detail .viewer-btn').click()`,
  );
  await waitFor(`document.querySelectorAll('.viewer-span').length === 3`, 'detail retry');
  await run(`document.querySelectorAll('.execution-step-filters button')[4].click()`);
  await waitFor(`document.querySelectorAll('.viewer-span').length === 1`, 'span filter');
  assert.equal(
    await run(`document.querySelector('.viewer-idx').textContent`),
    '3',
    'filtered steps retain original positions',
  );
  await clickText('.execution-controls button', '전체');
  await clickText('.execution-pagination button', '다음 페이지');
  await waitFor(
    `document.querySelectorAll('.execution-card').length === 3 && document.body.innerText.includes('21–23개 / 전체 23개')`,
    'last page',
  );
  assert.deepEqual(await run(`window.fixture.lists.at(-1)`), { wf: 'a', page: 2, pageSize: 20 });
  assert.equal(
    await run(
      `[...document.querySelectorAll('.execution-pagination button')].find(el => el.textContent === '다음 페이지').disabled`,
    ),
    true,
  );
  await run(`document.getElementById('toggle').click()`);
  await waitFor(`!document.querySelector('.agent-viewer')`, 'log unmount');
  await run(`document.getElementById('toggle').click()`);
  await waitFor(`document.querySelectorAll('.execution-card').length === 3`, 'log page restored');
  // A late page response must not replace a newer page after leaving the view.
  await run(`window.fixture.slowPage=1`);
  await clickText('.execution-pagination button', '이전 페이지');
  await waitFor(`!!window.fixture.pending.page1`, 'delayed page request');
  await clickTab('개요');
  await run(`window.fixture.slowPage=null;window.fixture.pending.page1()`);
  await waitFor(
    `document.querySelectorAll('.overview-execution').length === 5`,
    'overview before direct run',
  );
  await run(`document.querySelector('.overview-execution').click()`);
  await waitFor(
    `document.querySelector('[data-trace-id="trace-0"] .execution-head')?.getAttribute('aria-expanded') === 'true' && document.querySelectorAll('.execution-card').length === 20`,
    'overview opens matching run on first page',
  );
  await waitFor(
    `document.activeElement === document.querySelector('[data-trace-id="trace-0"] .execution-head')`,
    'direct run receives focus',
  );
  win.setSize(600, 850);
  await waitFor(`innerWidth < 650`, 'narrow execution layout');
  assert.equal(
    await run(`document.documentElement.scrollWidth <= innerWidth`),
    true,
    'execution has no horizontal overflow',
  );
  await clickTab('도구');
  await waitFor(`!!document.querySelector('.tools-document h2')`, 'narrow connected tools');
  assert.equal(
    await run(
      `document.documentElement.scrollWidth <= innerWidth && document.querySelector('.tools-reader').clientHeight > 100`,
    ),
    true,
  );
  await clickTab('개요');
  await waitFor(`document.querySelectorAll('.overview-execution').length === 5`, 'narrow overview');
  assert.equal(await run(`document.documentElement.scrollWidth <= innerWidth`), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: selection/search/scroll restoration, agent isolation, late-response protection, filter reset, resizing, narrow layout, empty/error/retry states, overview routing and partial failure, connected tool search, lazy trace detail, pagination and step filters',
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
