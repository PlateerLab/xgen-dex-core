import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { VoiceStreamHub, VoiceStreamEvent } from '../src/main/voice-stream';
import * as wake from '../src/main/voice-wake';
import { norm } from '../src/main/voice-segmenter';
import type { VoiceTrace } from '../src/main/voice-trace';

const nodeRequire = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../src/main/voice-stream.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function fixture(debug = false) {
  let time = 100_000;
  let words: string[] | null = ['엑스젠'];
  const calls = { prefetch: 0, partial: 0, confirm: 0, final: 0, remember: 0 };
  const logs: { message: string; data: Record<string, unknown> }[] = [];
  const traces: VoiceTrace[] = [];
  const starts: Record<string, unknown>[] = [];
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    text = '';
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.emit('open'));
    }
    send(data: unknown) {
      if (typeof data !== 'string') return;
      const message = JSON.parse(data);
      if (message.type === 'start') {
        starts.push(message);
        this.emit('message', JSON.stringify({ type: 'ready' }));
      }
      if (message.type === 'stop') this.emit('message', JSON.stringify({ type: 'done', text: this.text }));
    }
    close() { this.emit('close', 1000); }
    hear(text: string) {
      this.text = text;
      this.emit('message', JSON.stringify({ type: 'partial', text }));
    }
  }
  const exported: { VoiceStreamHub?: typeof VoiceStreamHub } = {};
  runInNewContext(source, {
    exports: exported, Buffer, performance, process: { env: { ...process.env, DEX_WAKE_DEBUG: debug ? '1' : '0' } }, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return time; } },
    require(name: string) {
      if (name === 'ws') return FakeWebSocket;
      if (name === '@dex/engine/connection-security') return { xgenWebSocketTlsOptions: () => ({}) };
      if (name === './diag-log') return { diag: (_scope: string, message: string, data: Record<string, unknown>) => logs.push({ message, data }) };
      if (name === './voice-trace') return { traceVoice: (event: VoiceTrace) => { if (debug) traces.push(event); } };
      if (name === './fast-act-e13') return { FORMAT: 'e13' };
      if (name === './fast-act-runner') return { fastActEnabled: () => true };
      if (name === './fast-act-voice') return { BrowserVoiceAgent: class {
        actions = [];
        prefetch() { calls.prefetch++; }
      } };
      if (name === './voice-segmenter') return { norm, Segmenter: class {
        unhandled = null;
        partial() { calls.partial++; }
        confirm() { calls.confirm++; }
        async final() { calls.final++; }
      } };
      if (name === './voice-turns') return { rememberVoiceTurn: () => calls.remember++ };
      if (name === './voice-wake') return wake;
      if (name.startsWith('node:')) return nodeRequire(name);
      throw new Error(`unexpected dependency: ${name}`);
    },
  });
  const hub = new exported.VoiceStreamHub!(() => ({
    baseUrl: () => 'https://synthetic.invalid', token: async () => 'synthetic',
    allowPrivateCertificate: () => false, wakeWords: () => words, planBeforeAct: () => false,
  }));
  return {
    calls,
    logs,
    traces,
    starts,
    set words(value: string[] | null) { words = value; },
    advance(ms: number) { time += ms; },
    async utterance(text: string, rawStt = false) {
      const events: VoiceStreamEvent[] = [];
      const id = await hub.start('wf', event => events.push(event), '', rawStt, 'chat', !rawStt);
      const socket = sockets.at(-1)!;
      socket.hear(text);
      socket.emit('message', JSON.stringify({ type: 'final', text }));
      const result = await hub.end(id);
      assert.ok(result);
      return { result, events };
    },
  };
}

test('confirmation replies without a wake word are neither displayed nor returned', async () => {
  const f = fixture();
  const { result, events } = await f.utterance('누르지 마.');
  assert.equal(result.wake, 'ignored');
  assert.equal(result.text, '');
  assert.equal(events.some(event => event.type === 'partial'), false);
  assert.equal(events.some(event => event.type === 'wake'), false);
});

test('STT start uses the existing comma-separated wake list as its context hint', async () => {
  const f = fixture();
  f.words = wake.parseWakeWords(' 엑스젠, 자비스, , ');
  await f.utterance('자비스, 진행해줘.');
  assert.deepEqual(f.starts, [{ type: 'start', format: 'pcm16', sample_rate: 16000, language: 'ko', mode: 'partials', context: '엑스젠, 자비스' }]);
});

test('STT start omits context when wake is off, the list is empty, or raw-STT mode is used', async () => {
  const f = fixture();
  f.words = null;
  await f.utterance('진행해줘.');
  f.words = wake.parseWakeWords(', ,');
  await f.utterance('진행해줘.');
  f.words = ['엑스젠'];
  await f.utterance('진행해줘.', true);
  assert.ok(f.starts.every(start => !Object.hasOwn(start, 'context')));
});

test('each new STT session uses the latest wake list instead of a fixed brand name', async () => {
  const f = fixture();
  await f.utterance('엑스젠, 진행해줘.');
  f.words = wake.parseWakeWords('자비스, 도우미');
  await f.utterance('도우미, 진행해줘.');
  assert.equal(f.starts[0].context, '엑스젠');
  assert.equal(f.starts[1].context, '자비스, 도우미');
});

test('wake-prefixed replies reach the card with the prefix stripped and all browser work deferred', async () => {
  const f = fixture();
  const { result, events } = await f.utterance('엑스젠, 진행해줘.');
  assert.equal(result.wake, 'heard');
  assert.equal(result.text, '진행해줘.');
  assert.ok(events.some(event => event.type === 'wake'));
  assert.ok(events.some(event => event.type === 'partial' && event.text === '진행해줘.'));
  assert.equal(result.actions.length, 0);
  assert.deepEqual(f.calls, { prefetch: 0, partial: 0, confirm: 0, final: 0, remember: 0 });
});

test('wake off accepts a direct answer and still prevents all browser work', async () => {
  const f = fixture();
  f.words = null;
  const { result } = await f.utterance('이번만 눌러.');
  assert.equal(result.wake, 'off');
  assert.equal(result.text, '이번만 눌러.');
  assert.deepEqual(f.calls, { prefetch: 0, partial: 0, confirm: 0, final: 0, remember: 0 });
});

test('wake-only opens the existing window for exactly one following answer', async () => {
  const f = fixture();
  assert.equal((await f.utterance('엑스젠.')).result.wake, 'called');
  f.advance(wake.WAKE_WINDOW_MS - 1);
  const { result } = await f.utterance('누르지 마.');
  assert.equal(result.wake, 'heard');
  assert.equal(result.text, '누르지 마.');
  assert.equal((await f.utterance('진행해줘.')).result.wake, 'ignored');
  assert.deepEqual(f.calls, { prefetch: 0, partial: 0, confirm: 0, final: 0, remember: 0 });
});

test('the next-answer window expires and each new session reads the current custom wake setting', async () => {
  const f = fixture();
  await f.utterance('엑스젠.');
  f.advance(wake.WAKE_WINDOW_MS + 1);
  assert.equal((await f.utterance('진행해줘.')).result.wake, 'ignored');
  f.words = ['자비스'];
  assert.equal((await f.utterance('엑스젠, 진행해줘.')).result.wake, 'ignored');
  assert.equal((await f.utterance('자비스, 진행해줘.')).result.text, '진행해줘.');
});

test('raw-STT test mode keeps its existing wake bypass without browser work', async () => {
  const f = fixture();
  const { result } = await f.utterance('원문 그대로.', true);
  assert.equal(result.wake, 'off');
  assert.equal(result.text, '원문 그대로.');
  assert.deepEqual(f.calls, { prefetch: 0, partial: 0, confirm: 0, final: 0, remember: 0 });
});

test('wake diagnostics are disabled unless explicitly enabled', async () => {
  const f = fixture();
  await f.utterance('엑젠.');
  assert.equal(f.logs.some(log => log.message === 'wake-debug'), false);
});

test('opt-in diagnostics show the original short rejected transcription and wake result once', async () => {
  const f = fixture(true);
  await f.utterance('엑젠.');
  const logs = f.logs.filter(log => log.message === 'wake-debug');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.heard, '엑젠.');
  assert.equal(logs[0].data.wake, 'ignored');
  assert.equal(logs[0].data.match, null);
  assert.equal(logs[0].data.followUp, false);
});

test('diagnostics distinguish a matched wake phrase from an allowed follow-up', async () => {
  const f = fixture(true);
  await f.utterance('엑스젠.');
  const first = f.logs.find(log => log.message === 'wake-debug')!.data;
  assert.equal(first.heard, '엑스젠.');
  assert.equal(first.wake, 'called');
  assert.equal((first.match as { text: string }).text, '엑스젠');
  assert.equal((first.match as { distance: number }).distance, 0);
  await f.utterance('진행해줘.');
  const second = f.logs.filter(log => log.message === 'wake-debug').at(-1)!.data;
  assert.equal(second.wake, 'heard');
  assert.equal(second.followUp, true);
  assert.equal(second.match, null);
});

test('diagnostics omit long speech, wake-off sessions and raw-STT test sessions', async () => {
  const f = fixture(true);
  await f.utterance('이 문장은 호출어 진단에 필요하지 않은 긴 주변 대화이므로 원문을 기록하지 않습니다.');
  f.words = null;
  await f.utterance('엑젠.');
  f.words = ['엑스젠'];
  await f.utterance('엑젠.', true);
  assert.equal(f.logs.some(log => log.message === 'wake-debug'), false);
});

test('diagnostics include at most 24 characters and do not log empty speech', async () => {
  const f = fixture(true);
  await f.utterance('가'.repeat(24));
  assert.equal(f.logs.filter(log => log.message === 'wake-debug').length, 1);
  await f.utterance('가'.repeat(25));
  await f.utterance('');
  assert.equal(f.logs.filter(log => log.message === 'wake-debug').length, 1);
});

test('detailed diagnostics correlate raw STT, wake remainder, carry and final result without changing them', async () => {
  const f = fixture(true);
  f.words = wake.parseWakeWords('헤이 엑스젠, HEY XGEN, 헤이엑스젠');
  const raw = '헤이 엑스젠, HEY XGEN, 헤이엑스젠. 임시 저장 버튼.';
  const { result } = await f.utterance(raw);
  assert.ok(result.traceId);
  assert.ok(f.traces.every(trace => trace.id === result.traceId));
  assert.equal(f.traces.find(trace => trace.stage === 'start')!.context, '헤이 엑스젠, HEY XGEN, 헤이엑스젠');
  for (const source of ['partial', 'final', 'done']) {
    assert.equal(f.traces.find(trace => trace.stage === 'stt' && trace.source === source)!.text, raw);
  }
  assert.equal(f.traces.find(trace => trace.stage === 'gate')!.afterWake, 'HEY XGEN, 헤이엑스젠. 임시 저장 버튼.');
  assert.equal(f.traces.find(trace => trace.stage === 'result')!.text, result.text);
  assert.equal(f.traces.find(trace => trace.stage === 'finalize')!.reason, 'done_received');
  const disabled = fixture();
  assert.equal((await disabled.utterance('엑스젠, 진행해줘.')).result.traceId, undefined);
  assert.equal(disabled.traces.length, 0);
});
