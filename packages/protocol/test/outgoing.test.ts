import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceOutbox, type PendingStorage } from '../src/outgoing';

function device() {
  const records = new Map<string, string>();
  return {
    keys: (prefix: string) =>
      [...records.keys()].filter((key) => key.startsWith(prefix)),
    read: (key: string) => records.get(key) ?? null,
    write(key: string, value: string | null) {
      if (value === null) records.delete(key);
      else records.set(key, value);
    },
  } satisfies PendingStorage;
}
const row = (id: string) => ({
  id,
  workflowId: 'flow',
  interactionId: 'room',
  text: '동일한 질문',
  files: [id],
});

test('two processes stage concurrently; a late receipt removes only its original send', async () => {
  const disk = device();
  const first = deviceOutbox<string>(disk, 'alice');
  const second = deviceOutbox<string>(disk, 'alice');
  const bob = deviceOutbox<string>(disk, 'bob');
  await Promise.all([
    first.stage(row('1')),
    second.stage(row('2')),
    bob.stage(row('1')),
  ]);
  await first.remove(['1']);
  assert.deepEqual(first.snapshot(), [row('2')]);
  assert.deepEqual(bob.snapshot(), [row('1')]);
});

test('restart checks only local IDs and retains unresolved attachments without dispatch', async () => {
  const disk = device();
  const before = deviceOutbox<string>(disk, 'alice');
  await before.stage(row('a'));
  await before.stage(row('b'));
  const after = deviceOutbox<string>(disk, 'alice');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      off();
      reject(new Error('receipt timeout'));
    }, 2500);
    const off = after.subscribe(() => {
      if (after.snapshot().length !== 1) return;
      clearTimeout(timeout);
      stop();
      off();
      resolve();
    });
    const stop = after.watch(async (wf, room, ids) => {
      assert.deepEqual([wf, room, ids], ['flow', 'room', ['a', 'b']]);
      return ['a', 'another-account'];
    });
  });
  assert.deepEqual(after.snapshot(), [row('b')]);
});

test('storage failure is reported before a caller can consume a draft', async () => {
  const storage = {
    ...device(),
    write() {
      throw new Error('full');
    },
  };
  const box = deviceOutbox<string>(storage, 'alice');
  await assert.rejects(box.stage(row('a')), /full/);
  assert.deepEqual(box.snapshot(), []);
});
