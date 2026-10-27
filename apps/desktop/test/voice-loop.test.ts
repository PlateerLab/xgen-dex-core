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
async function loop(responseKey: string | null, firstUtteranceMs = 1_000, endFirst = true) {
  let now = 0;
  let cleanup: (() => void) | undefined;
  let chunk!: (c: CaptureChunk) => void;
  let event!: (e: VoiceStreamEvent) => void;
  let complete!: (r: VoiceStreamResult) => void;
  const starts: unknown[][] = [];
  const results: { text: string; key: string | null }[] = [];
  const cancelled: string[] = [];
  const traces: VoiceTrace[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const stateChanges: unknown[] = [];
  let captureCancels = 0;
  let ends = 0;
  const sent: { session: number; bytes: number }[] = [];
  const opts: Parameters<typeof useVoiceLoop>[0] = {
    enabled: true, workflowId: 'wf', interactionId: 'chat', responseKey,
    onResult: (r, key) => { results.push({ text: r.text, key }); },
  };
  const exported: { useVoiceLoop?: typeof useVoiceLoop } = {};
  const source = ts.transpileModule(readFileSync(new URL('../src/renderer/src/voice/voice-loop.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports: exported, Date: { now: () => now },
    setTimeout: (fn: () => void) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    require: (name: string) => {
      if (name === 'react') return {
        useState: (value: unknown) => [value, (next: unknown) => { stateChanges.push(next); }],
        useRef: (current: unknown) => ({ current }),
        useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect(); },
      };
      if (name === '../bridge') return { xgen: { voiceStream: {
        trace: (event: VoiceTrace) => { traces.push(event); },
        start: async (...args: unknown[]) => { starts.push(args); return 'speech'; },
        audio: (_id: string, b: Uint8Array) => { sent.push({ session: starts.length, bytes: b.byteLength }); },
        end: () => { ends++; return new Promise<VoiceStreamResult>(r => { complete = r; }); },
        cancel: (id: string) => { cancelled.push(id); },
        onEvent: (handler: typeof event) => { event = handler; return () => {}; },
      } } };
      if (name === './processed-capture') return { startProcessedCapture: async (handler: typeof chunk) => {
        chunk = handler;
        return { cancel: () => { captureCancels++; }, stop: async () => {} };
      } };
      throw new Error(`unexpected import: ${name}`);
    },
  });
  exported.useVoiceLoop!(opts);
  await Promise.resolve();
  chunk({ pcm: new Uint8Array(640), inSpeech: true, events: [], vad: false });
  await Promise.resolve();
  if (endFirst) {
    now = firstUtteranceMs;
    event({ sessionId: 'speech', type: 'utterance_end' });
  }
  return {
    opts, starts, results, cancelled, traces, stateChanges,
    error: () => event({ sessionId: 'speech', type: 'error', error: 'stt_upstream_error' }),
    runTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    endSpeech: (durationMs = 1_000) => { now += durationMs; event({ sessionId: 'speech', type: 'utterance_end' }); },
    get captureCancels() { return captureCancels; },
    get ends() { return ends; },
    sent,
    chunk: async (bytes: number) => {
      chunk({ pcm: new Uint8Array(bytes), inSpeech: true, events: [], vad: false });
      await Promise.resolve();
    },
    advance: (ms: number) => { now += ms; },
    partial: (text: string) => event({ sessionId: 'speech', type: 'partial', text }),
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

test('STT errors retry listening, stop after repeated failures, and do not deliver a failed result', async () => {
  const f = await loop(null);
  f.error();
  await f.finish({ text: '불완전한 문장' });
  assert.deepEqual(f.results, []);
  assert.equal(f.captureCancels, 0);
  assert.ok(f.stateChanges.some(v => typeof v === 'string' && v.includes('다시 말씀')));
  f.runTimers();
  await f.speak();
  f.error();
  f.runTimers();
  await f.speak();
  f.error();
  assert.equal(f.captureCancels, 1);
  assert.ok(f.stateChanges.some(v => typeof v === 'string' && v.includes('반복 실패')));
  f.dispose();
});

test('stopping during retry cancels the retry timer', async () => {
  const f = await loop(null);
  f.error();
  f.dispose();
  const count = f.stateChanges.length;
  f.runTimers();
  assert.equal(f.stateChanges.length, count);
});

test('errors from cancelled short utterances do not interrupt listening', async () => {
  const f = await loop(null, 100);
  for (let i = 0; i < 3; i++) {
    const count = f.stateChanges.length;
    f.error();
    f.runTimers();
    assert.equal(f.stateChanges.length, count);
    assert.equal(f.captureCancels, 0);
    if (i < 2) {
      await f.speak();
      f.endSpeech(100);
    }
  }
  assert.equal(f.starts.length, 3);
  assert.equal(f.cancelled.length, 3);
  f.dispose();
});

test('a successful utterance after an error resets the failure count', async () => {
  const f = await loop(null);
  f.error();
  f.runTimers();
  await f.speak();
  f.endSpeech();
  await f.finish({ text: '다시 말한 내용' });
  assert.deepEqual(f.results, [{ text: '다시 말한 내용', key: null }]);
  await f.speak();
  f.error();
  f.runTimers();
  await f.speak();
  f.error();
  assert.equal(f.captureCancels, 0);
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

test('a carried utterance with no continuation is delivered when the join wait ends, without waiting for the server', async () => {
  const f = await loop(null);
  const said = '지금 몇 시인지 알려줘.';
  await f.finish({ traceId: 'speech', text: said, unhandled: said });
  assert.deepEqual(f.results, []);
  await f.speak(); // local VAD off: the next session opens on silence and carries the held words
  await Promise.resolve();
  assert.equal(f.starts[1][1], said);
  f.advance(2_000);
  await f.speak();
  assert.equal(f.ends, 1, 'still waiting for a continuation');
  f.advance(800);
  await f.speak();
  assert.equal(f.ends, 2);
  await f.finish({ traceId: 'speech', text: said, unhandled: said });
  assert.deepEqual(f.results, [{ text: said, key: null }]);
  assert.equal(f.traces.at(-1)!.reason, 'no_continuation');
  f.dispose();
});

test('a continuation heard in the carried session waits for the server end of speech', async () => {
  const f = await loop(null);
  await f.finish({ text: '기획전 좀', unhandled: '기획전 좀' });
  await f.speak();
  await Promise.resolve();
  f.partial('기획전 좀 보여줘');
  f.advance(5_000);
  await f.speak();
  assert.equal(f.ends, 1);
  f.endSpeech();
  await f.finish({ text: '기획전 좀 보여줘.', unhandled: '기획전 좀 보여줘.' });
  assert.deepEqual(f.results, []);
  f.runTimers();
  assert.deepEqual(f.results, [{ text: '기획전 좀 보여줘.', key: null }]);
  f.dispose();
});

test('without local VAD the next session first hears the last audio sent before the server ended the previous one', async () => {
  const f = await loop(null, 0, false);
  await Promise.resolve();
  // 100 ms chunks with distinct sizes: the wake word, then the first syllable of the command
  for (const bytes of [3_200, 3_202, 3_204, 3_206, 3_208]) { f.advance(100); await f.chunk(bytes); }
  f.endSpeech(0); // the server's end of speech arrives after the command started
  await f.chunk(3_210); // heard while the first session finishes
  await f.finish({ text: '', wake: 'called' });
  await Promise.resolve();
  assert.equal(f.starts.length, 2);
  const next = f.sent.filter(s => s.session === 2).map(s => s.bytes);
  assert.deepEqual(next.slice(0, 4), [3_204, 3_206, 3_208, 3_210]);
  f.dispose();
});
