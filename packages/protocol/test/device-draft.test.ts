import assert from 'node:assert/strict';
import test from 'node:test';
import { draftField, draftKey, type DeviceDraftStorage } from '../src/device-draft';

function device(): DeviceDraftStorage {
  const data = new Map<string, string>();
  return {
    read: key => data.get(key) ?? null,
    write(key, value) { if (value === null) data.delete(key); else data.set(key, value); },
  };
}

test('device, profile and account copies remain independent through reopen and clear', () => {
  const a = device(), b = device(), key = draftKey('server', 7, 'chat');
  const open = (store: DeviceDraftStorage, k = key) => {
    const field = draftField<string>(store, k, '');
    field.subscribe(() => {});
    return field;
  };
  open(a).set('phone'); open(b).set('PC');
  assert.equal(open(a).get(), 'phone');
  assert.equal(open(a, draftKey('server', 8, 'chat')).get(), '');
  open(b).set('');
  assert.equal(open(b).get(), '');
  assert.equal(open(a).get(), 'phone');
});

test('late mobile read cannot overwrite new input', async () => {
  let resolve!: (value: string) => void;
  const field = draftField<string>({ read: () => new Promise(r => { resolve = r; }), write() {} }, 'k', '');
  field.subscribe(() => {});
  field.set('edited');
  resolve('"old"'); await Promise.resolve();
  assert.equal(field.get(), 'edited');
});
