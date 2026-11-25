import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSubscribed, turnEventToChatEvent } from '../src/chat';
import { confirmsChatDispatch } from '../src/device-draft';

test('admission confirms an outgoing turn before model output', () => {
  assert.deepEqual(turnEventToChatEvent('turn_accepted', {request_id:'send', run:'run'}), {
    kind:'turn_accepted', requestId:'send', runId:'run',
  });
  assert.equal(confirmsChatDispatch('turn_accepted'), true);
  assert.equal(turnEventToChatEvent('turn_accepted', {}), null);
});

test('resume retains the run identity and snapshot watermark', () => {
  assert.deepEqual(parseSubscribed({running:true, live:{run:'r', seq:8}}).live,
    {text:'', events:[], runId:'r', seq:8});
});
