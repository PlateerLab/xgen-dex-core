const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const dir = mkdtempSync(join(tmpdir(), 'dex-audio-settings-'));
app.setPath('userData', join(dir, 'profile'));
buildSync({ stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
window.saved = {}; window.failSave = false;
window.xgen = {
 config: { get: async () => window.saved, set: async patch => {
   if (window.failSave) throw new Error('저장 실패 테스트');
   Object.assign(window.saved, patch);
 } },
 audioProcessor: { status: async () => ({available: true, error: ''}) },
 voice: { getConfig: async () => ({stt: {enabled:true, provider:'XGEN', language:'ko'}, tts: {enabled:false}}) }
};
import('./src/renderer/src/views/VoiceSettings').then(({VoiceSettings}) => {
 createRoot(document.getElementById('root')).render(<VoiceSettings onClose={() => {}} />);
});`, resolveDir: resolve(__dirname, '..'), loader: 'tsx' }, bundle: true, platform: 'browser', outfile: join(dir, 'ui.js'), tsconfig: resolve(__dirname, '../tsconfig.json') });
writeFileSync(join(dir, 'index.html'), `<html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${resolve(__dirname, '../src/renderer/src/styles.css')}"></head><body><div id="root"></div><script src="ui.js"></script></body></html>`);
async function main() {
 await app.whenReady();
 const win = new BrowserWindow({ width: 1100, height: 900, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
 await win.loadFile(join(dir, 'index.html'));
 const run = code => win.webContents.executeJavaScript(code);
 for (let i=0; i<100; i++) {
   if (await run(`!!document.querySelector('[aria-labelledby="voice-noise-label"]:not(:disabled)')`)) break;
   await new Promise(r=>setTimeout(r,50));
 }
 const state = () => run(`Array.from(document.querySelectorAll('[aria-labelledby^="voice-"]')).map(e=>e.checked)`);
 assert.deepEqual(await state(), [false,false]);
 await run(`document.querySelector('[aria-labelledby="voice-noise-label"]').click()`);
 await new Promise(r=>setTimeout(r,100)); assert.deepEqual(await state(), [true,false]);
 await run(`document.querySelector('[aria-labelledby="voice-vad-label"]').click()`);
 await new Promise(r=>setTimeout(r,100)); assert.deepEqual(await state(), [true,true]);
 await run(`document.querySelector('[aria-labelledby="voice-noise-label"]').click()`);
 await new Promise(r=>setTimeout(r,100)); assert.deepEqual(await state(), [false,true]);
 await run(`window.failSave=true; document.querySelector('[aria-labelledby="voice-vad-label"]').click()`);
 await new Promise(r=>setTimeout(r,100)); assert.deepEqual(await state(), [false,true]);
 assert.match(await run(`document.querySelector('[role="alert"]').textContent`), /저장 실패/);
 await new Promise(r=>setTimeout(r,500));
 writeFileSync('/tmp/dex-audio-integration/settings.png', (await win.webContents.capturePage()).toPNG());
 console.log('settings: four toggle states, mocked save responses and failed-save UI state passed');
 win.destroy();
}
main().then(()=>app.exit(0)).catch(e=>{console.error(e);app.exit(1)});
