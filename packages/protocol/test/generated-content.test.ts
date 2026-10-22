import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { HttpClient } from '../src/client';
import { GeneratedContentApi, parseGeneratedContentEvent, parseStoredGeneratedContent } from '../src/generated-content';
import { frameToChatEvent, parseSubscribed, turnEventToChatEvent } from '../src/chat';
import { HistoryApi } from '../src/history';

const event = { indication: 'ai_generated', proof: 'header.payload.signature', sha256: 'a'.repeat(64),
  content_type: 'text/plain', byte_length: 3, source_id: '12345678-1234-4123-8123-123456789abc' };
const marker = (kind = 'CONTENT', fields = event) => `<!--XGEN_GENERATED_${kind}_V1 proof=${fields.proof} sha256=${fields.sha256} content_type=${fields.content_type} byte_length=${fields.byte_length} source_id=${fields.source_id}-->`;

test('history envelopes preserve exact UTF8 whitespace and split text/media without claiming verification', () => {
  const text = '한글 답변\n\n';
  const media = { ...event, content_type: 'image/png', source_id: '12345678-1234-4123-8123-123456789abd' };
  const stored = parseStoredGeneratedContent(text + '\n' + marker() + '\n' + marker('MEDIA', media));
  assert.equal(stored.visibleText, text);
  assert.equal(stored.text.length, 1); assert.equal(stored.media.length, 1);
  assert.equal(stored.malformed, false);
  assert.equal('verified' in stored.text[0], false);
});

test('malformed, duplicate, oversized and truncated proof envelopes stay hidden', () => {
  for (const raw of [marker().replace('proof=', 'unknown='), marker() + marker(),
    marker().replace(event.proof, 'x'.repeat(9000)), '<!--XGEN_GENERATED_CONTENT_V1 proof=truncated']) {
    const stored = parseStoredGeneratedContent('visible\n' + raw);
    assert.equal(stored.malformed, true);
    assert.equal(stored.visibleText.includes('proof='), false);
    assert.equal(stored.visibleText.includes('XGEN_GENERATED_'), false);
  }
  for (const byte_length of [null, true, '', '01', '1e3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseGeneratedContentEvent({ ...event, byte_length }), null);
  }
});

test('oversized closed envelopes and an exhausted marker budget fail closed without encoding the suffix', () => {
  const closed = '<!--XGEN_GENERATED_CONTENT_V1 proof=' + 'x'.repeat(4 * 1024 * 1024) + '-->';
  const parsed = parseStoredGeneratedContent('visible\n' + closed + '\nafter');
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.visibleText, 'visible\nafter');
  assert.equal(parsed.text.length, 0);
  const budget = parseStoredGeneratedContent('visible\n' + marker().repeat(65) + 'hidden suffix');
  assert.equal(budget.malformed, true);
  assert.equal(budget.visibleText, 'visible');
  assert.equal(budget.visibleText.includes('hidden suffix'), false);
  assert.equal(parseGeneratedContentEvent({ ...event, proof: 'x'.repeat(4 * 1024 * 1024) }), null);
  assert.equal(parseGeneratedContentEvent({ ...event, byte_length: '1'.repeat(4 * 1024 * 1024) }), null);
});

test('SSE, live WS and reconnect snapshots keep proof separate from assistant text', () => {
  assert.equal(frameToChatEvent('generated_content', JSON.stringify(event))?.kind, 'generated_content');
  assert.equal(turnEventToChatEvent('generated_content', event)?.kind, 'generated_content');
  assert.equal(turnEventToChatEvent('generated_content', { ...event, proof: 'invalid' }), null);
  const snapshot = parseSubscribed({ running: true, live: { text: 'answer', events: [{ event: 'generated_content', data: event }] } });
  const item = snapshot.live!.events[0] as { event: string; data: typeof event };
  assert.equal(turnEventToChatEvent(item.event, item.data)?.kind, 'generated_content');
  assert.equal(snapshot.live?.text, 'answer');
});

test('history API restores hidden proof envelopes alongside visible output', async () => {
  const http = new HttpClient({ baseUrl: 'http://xgen.test', fetch: async () => Response.json({ in_out_logs: [{
    log_id: 1, io_id: 2, interaction_id: 'i', workflow_id: 'w', workflow_name: 'a',
    input_data: 'input', output_data: 'answer\n' + marker(), updated_at: '',
  }] }) });
  const history = await new HistoryApi(http).snapshot('w', 'i');
  assert.equal(history.turns[0].output, 'answer');
  assert.equal(history.turns[0].generatedContent?.[0].proof, event.proof);
});

test('verification hashes actual current text and binary bytes instead of emitted digest', async () => {
  let sent: Record<string, unknown> = {};
  const http = new HttpClient({ baseUrl: 'http://xgen.test', fetch: async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ status: 'verified', signature_valid: true, content_match: true, actor_match: true, statement: {} });
  } });
  const api = new GeneratedContentApi(http);
  const text = '현재 실제 본문\n';
  assert.equal((await api.verifyText(event.proof, text)).status, 'verified');
  assert.equal(sent.sha256, createHash('sha256').update(text).digest('hex'));
  assert.equal(sent.byte_length, Buffer.byteLength(text));
  assert.notEqual(sent.sha256, event.sha256);
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  await api.verifyBytes(event.proof, bytes, 'IMAGE/PNG');
  assert.equal(sent.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(sent.content_type, 'image/png');
  assert.equal(sent.byte_length, 4);
});

test('contradictory verified responses, malformed responses and negative states never become verified', async () => {
  let reply: unknown;
  const api = new GeneratedContentApi(new HttpClient({ baseUrl: 'http://xgen.test', fetch: async () => Response.json(reply) }));
  for (const field of ['signature_valid', 'content_match', 'actor_match']) {
    reply = { status: 'verified', signature_valid: true, content_match: true, actor_match: true, [field]: false };
    await assert.rejects(api.verifyText(event.proof, 'text'), /inconsistent/);
  }
  for (reply of [null, [], { status: 'unknown' }]) await assert.rejects(api.verifyText(event.proof, 'text'), /invalid/);
  for (const status of ['changed', 'other_actor', 'invalid', 'unsigned_legacy']) {
    reply = { status, signature_valid: false, content_match: false, actor_match: false };
    assert.equal((await api.verifyText(null, 'text')).status, status);
  }
  const unavailable = new GeneratedContentApi(new HttpClient({ baseUrl: 'http://xgen.test', fetch: async () => new Response('{}', { status: 503 }) }));
  assert.equal((await unavailable.verifyText(event.proof, 'text')).status, 'unavailable');
});
