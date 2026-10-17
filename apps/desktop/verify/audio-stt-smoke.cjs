// Opt-in: sends the specified public test recording to the configured XGEN server.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { app } = require('electron');
if (process.env.DEX_AUDIO_REAL_STT !== '1') throw new Error('Set DEX_AUDIO_REAL_STT=1');
const profile = process.env.DEX_PROFILE;
app.setPath('userData', join(app.getPath('appData'), profile ? `XGEN-Connector-${profile}` : 'XGEN-Connector'));
const { AudioProcessor, audioRuntime } = require('../src/main/audio-preprocessor.ts');
const { VoiceStreamHub } = require('../src/main/voice-stream.ts');
const { tokenStore } = require('../src/main/keychain.ts');
const { pcmWav } = require('../src/renderer/src/voice/processed-capture.ts');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  await app.whenReady();
  const config = JSON.parse(readFileSync(join(app.getPath('userData'), 'connector.json'), 'utf8'));
  const token = await tokenStore.getAccess();
  assert.ok(token, 'Existing DEX login required');
  const root = process.env.DEX_AUDIO_ROOT || resolve(__dirname, '../../../../xgen-audio-preprecessing');
  const wav = readFileSync(process.env.DEX_AUDIO_FIXTURE || join(root, 'tests/fixtures/speech.wav'));
  let pcm;
  for (let p = 12; p + 8 <= wav.length;) {
    const n = wav.readUInt32LE(p + 4);
    if (wav.toString('ascii', p, p + 4) === 'data') { pcm = wav.subarray(p + 8, p + 8 + n); break; }
    p += 8 + n + (n % 2);
  }
  assert.ok(pcm);
  pcm = Buffer.concat([pcm, Buffer.alloc(48000)]);
  const runtime = audioRuntime(resolve(__dirname, '..'), process.resourcesPath);
  const hub = new VoiceStreamHub(() => ({ baseUrl: () => config.serverUrl, token: async () => token,
    allowPrivateCertificate: () => config.allowPrivateCertificate === true, wakeWords: () => null, planBeforeAct: () => true }));
  const report = { server: config.serverUrl, results: [] };
  for (const noise of [false, true]) for (const vad of [false, true]) {
    const p = new AudioProcessor({ noise, vad }, runtime);
    const events = []; const processed = []; let starts = 0;
    const id = await hub.start('audio-stt-smoke', e => events.push(e), '', true);
    try {
      await p.open();
      for (let i = 0; i < pcm.length; i += 2048) {
        const chunk = await p.push(pcm.subarray(i, i + 2048));
        starts += chunk.events.filter(e => e.type === 'speech_start').length;
        processed.push(chunk.pcm); hub.audio(id, chunk.pcm);
        await sleep(64);
      }
      const tail = await p.finish(); processed.push(tail.pcm); hub.audio(id, tail.pcm);
      const result = await hub.end(id);
      const errors = events.filter(e => e.type === 'error').map(e => e.error);
      assert.deepEqual(errors, []);
      assert.ok(result?.text?.trim(), 'WebSocket STT returned no text');
      if (!process.env.DEX_AUDIO_FIXTURE) assert.match(result.text, /안녕하세요.*오늘 날씨가 정말 좋네요/, 'first greeting preserved');
      const form = new FormData(); form.append('file', pcmWav(processed), 'audio-smoke.wav'); form.append('language', 'ko');
      const response = await fetch(config.serverUrl.replace(/\/$/, '') + '/api/audio/stt/transcribe', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(response.status, 200, 'File STT status');
      const fileResult = await response.json();
      assert.ok(fileResult.text?.trim(), 'File STT returned no text');
      const row = { noise, vad, starts, streamText: result.text, fileResult,
        timeline: result.timeline, serverFinal: events.some(e => e.type === 'utterance_end') };
      report.results.push(row); console.log(JSON.stringify(row));
    } finally { p.cancel(); hub.cancel(id); }
  }
  const reportPath = process.env.DEX_AUDIO_REPORT || '/tmp/dex-audio-integration/real-stt.json';
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}
main().then(() => app.exit(0)).catch(e => { console.error(e.message); app.exit(1); });
