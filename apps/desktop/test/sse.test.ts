import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SseParser } from '../src/core/sse';
import { frameToChatEvent } from '../src/core/chat';

test('SseParser: splits frames on blank line', () => {
  const p = new SseParser();
  const frames = p.push('event: tool\ndata: {"a":1}\n\ndata: {"type":"data","content":"hi"}\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, 'tool');
  assert.equal(frames[0].data, '{"a":1}');
  assert.equal(frames[1].event, undefined);
  assert.equal(frames[1].data, '{"type":"data","content":"hi"}');
});

test('SseParser: buffers partial frames across chunks', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"type":"da'), []);
  assert.deepEqual(p.push('ta","content":"x"}'), []);
  const frames = p.push('\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '{"type":"data","content":"x"}');
});

test('SseParser: multi-line data concatenated with \\n', () => {
  const p = new SseParser();
  const frames = p.push('data: line1\ndata: line2\n\n');
  assert.equal(frames[0].data, 'line1\nline2');
});

test('SseParser: ignores comments/heartbeats and handles CRLF', () => {
  const p = new SseParser();
  const frames = p.push(': keepalive\r\n\r\nevent: log\r\ndata: {"m":1}\r\n\r\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'log');
  assert.equal(frames[0].data, '{"m":1}');
});

test('SseParser: flush yields trailing unterminated frame', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"type":"end"}'), []);
  const frames = p.flush();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '{"type":"end"}');
});

test('frameToChatEvent: text chunk', () => {
  const e = frameToChatEvent(undefined, '{"type":"data","content":"hello"}');
  assert.deepEqual(e, { kind: 'text', content: 'hello' });
});

test('frameToChatEvent: named tool event with citations', () => {
  const e = frameToChatEvent(
    'tool',
    JSON.stringify({
      event_type: 'tool_result',
      tool_name: 'web_search',
      result: 'ok',
      citations: [{ file_name: 'a.pdf', page_number: 3 }],
    }),
  );
  assert.equal(e?.kind, 'tool');
  if (e?.kind === 'tool') {
    assert.equal(e.event.eventType, 'tool_result');
    assert.equal(e.event.toolName, 'web_search');
    assert.equal(e.event.citations?.[0].file_name, 'a.pdf');
  }
});

test('frameToChatEvent: bare tool frame (no event: line)', () => {
  const e = frameToChatEvent(undefined, '{"type":"tool_call","tool_name":"calc","tool_input":{"x":1}}');
  assert.equal(e?.kind, 'tool');
  if (e?.kind === 'tool') assert.equal(e.event.toolName, 'calc');
});

test('frameToChatEvent: node_status, execution_io, end, error', () => {
  assert.deepEqual(frameToChatEvent('node_status', '{"node_id":"n1","status":"running"}'), {
    kind: 'node_status',
    event: { nodeId: 'n1', status: 'running', node_id: 'n1' },
  });
  assert.deepEqual(frameToChatEvent('execution_io', '{"execution_io_id":55}'), {
    kind: 'execution_io',
    executionIoId: 55,
  });
  assert.deepEqual(frameToChatEvent(undefined, '{"type":"end"}'), { kind: 'end' });
  assert.deepEqual(frameToChatEvent(undefined, '{"type":"error","detail":"boom"}'), {
    kind: 'error',
    detail: 'boom',
  });
});

test('frameToChatEvent: summary flattens outputs', () => {
  const e = frameToChatEvent(
    undefined,
    '{"type":"summary","data":{"status":"success","outputs":["final ","answer"]}}',
  );
  assert.equal(e?.kind, 'summary');
  if (e?.kind === 'summary') assert.equal(e.text, 'final answer');
});

test('frameToChatEvent: unknown named event ignored', () => {
  assert.equal(frameToChatEvent('mystery', '{"x":1}'), null);
});
