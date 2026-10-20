// Real handsfree hook + simulated microphone + actual Python. Optional real Core file STT.
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { buildSync } = require('esbuild');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { AudioProcessor, audioRuntime } = require('../src/main/audio-preprocessor.ts');
const dir = mkdtempSync(join(tmpdir(), 'dex-handsfree-'));
const real = process.env.DEX_AUDIO_REAL_STT === '1';
app.setPath(
  'userData',
  real
    ? join(
        app.getPath('appData'),
        process.env.DEX_PROFILE ? `XGEN-Connector-${process.env.DEX_PROFILE}` : 'XGEN-Connector',
      )
    : join(dir, 'profile'),
);
const root =
  process.env.DEX_AUDIO_ROOT || resolve(__dirname, '../../../../xgen-audio-preprecessing');
let processor,
  uploads = [],
  submits = [],
  starts = 0,
  ended = 0,
  failStt = false,
  deferStt = false,
  releaseStt,
  config,
  token;
ipcMain.handle('hf-start', async (_e, settings) => {
  processor?.cancel();
  processor = new AudioProcessor(
    settings,
    audioRuntime(resolve(__dirname, '..'), process.resourcesPath),
  );
  await processor.open();
  return { id: 'test', ...settings };
});
ipcMain.handle('hf-push', async (_e, pcm) => {
  const result = await processor.push(pcm);
  starts += result.events.filter((e) => e.type === 'speech_start').length;
  ended += result.events.filter((e) => e.type === 'speech_end').length;
  return result;
});
ipcMain.on('hf-cancel', () => processor?.cancel());
ipcMain.handle('hf-stt', async (_e, bytes) => {
  const wav = Buffer.from(bytes);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  uploads.push(wav.length);
  if (failStt) throw new Error('test file STT failure');
  if (deferStt)
    await new Promise((resolve) => {
      releaseStt = resolve;
    });
  if (!real) return '안녕하세요. 오늘 날씨가 정말 좋네요.';
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'handsfree.wav');
  form.append('language', 'ko');
  const res = await fetch(config.serverUrl.replace(/\/$/, '') + '/api/audio/stt/transcribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.ok(result.text?.trim());
  return result.text;
});
ipcMain.handle('hf-submit', (_e, text) => {
  submits.push(text);
});
writeFileSync(
  join(dir, 'preload.cjs'),
  `const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('hfBridge',{
 start:s=>ipcRenderer.invoke('hf-start',s),push:p=>ipcRenderer.invoke('hf-push',p),
 cancel:()=>ipcRenderer.send('hf-cancel'),transcribe:b=>ipcRenderer.invoke('hf-stt',b),submit:t=>ipcRenderer.invoke('hf-submit',t)
});`,
);
buildSync({
  stdin: {
    contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
let callback;let clock=1000;let pushes=0;Date.now=()=>clock;
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
window.AudioContext=class {
 destination={};createMediaStreamSource(){return {connect(){},disconnect(){}};}
 createScriptProcessor(){return {set onaudioprocess(fn){callback=fn;},connect(){},disconnect(){}};}
 close(){return Promise.resolve();}
};
window.settings={noise:false,vad:false};window.wsStarts=0;
window.xgen={config:{onChange:()=>()=>{}},
 voiceStream:{available:async()=>false,start:()=>{window.wsStarts++;throw new Error('file path opened WebSocket');}},
 audioProcessor:{start:()=>window.hfBridge.start(window.settings),push:async(_id,pcm)=>{try{return await window.hfBridge.push(pcm);}finally{pushes++;}},cancel:()=>window.hfBridge.cancel()},
 voice:{transcribe:async blob=>window.hfBridge.transcribe(new Uint8Array(await blob.arrayBuffer()))},
 quickChat:{submit:text=>window.hfBridge.submit(text)}
};
import('./src/renderer/src/overlay/handsfree').then(({useHandsfree})=>{
 const root=createRoot(document.getElementById('root'));
 function Harness({enabled}){window.hfState=useHandsfree(enabled,'fixture');return null;}
 window.enable=enabled=>flushSync(()=>root.render(<Harness enabled={enabled}/>));
 window.feed=async samples=>{
  const previous=pushes;clock+=samples.length/16;
  callback({inputBuffer:{getChannelData:()=>Float32Array.from(samples)}});
  let tries=0;while(pushes===previous){if(++tries>10000)throw new Error('microphone callback did not reach processor');await new Promise(r=>setTimeout(r,1));}
  await new Promise(r=>setTimeout(r,0));
 };
 window.enable(false);window.testReady=true;
});`,
    resolveDir: resolve(__dirname, '..'),
    loader: 'tsx',
  },
  bundle: true,
  platform: 'browser',
  outfile: join(dir, 'ui.js'),
  tsconfig: resolve(__dirname, '../tsconfig.json'),
});
writeFileSync(
  join(dir, 'index.html'),
  '<html><body><div id="root"></div><script src="ui.js"></script></body></html>',
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await app.whenReady();
  if (real) {
    config = JSON.parse(readFileSync(join(app.getPath('userData'), 'connector.json'), 'utf8'));
    token = await require('../src/main/keychain.ts').tokenStore.getAccess();
    assert.ok(token, 'Existing DEX login required');
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(dir, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') console.error(event.message);
  });
  await win.loadFile(join(dir, 'index.html'));
  const run = (code) => win.webContents.executeJavaScript(code);
  async function until(predicate) {
    const deadline = performance.now() + 65000;
    while (!(await predicate())) {
      if (performance.now() > deadline) throw new Error('handsfree smoke timeout');
      await sleep(10);
    }
  }
  await until(() => run('window.testReady===true'));
  console.log('harness ready');
  const wav = readFileSync(process.env.DEX_AUDIO_FIXTURE || join(root, 'tests/fixtures/speech.wav'));
  let speech;
  for (let p = 12; p + 8 <= wav.length;) {
    const n = wav.readUInt32LE(p + 4);
    if (wav.toString('ascii', p, p + 4) === 'data') {
      speech = wav.subarray(p + 8, p + 8 + n);
      break;
    }
    p += 8 + n + (n % 2);
  }
  assert.ok(speech);
  // The original quiet sample rarely exceeds the legacy 0.015 RMS threshold.
  const quietSpeech = speech;
  speech = Buffer.alloc(quietSpeech.length);
  for (let i = 0; i < speech.length; i += 2) {
    const v = quietSpeech.readInt16LE(i) * 4;
    assert.ok(v >= -32768 && v <= 32767);
    speech.writeInt16LE(v, i);
  }
  async function feed(pcm) {
    for (let p = 0; p < pcm.length; p += 2048) {
      const part = pcm.subarray(p, p + 2048),
        samples = [];
      for (let i = 0; i < part.length; i += 2) samples.push(part.readInt16LE(i) / 32768);
      await run('window.feed(' + JSON.stringify(samples) + ')');
    }
  }
  for (const noise of [false, true])
    for (const vad of [false, true]) {
      uploads = [];
      submits = [];
      starts = ended = 0;
      await run('window.settings=' + JSON.stringify({ noise, vad }) + ';window.enable(true)');
      await until(() => run('window.hfState.state==="armed"'));
      console.log('capture armed');
      await feed(Buffer.alloc(32000));
      assert.equal(uploads.length, 0, 'silence must not upload');
      if (!noise && !vad) {
        await feed(Buffer.concat([quietSpeech, Buffer.alloc(32000)]));
        assert.equal(uploads.length, 0, 'legacy RMS ignores this quiet fixture');
      }
      await feed(Buffer.concat([speech, Buffer.alloc(64000)]));
      console.log('speech fed', await run('window.hfState'), uploads.length);
      await until(() => Promise.resolve(submits.length === 1));
      assert.equal(uploads.length, 1);
      assert.equal(await run('window.wsStarts'), 0);
      assert.equal(vad ? starts > 0 && ended > 0 : starts === 0 && ended === 0, true);
      if (real) assert.match(submits[0], /안녕하세요.*오늘 날씨가 정말 좋네요/);
      console.log(
        JSON.stringify({
          stt: real ? 'core-file' : 'mock',
          noise,
          vad,
          uploads: uploads.length,
          vadStarts: starts,
          vadEnds: ended,
          text: submits[0],
        }),
      );
      await run('window.enable(false)');
      await sleep(20);
    }
  if (!real) {
    // Cancelling an unfinished utterance must not upload it.
    uploads = [];
    submits = [];
    await run('window.settings={noise:false,vad:false};window.enable(true)');
    await until(() => run('window.hfState.state==="armed"'));
    await feed(speech.subarray(0, 16000));
    assert.equal(await run('window.hfState.state'), 'hearing');
    await run('window.enable(false)');
    assert.equal(uploads.length, 0);
    assert.equal(submits.length, 0);
    // A file STT response arriving after disable must not reach chat.
    deferStt = true;
    await run('window.enable(true)');
    await until(() => run('window.hfState.state==="armed"'));
    await feed(Buffer.concat([speech, Buffer.alloc(64000)]));
    await until(() => Promise.resolve(!!releaseStt));
    assert.equal(await run('window.hfState.state'), 'thinking');
    await run('window.enable(false)');
    releaseStt();
    await sleep(50);
    assert.equal(submits.length, 0);
    deferStt = false;
    // Continuous loud input is split at the retained 30-second limit.
    uploads = [];
    submits = [];
    await run('window.enable(true)');
    await until(() => run('window.hfState.state==="armed"'));
    const longPcm = Buffer.alloc(32000 * 31);
    for (let i = 0; i < longPcm.length; i += 2) longPcm.writeInt16LE(3277, i);
    await feed(longPcm);
    await until(() => Promise.resolve(submits.length === 1));
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0] <= 44 + 32000 * 31.3);
    await run('window.enable(false)');
    console.log('cancel, late STT suppression and 30-second file limit passed');
    failStt = true;
    uploads = [];
    submits = [];
    await run('window.settings={noise:false,vad:false};window.enable(true)');
    await until(() => run('window.hfState.state==="armed"'));
    console.log('capture armed');
    await feed(Buffer.concat([speech, Buffer.alloc(64000)]));
    console.log('speech fed', await run('window.hfState'), uploads.length);
    await until(() => run('!!window.hfState.error'));
    assert.equal(submits.length, 0);
    assert.equal(await run('window.hfState.state'), 'armed');
    await run('window.enable(false)');
    console.log('file STT failure: no chat sent, error shown, listening resumed');
  }
  win.destroy();
  processor?.cancel();
}
main()
  .then(() => app.exit(0))
  .catch((e) => {
    processor?.cancel();
    console.error(e.message);
    app.exit(1);
  });
