import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalText, canonicalTranscript, displayLine } from '../src/tui/canonical-display';
import { emptyCanonicalTuiView } from '../src/tui/canonical-types';
import type { AgentConversationView } from '@dex/protocol/agent-session-conversation-recovery';

test('remote content cannot issue terminal controls or bidi reordering', () => {
  assert.equal(terminalText('a\u001b[2Jb\u001b]52;c;clipboard\u0007c\u001b]8;;https://evil.test\u001b\\d\u001b]8;;\u001b\\\r\u0000\u009be\u202e\t한글\nlast'), 'abcde    한글\nlast');
  assert.equal(displayLine('first\nsecond\u001b[31m', 50), 'first second');
});
test('only complete message content is displayed with explicit source and status', () => {
  const conversation: AgentConversationView = {
    snapshot: {id:'018f1240-0000-7000-8000-000000000002', workflow_id:'wf', title:'shared', current_sequence:2, state_version:1, message_history_complete:false},
    omittedMessages:0,
    messages:[{turn_id:'018f1240-0000-7000-8000-000000000003', sequence:2, status:'completed', input_text:'must not show', output_text:'also hidden', source:'unknown', content_complete:false}],
  };
  const lines = canonicalTranscript({...emptyCanonicalTuiView(), conversation}, 80).map((line) => line.text).join('\n');
  assert.match(lines, /출처 미확인/);
  assert.match(lines, /불완전/);
  assert.doesNotMatch(lines, /must not show|also hidden/);
});
