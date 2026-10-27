import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { VoiceStreamResult, VoiceStreamEvent } from '../src/main/voice-stream';
import type { CaptureChunk } from '../src/renderer/src/voice/processed-capture';
import type { useVoiceLoop } from '../src/renderer/src/voice/voice-loop';
import type { VoiceTrace } from '../src/main/voice-trace';
import { createVoiceInputTracker } from '../src/renderer/src/voice/voice-input';

test('completed voice actions clear their composer preview, including blocked actions', () => {
  for (const command of ['PPT 내려줘.', 'PPT 띄워줘.']) {
    const tracker = createVoiceInputTracker();
    assert.equal(tracker.preview(command), true);
    assert.equal(tracker.complete()(command), '');
  }
});

test('typing during a voice action survives subsequent partials and completion', () => {
  const tracker = createVoiceInputTracker();
  tracker.preview('PPT 내려줘.');
  tracker.edited();
  assert.equal(tracker.preview('PPT 내려줘'), false);
  const clear = tracker.complete();
  assert.equal(clear('내가 수정한 내용'), '내가 수정한 내용');
  assert.equal(clear('PPT 내려줘.'), 'PPT 내려줘.');
});

test('a delayed action result does not erase a newer utterance or later typing', () => {
  const tracker = createVoiceInputTracker();
  tracker.preview('PPT 내려줘.');
  const clearOld = tracker.complete();
  tracker.preview('PPT 내려줘.');
  assert.equal(clearOld('PPT 내려줘.'), 'PPT 내려줘.');
  const clearNew = tracker.complete();
  tracker.edited();
  assert.equal(clearNew('PPT 내려줘.'), 'PPT 내려줘.');
});

// Run the actual hook with deterministic capture/IPC, without a microphone or STT service.
async function loop(responseKey: string | null) {
  let now = 0;
  let cleanup: (() => void) | undefined;
  let chunk!: (c: CaptureChunk) => void;
  let event!: (e: VoiceStreamEvent) => void;
  let complete!: (r: VoiceStreamResult) => void;
  const starts: unknown[][] = [];
  const results: { text: string; key: string | null }[] = [];
  const cancelled: string[] = [];
  const traces: VoiceTrace[] = [];
  const opts: Parameters<typeof useVoiceLoop>[0] = {
    enabled: true, workflowId: 'wf', interactionId: 'chat', responseKey,
    onResult: (r, key) => { results.push({ text: r.text, key }); },
  };
  const exported: { useVoiceLoop?: typeof useVoiceLoop } = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/renderer/src/voice/voice-loop.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports: exported, Date: { now: () => now }, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'react') return {
        useState: (value: unknown) => [value, () => {}],
        useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); },
      };
      if (name === '../bridge') return { xgen: { voiceStream: {
        trace: (event: VoiceTrace) => { traces.push(event); },
        start: async (...args: unknown[]) => { starts.push(args); return 'speech'; },
        audio: () => {},
        end: () => new Promise<VoiceStreamResult>(r => { complete = r; }),
        cancel: (id: string) => { cancelled.push(id); },
        onEvent: (handler: typeof event) => { event = handler; return () => {}; },
      } } };
      if (name === './processed-capture') return { startProcessedCapture: async (handler: typeof chunk) => {
        chunk = handler;
        return { cancel: () => {}, stop: async () => {} };
      } };
      throw new Error(`unexpected import: ${name}`);
    },
  });
  exported.useVoiceLoop!(opts);
  await Promise.resolve();
  chunk({ pcm: new Uint8Array(640), inSpeech: true, events: [], vad: false });
  await Promise.resolve();
  now = 1_000;
  event({ sessionId: 'speech', type: 'utterance_end' });
  return {
    opts, starts, results, cancelled, traces,
    speak: async () => {
      chunk({ pcm: new Uint8Array(640), inSpeech: true, events: [], vad: false });
      await Promise.resolve();
    },
    finish: async (overrides: Partial<VoiceStreamResult> = {}) => {
      complete({ text: '네', actions: [], unhandled: null, timeline: [], audioEndMs: 1_000, wake: 'off', ...overrides });
      await Promise.resolve();
      await Promise.resolve();
    },
    dispose: () => cleanup?.(),
  };
}

test('continuous confirmation speech carries the captured card ID to IPC and the result callback', async () => {
  const f = await loop('first');
  assert.deepEqual(f.starts, [['wf', '', 'chat', 'first']]);
  await f.finish();
  assert.deepEqual(f.results, [{ text: '네', key: 'first' }]);
  f.dispose();
});

test('a result arriving after the visible card changed is discarded before effect cleanup', async () => {
  const f = await loop('first');
  f.opts.responseKey = 'second';
  await f.finish();
  assert.deepEqual(f.results, []);
  f.dispose();
});

test('normal speech preserves its conversation and late results after cleanup are ignored', async () => {
  const f = await loop(null);
  assert.deepEqual(f.starts, [['wf', '', 'chat', undefined]]);
  f.dispose();
  await f.finish();
  assert.deepEqual(f.results, []);
});

test('routing traces preserve the stream ID and distinguish delivery from stale results', async () => {
  const f = await loop('first');
  await f.finish({ traceId: 'speech' });
  assert.equal(f.traces[0].id, 'speech');
  assert.equal(f.traces[0].reason, 'immediate');
  assert.equal(f.traces[0].requestId, 'first');
  assert.deepEqual(f.results, [{ text: '네', key: 'first' }]);
  f.dispose();
  const stale = await loop('first');
  stale.opts.responseKey = 'second';
  await stale.finish({ traceId: 'old-speech' });
  assert.equal(stale.traces[0].id, 'old-speech');
  assert.equal(stale.traces[0].reason, 'stale_context');
  assert.deepEqual(stale.results, []);
  stale.dispose();
});

test('continuation waiting and carry-over are logged while retaining the existing wait and text', async () => {
  const f = await loop(null);
  await f.finish({ traceId: 'speech', text: '임시 저장', unhandled: '임시 저장' });
  assert.equal(f.traces[0].reason, 'waiting_for_continuation');
  assert.equal(f.traces[0].waitMs, 1_200);
  assert.deepEqual(f.results, []);
  await f.speak();
  assert.equal(f.traces[1].reason, 'joined_next_utterance');
  assert.equal(f.traces[1].text, '임시 저장');
  assert.equal(f.starts[1][1], '임시 저장');
  f.dispose();
});

test('a blocked attempt is delivered immediately without continuation carry', async () => {
  const f = await loop(null);
  await f.finish({ blocked: '숨겨지지 않음', text: 'PPT 내려줘.', unhandled: 'PPT 내려줘.' });
  assert.deepEqual(f.results, [{ text: 'PPT 내려줘.', key: null }]);
  await f.speak();
  assert.equal(f.starts[1][1], '');
  assert.equal(f.traces.some(trace => trace.stage === 'carry'), false);
  f.dispose();
});
