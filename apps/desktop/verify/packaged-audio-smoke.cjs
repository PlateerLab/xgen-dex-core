// Opt-in: test the packaged app's real preload/main IPC with a public PCM fixture.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync, cpSync, mkdirSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { _electron } = require('playwright-core');

async function main() {
  assert.equal(process.env.DEX_AUDIO_REAL_STT, '1', 'Set DEX_AUDIO_REAL_STT=1 to send the public fixture');
  assert.ok(process.env.DEX_PACKAGED_APP, 'Set DEX_PACKAGED_APP to the .app path');
  assert.ok(process.env.DEX_AUDIO_FIXTURE, 'Set DEX_AUDIO_FIXTURE to a 16kHz mono PCM16 WAV');
  const appPath = resolve(process.env.DEX_PACKAGED_APP);
  const resources = join(appPath, 'Contents/Resources');
  if (!process.env.DEX_AUDIO_INSTALLED_RUNTIME) {
    assert.ok(existsSync(join(resources, 'audio-preprocessing/licenses/audio/RNNoise-COPYING.txt')));
    assert.ok(existsSync(join(resources, 'audio-preprocessing/THIRD_PARTY_NOTICES.txt')));
  }
  const original = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/XGEN-Connector/connector.json'), 'utf8'));
  const profile = mkdtempSync(join(tmpdir(), 'dex-packaged-audio-'));
  if (process.env.DEX_AUDIO_INSTALLED_RUNTIME) {
    // Seed only a runtime produced by the installer test; the OS keychain is not copied.
    const base = join(profile, 'audio-runtimes'); mkdirSync(base);
    cpSync(process.env.DEX_AUDIO_INSTALLED_RUNTIME, join(base, '0.1.1'), {recursive: true, dereference: false});
    writeFileSync(join(base, 'current.json'), JSON.stringify({version:'0.1.1'}));
  }
  // No credentials are copied. The app uses its existing OS keychain service.
  writeFileSync(join(profile, 'connector.json'), JSON.stringify({
    serverUrl: original.serverUrl, allowPrivateCertificate: original.allowPrivateCertificate === true,
    autoUpdate: false, autoLogin: false, dataRoot: join(profile, 'data'),
    avatarOverlay: false, quickChat: false, fastAct: true, voiceWake: false, voiceOutput: false,
  }));
  const wav = readFileSync(process.env.DEX_AUDIO_FIXTURE);
  let pcm;
  for (let i = 12; i + 8 <= wav.length;) {
    const size = wav.readUInt32LE(i + 4);
    if (wav.toString('ascii', i, i + 4) === 'fmt ') {
      assert.equal(wav.readUInt16LE(i + 8), 1); assert.equal(wav.readUInt16LE(i + 10), 1);
      assert.equal(wav.readUInt32LE(i + 12), 16000); assert.equal(wav.readUInt16LE(i + 22), 16);
    }
    if (wav.toString('ascii', i, i + 4) === 'data') pcm = wav.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  assert.ok(pcm?.length);
  pcm = Buffer.concat([pcm, Buffer.alloc(48000)]);
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of Object.keys(env)) if (/^DEX_AUDIO_|^PYTHON|^DEX_PROFILE$|^XGEN_RNNOISE_LIBRARY$|^ELECTRON_RUN_AS_NODE$/.test(key)) delete env[key];
  const app = await _electron.launch({
    executablePath: join(appPath, 'Contents/MacOS/XGen-Dex'),
    args: [`--user-data-dir=${profile}`], env, timeout: 60000,
  });
  try {
    const actual = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), resources: process.resourcesPath }));
    assert.equal(actual.packaged, true);
    assert.equal(realpathSync(actual.profile), realpathSync(profile), 'Refuse to modify the real user profile');
    assert.equal(realpathSync(actual.resources), realpathSync(resources));
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.xgen?.audioProcessor, { timeout: 30000 });
    const auth = await page.evaluate(() => window.xgen.auth.restore());
    assert.ok(auth.user, 'Existing OS keychain login required');
    const runtimeStatus = await page.evaluate(() => window.xgen.audioProcessor.status());
    assert.equal(runtimeStatus.available, true); assert.equal(runtimeStatus.error, '');
    if (process.env.DEX_AUDIO_INSTALLED_RUNTIME) assert.equal(runtimeStatus.version, '0.1.1');
    const report = { ...actual, runtimeStatus, runtimeSource: process.env.DEX_AUDIO_INSTALLED_RUNTIME ? 'installer-output' : 'bundled', rows: [] };
    for (const noise of (process.env.DEX_AUDIO_SMOKE_BOTH_ON ? [true] : [false, true])) for (const vad of (process.env.DEX_AUDIO_SMOKE_BOTH_ON ? [true] : [false, true])) {
      const row = await page.evaluate(async ({ noise, vad, bytes }) => {
        const api = window.xgen;
        await api.config.set({ voiceNoiseReduction: noise, voiceLocalVad: vad });
        const capture = await api.audioProcessor.start();
        const session = await api.voiceStream.start('packaged-audio-verification');
        const chunks = []; let starts = 0; let ends = 0;
        try {
          for (let i = 0; i < bytes.length; i += 2048) {
            const result = await api.audioProcessor.push(capture.id, Uint8Array.from(bytes.slice(i, i + 2048)));
            chunks.push(result.pcm); starts += result.events.filter(e => e.type === 'speech_start').length;
            ends += result.events.filter(e => e.type === 'speech_end').length;
            api.voiceStream.audio(session, result.pcm);
            await new Promise(r => setTimeout(r, 64));
          }
          const tail = await api.audioProcessor.finish(capture.id); chunks.push(tail.pcm);
          starts += tail.events.filter(e => e.type === 'speech_start').length;
          ends += tail.events.filter(e => e.type === 'speech_end').length;
          api.voiceStream.audio(session, tail.pcm);
          const stream = await api.voiceStream.end(session);
          const length = chunks.reduce((n, c) => n + c.length, 0);
          const wav = new Uint8Array(44 + length); const v = new DataView(wav.buffer);
          for (const [offset, text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']])
            for (let i=0;i<text.length;i++) wav[offset+i]=text.charCodeAt(i);
          v.setUint32(4,36+length,true);v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
          v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);v.setUint32(40,length,true);
          let offset=44;for(const chunk of chunks){wav.set(chunk,offset);offset+=chunk.length;}
          const fileText = await api.voice.transcribe(new Blob([wav], {type:'audio/wav'}), 'ko');
          return { noise, vad, starts, ends, outputBytes:length, streamText:stream?.text, fileText };
        } finally { api.audioProcessor.cancel(capture.id); api.voiceStream.cancel(session); }
      }, { noise, vad, bytes: Array.from(pcm) });
      console.log(JSON.stringify(row));
      assert.equal(row.outputBytes, pcm.length);
      assert.equal(row.starts > 0, vad); assert.equal(row.ends > 0, vad);
      assert.match(row.streamText, /안녕하세요.*오늘 날씨가 정말 좋네요/);
      assert.match(row.fileText, /안녕하세요.*오늘 날씨가 정말 좋네요/);
      report.rows.push(row);
    }
    const output = process.env.DEX_AUDIO_REPORT || join(profile,'report.json');
    writeFileSync(output, JSON.stringify(report,null,2));console.log(`Report: ${output}`);
  } finally { await app.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
