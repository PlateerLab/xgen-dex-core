import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionProtocolError } from '../src/agent-session';
import { parseAgentSessionCatalogPage, validateAgentSessionCatalogCursor } from '../src/agent-session-catalog';
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002', c = '00000000-0000-4000-8000-000000000003';
const item = (id: string) => ({ id, workflow_id: 'wf', title: id, status: 'active' as const, current_sequence: 0, state_version: 1 });
test('server continuation is the last displayed id; UUID lexical order never determines session age', () => {
  const first = parseAgentSessionCatalogPage({ items: [item(a)], has_more: true, next_cursor: a });
  const older = parseAgentSessionCatalogPage({ items: [item(b), item(c)], has_more: false, next_cursor: null }, a, first.items);
  assert.equal(older.items.length, 2); assert.equal(older.next_cursor, null);
  assert.deepEqual(parseAgentSessionCatalogPage({ items: [], has_more: false, next_cursor: null }, c), { items: [], has_more: false, next_cursor: null });
});
test('empty continuation, fabricated cursor, repeated cursor and adjacent overlapping pages fail closed', () => {
  for (const page of [
    { items: [], has_more: true, next_cursor: b },
    { items: [item(b)], has_more: true, next_cursor: c },
    { items: [item(a)], has_more: true, next_cursor: a },
    { items: [item(c), item(b)], has_more: true, next_cursor: b },
  ]) assert.throws(() => parseAgentSessionCatalogPage(page, a, [item(b)]), AgentSessionProtocolError);
});
test('cursor format, page bounds and within-page duplicates retain protocol validation', () => {
  for (const cursor of ['', 'AAAAAAAA-0000-4000-8000-000000000001', `${a}?x=1`, 'private']) assert.throws(() => validateAgentSessionCatalogCursor(cursor), AgentSessionProtocolError);
  assert.throws(() => parseAgentSessionCatalogPage({ items: [item(a), item(a)], has_more: false, next_cursor: null }), AgentSessionProtocolError);
  assert.throws(() => parseAgentSessionCatalogPage({ items: Array.from({ length: 101 }, () => item(a)), has_more: false, next_cursor: null }), AgentSessionProtocolError);
});
