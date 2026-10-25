import assert from 'node:assert/strict';
import test from 'node:test';

let audioCallback: ((event: any) => void) | null = null;
let tracksStopped = 0;
let cancelled = 0;
let requests: Uint8Array[] = [];
let rejectPush = false;
let constraints: any;
const bridge = {
  start: async () => ({ id: 'capture', vad: true, noise: false }),
  push: async (_id: string, pcm: Uint8Array) => {
    if (rejectPush) throw new Error('worker failed');
    requests.push(pcm);
    return { pcm, inSpeech: true, events: [] };
  },
  finish: async () => ({ pcm: Uint8Array.from([7, 8]), inSpeech: false, events: [] }),
  cancel: () => {
    cancelled++;
  },
};
Object.defineProperty(globalThis, 'window', {
  value: { xgen: { audioProcessor: bridge } },
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async (opts: any) => {
        constraints = opts;
        return {
          getTracks: () => [
            {
              stop: () => {
                tracksStopped++;
              },
            },
          ],
        };
      },
    },
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'AudioContext', {
  value: class {
    destination = {};
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      return {
        set onaudioprocess(fn: typeof audioCallback) {
          audioCallback = fn;
        },
        connect() {},
        disconnect() {},
      };
    }
    close() {
      return Promise.resolve();
    }
  },
  configurable: true,
});
const frame = () =>
  audioCallback?.({ inputBuffer: { getChannelData: () => Float32Array.from([0.5, -0.5]) } });

test('capture drains samples and tail, requests browser NS off and AEC on', async () => {
  const { startProcessedCapture } = await import('../src/renderer/src/voice/processed-capture');
  const chunks: Uint8Array[] = [];
  const errors: Error[] = [];
  const capture = await startProcessedCapture(
    (c) => chunks.push(c.pcm),
    (e) => errors.push(e),
  );
  frame();
  frame();
  await capture.stop();
  assert.equal(constraints.audio.noiseSuppression, false);
  assert.equal(constraints.audio.echoCancellation, true);
  assert.equal(tracksStopped, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([...requests, Buffer.from([7, 8])]));
  assert.deepEqual(errors, []);
  await capture.stop();
  assert.equal(chunks.length, 3);
});

test('pause sends silence and failure closes microphone without a raw bypass', async () => {
  const { startProcessedCapture } = await import('../src/renderer/src/voice/processed-capture');
  requests = [];
  const paused = await startProcessedCapture(
    () => {},
    () => {},
    () => true,
  );
  frame();
  await paused.stop();
  assert.deepEqual([...requests[0]], [0, 0, 0, 0]);
  rejectPush = true;
  const errors: Error[] = [];
  const bad = await startProcessedCapture(
    () => assert.fail('failed PCM must not escape'),
    (e) => errors.push(e),
  );
  frame();
  await assert.rejects(bad.stop(), /취소/);
  assert.equal(errors[0].message, 'worker failed');
  assert.equal(cancelled, 1);
});
