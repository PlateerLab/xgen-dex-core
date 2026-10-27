import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearDiag, diagEntries, diagText } from '../src/main/diag-log';
import { traceVoice, type VoiceTrace } from '../src/main/voice-trace';

test('trace requires explicit enablement and bounds/redacts text and IPC fields', () => {
  const saved = process.env.DEX_WAKE_DEBUG;
  try {
    clearDiag();
    delete process.env.DEX_WAKE_DEBUG;
    traceVoice({ id: 'speech', stage: 'stt', text: '헤이 엑스젠' });
    assert.equal(diagEntries().length, 0);
    process.env.DEX_WAKE_DEBUG = '1';
    traceVoice({ id: 'speech', stage: 'gate', text: '가'.repeat(301), afterWake: '명령', carry: '', context: '헤이 엑스젠', reason: 'accepted', waitMs: 123 });
    const entry = diagEntries()[0];
    assert.equal(entry.scope, 'voice-trace');
    const data = JSON.parse(entry.msg.slice(entry.msg.indexOf('{')));
    assert.equal(data.id, 'speech');
    assert.ok(Number.isFinite(Date.parse(data.at)));
    assert.equal(data.text.length, 300);
    assert.equal(data.textChars, 301);
    assert.equal(data.textTruncated, true);
    assert.equal(data.afterWake, '명령');
    assert.equal(data.waitMs, 123);
    traceVoice({ id: 'speech', stage: 'stt', text: 'Bearer synthetic-secret' });
    assert.ok(!diagText().includes('synthetic-secret'));
    traceVoice({ id: '', stage: 'stt' });
    traceVoice({ id: 'speech', stage: 'invalid' } as unknown as VoiceTrace);
    assert.equal(diagEntries().length, 2);
  } finally {
    clearDiag();
    if (saved === undefined) delete process.env.DEX_WAKE_DEBUG;
    else process.env.DEX_WAKE_DEBUG = saved;
  }
});
