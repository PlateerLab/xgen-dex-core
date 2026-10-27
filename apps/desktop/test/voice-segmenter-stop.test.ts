import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Segmenter, type VoiceAgent } from '../src/main/voice-segmenter';

test('a failed attempt stays terminal when final STT arrives during the action', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const agent: VoiceAgent = {
    lastTarget: null,
    boundary: async () => ({ start: -1, conf: 1 }),
    readiness: async texts => texts.map(() => ({ ready: 'wait', p: 0 })),
    handle: async (_text, _th, guard) => {
      attempts++;
      assert.equal(await guard('PowerPoint 내리기', 'press', 1), true);
      entered();
      await pending;
      return { acted: false, stop: true, reason: '숨겨지지 않음', ms: 1 };
    },
  };
  const seg = new Segmenter(agent, () => {});
  seg.partial('PPT 내려줘.');
  await started;
  const final = seg.final('PPT 내려줘.');
  release();
  await final;
  assert.equal(attempts, 1);
  assert.equal(seg.failure, '숨겨지지 않음');
  assert.equal(seg.unhandled, null);
  await seg.final('PPT 내려줘.');
  assert.equal(attempts, 1);
});
