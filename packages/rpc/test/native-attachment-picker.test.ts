import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeAttachmentPickerBroker } from '../src/native-attachment-picker-server';
import { NativeAttachmentPickerResponder } from '../src/native-attachment-picker-client';
import { NATIVE_ATTACHMENT_PICK_CANCEL, NATIVE_ATTACHMENT_PICK_METHOD } from '../src/native-attachment-picker-wire';

const limits = Object.freeze({ max_files: 2, max_bytes: 8 });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('negotiated trusted host chooser transfers paths privately and engine returns only file bytes/basenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-rpc-'));
  try {
    const path = join(dir, 'chosen.bin'); await writeFile(path, Uint8Array.from([0, 128, 255]));
    const messages: any[] = []; let selections = 0;
    let broker!: NativeAttachmentPickerBroker;
    const responder = new NativeAttachmentPickerResponder(async (_signal, value) => {
      assert.deepEqual(value, limits); assert.ok(Object.isFrozen(value)); selections++; return [path];
    }, (frame) => { messages.push(frame); broker.receive(frame); });
    broker = new NativeAttachmentPickerBroker((frame) => { messages.push(frame); responder.handle(frame as any); });
    await assert.rejects(broker.pick(new AbortController().signal, limits)); assert.equal(selections, 0);
    broker.negotiate(true); responder.negotiate(true);
    const files = await broker.pick(new AbortController().signal, limits);
    assert.equal(selections, 1); assert.equal(files[0].filename, 'chosen.bin');
    assert.deepEqual([...files[0].bytes], [0, 128, 255]); assert.equal(JSON.stringify(files).includes(dir), false);
    assert.equal(messages[0].method, NATIVE_ATTACHMENT_PICK_METHOD);
    assert.deepEqual(Object.keys(messages[0].params).sort(), ['max_bytes', 'max_files']);
    assert.equal(messages.filter((frame) => frame.result?.paths).length, 1);
    files[0].bytes.fill(0); broker.close(); responder.reset();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelled and duplicate chooser responses cannot read files or restore a pending selection', async () => {
  const sent: any[] = []; const broker = new NativeAttachmentPickerBroker((frame) => sent.push(frame)); broker.negotiate(true);
  const controller = new AbortController(); const pending = broker.pick(controller.signal, limits);
  const id = sent[0].id;
  assert.equal(broker.receive({ jsonrpc: '2.0', id: `${id}-other`, result: { paths: ['/private/never-read'] } }), true);
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(sent[1].method, NATIVE_ATTACHMENT_PICK_CANCEL);
  assert.equal(broker.receive({ jsonrpc: '2.0', id, result: { paths: ['/private/never-read'] } }), true);
  const next = broker.pick(new AbortController().signal, limits);
  const nextId = sent[2].id; assert.notEqual(nextId, id);
  assert.equal(broker.receive({ jsonrpc: '2.0', id, result: { paths: ['/private/never-read'] } }), true);
  broker.receive({ jsonrpc: '2.0', id: nextId, result: { paths: [] } });
  assert.deepEqual(await next, []); broker.close();
});

test('matched picker frames reject unsafe fields/paths and scrub provider/filesystem errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-picker-rpc-'));
  try {
    const path = join(dir, 'private.bin'); await writeFile(path, 'ninebytes'); await symlink(path, join(dir, 'link'));
    for (const result of [{ paths: ['relative'] }, { paths: [`/${'a'.repeat(4096)}`] },
      { paths: [path, path, path] }, { paths: [path], bytes: 'private' },
      { paths: [path] }, { paths: [join(dir, 'link')] }, { paths: [join(dir, 'missing-secret-file')] }]) {
      const frames: any[] = []; const broker = new NativeAttachmentPickerBroker((frame) => frames.push(frame)); broker.negotiate(true);
      const pending = broker.pick(new AbortController().signal, limits);
      broker.receive({ jsonrpc: '2.0', id: frames[0].id, result });
      await assert.rejects(pending, (error: Error) => { assert.equal(error.message.includes(dir), false); return true; });
      broker.close();
    }
    const frames: any[] = []; let broker!: NativeAttachmentPickerBroker;
    const responder = new NativeAttachmentPickerResponder(async () => { throw new Error(`/private/${dir}/token-secret`); },
      (frame) => { frames.push(frame); broker.receive(frame); });
    broker = new NativeAttachmentPickerBroker((frame) => responder.handle(frame as any));
    broker.negotiate(true); responder.negotiate(true);
    await assert.rejects(broker.pick(new AbortController().signal, limits));
    assert.equal(JSON.stringify(frames).includes(dir), false); assert.equal(JSON.stringify(frames).includes('token-secret'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('client reset and cancellation suppress late successful and rejected dialog replies', async () => {
  for (const rejectDialog of [false, true]) {
    const replies: any[] = []; let settle!: (paths: readonly string[]) => void; let fail!: (error: Error) => void;
    let signal!: AbortSignal;
    const waiting = new Promise<readonly string[]>((resolve, reject) => { settle = resolve; fail = reject; });
    const responder = new NativeAttachmentPickerResponder(async (value) => { signal = value; return waiting; }, (frame) => replies.push(frame));
    responder.negotiate(true);
    const id = 'native-picker:00000000-0000-4000-8000-000000000001';
    responder.handle({ jsonrpc: '2.0', id, method: NATIVE_ATTACHMENT_PICK_METHOD, params: limits });
    responder.handle({ jsonrpc: '2.0', method: NATIVE_ATTACHMENT_PICK_CANCEL, params: { id } });
    assert.equal(signal.aborted, true);
    if (rejectDialog) fail(new Error('/private/late-file')); else settle(['/private/late-file']);
    await turn(); assert.deepEqual(replies, []); responder.reset();
  }
});

test('invalid or overlapping reverse requests do not invoke another chooser', async () => {
  let dialogs = 0; const sent: any[] = [];
  const responder = new NativeAttachmentPickerResponder(async () => { dialogs++; return new Promise(() => {}); }, (frame) => sent.push(frame));
  const frame = { jsonrpc: '2.0', id: 'native-picker:00000000-0000-4000-8000-000000000001', method: NATIVE_ATTACHMENT_PICK_METHOD, params: limits };
  responder.handle(frame); assert.equal(dialogs, 0); responder.negotiate(true);
  for (const invalid of [{ ...frame, params: { ...limits, max_files: 11 } }, { ...frame, path: '/private/file' },
    { ...frame, params: { ...limits, max_bytes: 104857601 } }]) responder.handle(invalid);
  assert.equal(dialogs, 0);
  responder.handle(frame); assert.equal(dialogs, 1);
  responder.handle({ ...frame, id: 'native-picker:00000000-0000-4000-8000-000000000002' });
  assert.equal(dialogs, 1); responder.reset();
  assert.equal(JSON.stringify(sent).includes('/private/file'), false);
});
