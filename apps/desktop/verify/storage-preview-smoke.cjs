/** 에이전트 [스토리지] — IDE 탐색기 모양의 목록과 [파일 저장소] 와 같은 뷰어가 문서·md·표·그림을 그리는가.
 * Run: electron verify/storage-preview-smoke.cjs [스크린샷 폴더]
 * 숨은 창에서 가짜 자료로만 돈다 — 계정에 붙지 않는다.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { app, BrowserWindow } = require('electron');

const desktop = path.resolve(__dirname, '..');
const shots = process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('.cjs')) || '';
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentViewerState } from './src/renderer/src/views/agent-viewer-state';
const enc = (t) => new TextEncoder().encode(t);
const page = (n) => '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560"><rect width="800" height="560" fill="#fff"/>'
  + '<rect x="40" y="40" width="720" height="80" fill="#4354eb"/><text x="60" y="95" font-size="36" fill="#fff">통합분석 리포트 ' + n + '쪽</text>'
  + '<text x="60" y="200" font-size="22" fill="#222">문서가 서버 렌더 페이지로 보인다</text></svg>';
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const files = [
  {name: 'uploads', path: 'uploads', is_dir: true},
  {name: 'users_130', path: 'uploads/users_130', is_dir: true},
  {name: 'photo.png', path: 'uploads/users_130/photo.png', is_dir: false, size: png.length},
  {name: '3개_연구문서_통합분석_리포트.docx', path: '3개_연구문서_통합분석_리포트.docx', is_dir: false, size: 45666, modified_at: '2026-10-02T02:34:52Z'},
  {name: '3개_연구문서_통합분석_리포트.md', path: '3개_연구문서_통합분석_리포트.md', is_dir: false, size: 17674},
  {name: 'scores.csv', path: 'scores.csv', is_dir: false, size: 40},
];
const bodies = {
  '3개_연구문서_통합분석_리포트.md': '# 통합분석 리포트\\n\\n세 문서를 비교했다.\\n\\n| 항목 | 값 |\\n|---|---|\\n| 문서 | 3 |\\n',
  'scores.csv': 'name,score\\nkim,90\\nlee,85\\n',
};
window.calls = [];
window.xgen = {
  clipboard: {write: async () => true},
  agentData: {
    workspaceTree: async () => ({workflow_id: 'wf', files}),
    workspaceBinary: async (wf, p) => { window.calls.push('raw:' + p); return {bytes: p.endsWith('.png') ? png : enc(bodies[p] ?? ''), contentType: ''}; },
    workspaceDocPreview: async (wf, p) => { window.calls.push('doc:' + p); return {kind: 'svg', count: 2, pages: ['.canvas-preview/k/1/slide_001.svg', '.canvas-preview/k/1/slide_002.svg']}; },
    workspacePreviewPage: async (wf, p) => ({bytes: enc(page(p.endsWith('1.svg') ? 1 : 2)), contentType: 'application/octet-stream'}),
    basicInfo: async () => ({errors: [], surfaces: {}}), memoryList: async () => ({files: []}), tasksList: async () => ({tasks: [], jobs: []}),
    toolsList: async () => ({tools: []}), traceList: async () => ({traces: [], total: 0, page: 1, page_size: 50}),
  },
  apps: {list: async () => ({apps: []})},
};
import('./src/renderer/src/views/AgentViewer').then(({AgentViewer}) => {
  createRoot(document.getElementById('root')).render(
    <AgentViewer workflowId="wf" workflowName="카톡분석" navigation={createAgentViewerState()} initialSub="storage" />,
  );
});
`;

let win;
async function main() {
  await app.whenReady();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xgen-storage-smoke-'));
  const bundled = buildSync({
    stdin: { contents: fixture, resolveDir: desktop, sourcefile: 'fixture.tsx', loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    tsconfig: path.join(desktop, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    // IDE 묶음은 Monaco 의 CSS·글꼴을 import 한다 — 앱 번들러가 처리하는 몫이라 여기서는 비운다(그리는 것은 ide.css).
    loader: { '.css': 'empty', '.ttf': 'empty' },
    external: ['node:*'],
    // packages/ide 는 루트 워크스페이스의 react 를 찾는다 — 앱 번들러(dedupe)처럼 이 앱의 react 하나로 묶는다.
    alias: { react: path.dirname(require.resolve('react/package.json', { paths: [desktop] })), 'react-dom': path.dirname(require.resolve('react-dom/package.json', { paths: [desktop] })) },
    logLevel: 'silent',
  });
  fs.writeFileSync(path.join(tmp, 'fixture.js'), bundled.outputFiles[0].text);
  const css = (p) => `<link rel="stylesheet" href="${pathToFileURL(p)}">`;
  fs.writeFileSync(
    path.join(tmp, 'index.html'),
    `<!doctype html><html data-theme="dark"><meta charset="utf-8">${css(path.join(desktop, 'src/renderer/src/styles.css'))}${css(
      path.join(desktop, '../../packages/ide/src/ide.css'),
    )}<style>body{margin:0;display:block}#root{height:100vh;width:100vw;display:flex;flex-direction:column}</style><div id="root"></div><script src="fixture.js"></script></html>`,
  );
  win = new BrowserWindow({ show: false, width: 1280, height: 760, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  await win.loadFile(path.join(tmp, 'index.html'));
  const run = (script) => win.webContents.executeJavaScript(script);
  const waitFor = async (script, label) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await run(script)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw Error(`Timed out: ${label}\n${await run('document.body.innerText.slice(0, 600)')}\n${errors.join('\n')}`);
  };
  const shot = async (name) => {
    if (!shots) return;
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shots, `${name}.png`), img.toPNG());
  };
  const open = (p) =>
    run(`[...document.querySelectorAll('.xide-tree-row')].find((el) => el.dataset.path === ${JSON.stringify(p)}).click()`);

  // 목록 — IDE 탐색기와 같은 마크업(머리·구역 이름·줄·배지)
  await waitFor(`document.querySelectorAll('.xide-filetree .xide-tree-row').length >= 4`, 'IDE 모양 목록');
  assert.equal(await run(`document.querySelector('.xide-filetree .xide-section-title').textContent`), '카톡분석');
  assert.equal(await run(`document.querySelector('.xide-filetree .xide-side-title').textContent`), '탐색기');
  assert.ok(await run(`!!document.querySelector('.xide-filetree .xide-file-badge')`), '확장자 배지');
  assert.ok(await run(`!!document.querySelector('.xide-tree-row[data-path="uploads/users_130"]')`), '첫 단계는 펼쳐 둔다');
  await shot('storage-list');

  // 문서 — 서버 렌더 페이지(예전: "파일 저장소에서만 지원")
  await open('3개_연구문서_통합분석_리포트.docx');
  await waitFor(`document.querySelectorAll('.fv-office-page').length === 2`, 'docx 페이지 두 장');
  assert.ok(await run(`[...document.querySelectorAll('.fv-office-page')].every(img => img.complete && img.naturalWidth > 0)`), '페이지 그림이 그려진다(형식 표시가 없어도 svg)');
  assert.ok(await run(`window.calls.includes('doc:3개_연구문서_통합분석_리포트.docx')`));
  assert.ok(await run(`!document.body.innerText.includes('파일 저장소] 파일에서')`), '옛 안내가 없다');
  await shot('storage-docx');

  // md — 그려서
  await open('3개_연구문서_통합분석_리포트.md');
  await waitFor(`!!document.querySelector('.fv-md table') && document.querySelector('.fv-md').textContent.includes('통합분석 리포트') && !document.querySelector('.fv-md').textContent.includes('# 통합')`, 'md 렌더(제목·표)');
  await shot('storage-md');

  // csv — 표로
  await open('scores.csv');
  await waitFor(`document.querySelectorAll('.fv-csv tbody tr').length === 2`, 'csv 표');

  // 그림 — 접힌 폴더를 펼쳐서
  await open('uploads/users_130');
  await waitFor(`[...document.querySelectorAll('.xide-tree-row')].some((el) => el.dataset.path === 'uploads/users_130/photo.png')`, '폴더 펼침');
  await open('uploads/users_130/photo.png');
  await waitFor(`!!document.querySelector('.fv-image') && document.querySelector('.fv-image').naturalWidth > 0`, '그림');
  assert.equal(errors.filter((e) => !/Download the React DevTools/.test(e)).length, 0, errors.join('\n'));
  console.log('storage preview smoke passed');
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
