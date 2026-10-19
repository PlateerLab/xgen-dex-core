import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AudioProcessor, audioRuntime } from '../src/main/audio-preprocessor';
import { pcmWav } from '../src/renderer/src/voice/processed-capture';

const root =
  process.env.DEX_AUDIO_ROOT || resolve(__dirname, '../../../../xgen-audio-preprecessing');
const runtime = audioRuntime(resolve(__dirname, '..'), '/nonexistent');
const ready = existsSync(runtime.python) && existsSync(runtime.library);
test('packaged runtime resolves from Resources after relocation, ahead of a development venv', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'dex-audio-path-'));
  const keys = ['DEX_AUDIO_ROOT', 'DEX_AUDIO_PYTHON', 'XGEN_RNNOISE_LIBRARY'] as const;
  const saved = keys.map(k => process.env[k]);
  try {
    for (const key of keys) delete process.env[key];
    const root = resolve(dir, 'Resources/audio-preprocessing');
    mkdirSync(resolve(root, 'python/bin'), { recursive: true });
    mkdirSync(resolve(root, 'lib'), { recursive: true });
    writeFileSync(resolve(root, 'python/bin/python3.11'), '');
    const actual = audioRuntime(resolve(dir, 'Resources/app.asar'), resolve(dir, 'Resources'));
    assert.equal(actual.python, resolve(root, 'python/bin/python3.11'));
    assert.equal(actual.library, resolve(root, 'lib', process.platform === 'darwin' ? 'librnnoise.dylib' : process.platform === 'win32' ? 'rnnoise.dll' : 'librnnoise.so'));
  } finally {
    keys.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i]);
    rmSync(dir, { recursive: true, force: true });
  }
});
function speech(): Buffer {
  const wav = readFileSync(resolve(root, 'tests/fixtures/speech.wav'));
  for (let p = 12; p + 8 <= wav.length;) {
    const n = wav.readUInt32LE(p + 4);
    if (wav.toString('ascii', p, p + 4) === 'data') return wav.subarray(p + 8, p + 8 + n);
    p += 8 + n + (n % 2);
  }
  throw new Error('WAV data missing');
}

test('disabled bypass preserves samples and rejects invalid PCM', async () => {
  const p = new AudioProcessor({ noise: false, vad: false }, { python: '/missing', library: '' });
  await p.open();
  const pcm = Uint8Array.from([3, 4, 5, 6]);
  assert.deepEqual((await p.push(pcm)).pcm, pcm);
  await assert.rejects(p.push(new Uint8Array(3)), /PCM16/);
  assert.equal((await p.finish()).pcm.length, 0);
  await assert.rejects(p.push(pcm), /닫혔/);
});

test('missing enabled runtime fails explicitly', async () => {
  const p = new AudioProcessor({ noise: false, vad: true }, { python: '/missing', library: '' });
  await assert.rejects(p.open(), /실행 파일/);
});

for (const noise of [false, true])
  for (const vad of [false, true]) {
    test(`real worker noise=${noise} vad=${vad}`, { skip: !ready }, async () => {
      const p = new AudioProcessor({ noise, vad }, runtime);
      const input = Buffer.concat([speech(), Buffer.alloc(32000)]);
      const output: Uint8Array[] = [];
      const events: string[] = [];
      await p.open();
      try {
        for (let i = 0; i < input.length; i += 2048) {
          const reply = await p.push(input.subarray(i, i + 2048));
          output.push(reply.pcm);
          events.push(...reply.events.map((e) => e.type));
        }
        const tail = await p.finish();
        output.push(tail.pcm);
        events.push(...tail.events.map((e) => e.type));
        const all = Buffer.concat(output);
        assert.equal(all.length, input.length, 'drain preserves samples');
        if (!noise) assert.deepEqual(all, input);
        if (vad) assert.ok(events.includes('speech_start'));
        else assert.deepEqual(events, []);
        assert.strictEqual(await p.finish(), tail);
      } finally {
        p.cancel();
      }
    });
  }

test('cancel rejects further worker input', { skip: !ready }, async () => {
  const p = new AudioProcessor({ noise: false, vad: true }, runtime);
  await p.open();
  p.cancel();
  await assert.rejects(p.push(new Uint8Array(2048)), /취소/);
});

test('WAV includes final sub-frame samples', async () => {
  const pcm = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5, 6])];
  const wav = Buffer.from(await pcmWav(pcm).arrayBuffer());
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 6);
  assert.deepEqual(wav.subarray(44), Buffer.concat(pcm));
});
