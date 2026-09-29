/**
 * 이 PC 의 폴더 장부 ↔ 서버의 대화 폴더 사본(main/chat-folder-sync).
 *
 * 한 대화의 폴더는 기기 하나에 모인다. 다른 기기에 있으면 더하지 않고(창이 옮기기를 묻는다),
 * 옮기면 가져오고, 꺼져 있던 사이 옮겨 간 대화는 잊는다. 서버가 시켜서 잊은 것은 다시 올리지
 * 않는다 — 올리면 다른 기기의 연결을 덮는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatFolderSync, type FolderLedger } from '../src/main/chat-folder-sync';
import type { LocalFolder } from '@dex/engine/local-folders';

const ME = { deviceId: 'desk-b', deviceName: '집 PC · 데스크톱', devicePlatform: 'darwin' };
const A_STATE = {
  interactionId: 'chat_1',
  device: { deviceId: 'desk-a', name: '사무실 PC', platform: 'win32', online: true },
  folders: [{ id: 'f1', name: 'report' }],
  updatedAt: '',
};
const DOCS: LocalFolder = { id: 'd', name: 'docs', path: '/Users/me/docs' };

function ledger(initial: Record<string, LocalFolder[]> = {}) {
  const book: Record<string, LocalFolder[]> = { ...initial };
  const changes: string[] = [];
  let sync: ChatFolderSync | null = null;
  const published: string[] = [];
  const l: FolderLedger<LocalFolder> = {
    list: (id) => book[id] ?? [],
    set: (id, folders) => {
      book[id] = folders;
      changes.push(id);
      if (sync && !sync.isQuiet(id)) published.push(id);
      return folders;
    },
    forget: (id) => {
      delete book[id];
      changes.push(id);
      if (sync && !sync.isQuiet(id)) published.push(id);
    },
    entries: () => Object.entries(book).map(([interactionId, folders]) => ({ interactionId, folders })),
    accountId: () => 'u7',
  };
  return { l, book, changes, published, bind: (s: ChatFolderSync) => (sync = s) };
}

function api(reply: { put?: unknown; reconcile?: unknown; get?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    api: {
      get: async (...args: unknown[]) => (calls.push({ method: 'get', args }), reply.get ?? null),
      put: async (...args: unknown[]) => (calls.push({ method: 'put', args }), reply.put ?? { ok: true, state: A_STATE }),
      reconcile: async (...args: unknown[]) => (calls.push({ method: 'reconcile', args }), reply.reconcile ?? { drop: [] }),
    },
  };
}

test('다른 기기에 폴더가 있는 대화에는 더하지 않고 그 기기를 돌려준다', async () => {
  const led = ledger();
  const fake = api({ put: { ok: false, code: 'other_device', state: A_STATE } });
  const sync = new ChatFolderSync({ api: () => fake.api as never, ledger: led.l, device: () => ME });
  const out = await sync.add('chat_1', [DOCS]);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.state.device?.name, '사무실 PC');
  assert.deepEqual(led.book, {}, '이 PC 장부에 더하지 않았다');
});

test('옮기기는 take_over 로 올리고 장부에 적되 다시 올리지 않는다', async () => {
  const led = ledger();
  const fake = api({});
  const sync = new ChatFolderSync({ api: () => fake.api as never, ledger: led.l, device: () => ME });
  led.bind(sync);
  const out = await sync.add('chat_1', [DOCS], { takeOver: true });
  assert.equal(out.ok, true);
  assert.deepEqual(led.book.chat_1, [DOCS]);
  const put = fake.calls.find((c) => c.method === 'put')!;
  assert.deepEqual(put.args[3], { takeOver: true });
  assert.deepEqual(led.published, [], '이미 올렸다 — 메아리가 없다');
});

test('서버에 닿지 않으면(옛 서버·오프라인) 이 PC 의 일은 막지 않는다', async () => {
  const led = ledger();
  const sync = new ChatFolderSync({ api: () => null, ledger: led.l, device: () => ME });
  assert.equal((await sync.add('chat_1', [DOCS])).ok, true);
  assert.deepEqual(led.book.chat_1, [DOCS]);
});

test('켜질 때 장부 전체를 올리고 옮겨 간 대화는 조용히 잊는다(계정마다 한 번)', async () => {
  const led = ledger({ chat_1: [DOCS], chat_2: [DOCS] });
  const fake = api({ reconcile: { drop: ['chat_2'] } });
  const sync = new ChatFolderSync({ api: () => fake.api as never, ledger: led.l, device: () => ME });
  led.bind(sync);
  await sync.reconcile();
  assert.ok(led.book.chat_1 && !led.book.chat_2);
  assert.deepEqual(led.published, [], '잊은 것을 다시 올리면 다른 기기의 연결을 덮는다');
  const conversations = (fake.calls[0].args[1] as { interactionId: string }[]).map((c) => c.interactionId);
  assert.deepEqual(conversations.sort(), ['chat_1', 'chat_2']);
  await sync.reconcile();
  assert.equal(fake.calls.filter((c) => c.method === 'reconcile').length, 1, '같은 계정에서는 한 번');
});

test('다른 기기가 이 대화를 가져갔다는 알림이 오면 이 PC 는 잊는다', () => {
  const led = ledger({ chat_1: [DOCS] });
  const sync = new ChatFolderSync({ api: () => null, ledger: led.l, device: () => ME });
  led.bind(sync);
  assert.equal(sync.onServerFolders(A_STATE), true);
  assert.deepEqual(led.book, {});
  assert.deepEqual(led.published, []);
  // 자기 것이면 그대로
  const mine = { ...A_STATE, device: { ...A_STATE.device, deviceId: 'desk-b' } };
  led.book.chat_1 = [DOCS];
  assert.equal(sync.onServerFolders(mine), false);
  assert.deepEqual(led.book.chat_1, [DOCS]);
});
