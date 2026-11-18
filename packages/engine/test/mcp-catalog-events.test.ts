/** 카탈로그 사용 기록 — 거르기 · 가리기 · 묶어 보내기 · 다시 보내기 · 보관. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogEventIn } from '@dex/protocol/mcp-catalog';
import {
  CatalogEventReporter,
  fileEventStorage,
  memoryEventStorage,
  sanitizeCatalogEvent,
  scrubCatalogMessage,
} from '../src/mcp-catalog-events';
import { McpSecretRedactor } from '../src/mcp-redaction';

const ev = (over: Partial<CatalogEventIn> = {}): CatalogEventIn => ({
  ts: new Date().toISOString(),
  catalog_id: 'filesystem',
  revision: 2,
  event: 'install_started',
  ok: true,
  ...over,
});

test('거르기: 계약 밖 이름 · catalog_id 없음은 버리고, 허용 필드만 남긴다', () => {
  assert.equal(sanitizeCatalogEvent(ev({ event: 'install_failed' as never })), null);
  assert.equal(sanitizeCatalogEvent(ev({ catalog_id: '' })), null);
  const out = sanitizeCatalogEvent({
    ...ev(),
    // 실수로 섞여 들어온 값들
    ...({ values: { API_TOKEN: 'x' }, args: ['--root', '/a'], tool_result: 'secret' } as object),
    detail: { stage: 'test', nested: { a: 1 } as never, 'bad key': 'x', ok: true },
    duration_ms: 12.6,
    tool_count: -1,
  } as CatalogEventIn)!;
  assert.deepEqual(Object.keys(out).sort(), [
    'catalog_id',
    'detail',
    'duration_ms',
    'event',
    'ok',
    'revision',
    'ts',
  ]);
  assert.deepEqual(out.detail, { stage: 'test', ok: true });
  assert.equal(out.duration_ms, 13);
});

test('가리기: 설치 비밀 값 · Bearer · KEY=값 · 긴 토큰 · URL 자격/쿼리 · 홈 경로, 500자', () => {
  const r = new McpSecretRedactor({ env: { API_TOKEN: 'hunter2-very-secret' } });
  const msg = scrubCatalogMessage(
    `failed hunter2-very-secret Authorization: Bearer abcdef123456 GITHUB_TOKEN=ghp_abc ` +
      `https://user:pw@host/x?key=1 ${'Z'.repeat(40)} at ${homedir()}/project`,
    r,
  );
  assert.ok(!msg.includes('hunter2'));
  assert.ok(!msg.includes('abcdef123456'));
  assert.ok(!msg.includes('ghp_abc'));
  assert.ok(!msg.includes('user:pw'));
  assert.ok(!msg.includes('key=1'));
  assert.ok(!msg.includes('Z'.repeat(40)));
  assert.ok(msg.includes('~/project'));
  assert.equal(scrubCatalogMessage('x'.repeat(2000).replace(/x/g, 'ab ')).length, 500);
});

test('묶어 보내기: 250개 → 100 · 100 · 50, 보낸 것은 큐에서 빠지고 파일에도 반영', async () => {
  const storage = memoryEventStorage();
  const batches: number[] = [];
  const rep = new CatalogEventReporter({
    storage,
    send: async (events) => {
      batches.push(events.length);
      return events.length;
    },
    canSend: () => true,
    intervalMs: 60_000,
  });
  for (let i = 0; i < 250; i++) rep.enqueue(ev({ duration_ms: i }));
  assert.equal(rep.size(), 250);
  await rep.flush();
  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(rep.size(), 0);
  assert.deepEqual(storage.load(), []);
});

test('실패하면 큐에 남기고(다시 보냄), 400 은 버린다(영구 거절)', async () => {
  let mode: 'down' | 'bad' | 'up' = 'down';
  const sent: CatalogEventIn[][] = [];
  const rep = new CatalogEventReporter({
    storage: memoryEventStorage(),
    send: async (events) => {
      if (mode === 'down') throw Object.assign(new Error('network'), { status: 0 });
      if (mode === 'bad') throw Object.assign(new Error('bad request'), { status: 400 });
      sent.push(events);
      return events.length;
    },
    canSend: () => true,
    intervalMs: 60_000,
  });
  rep.enqueue(ev());
  rep.enqueue(ev({ event: 'install_completed' }));
  await rep.flush();
  assert.equal(rep.size(), 2, '네트워크 실패는 남긴다');
  assert.match(rep.lastError ?? '', /network/);
  mode = 'bad';
  await rep.flush();
  assert.equal(rep.size(), 0, '400 은 다시 보내도 같으므로 버린다');
  assert.equal(rep.dropped, 2);
  mode = 'up';
  rep.enqueue(ev({ event: 'server_enabled' }));
  await rep.flush();
  assert.equal(sent.length, 1);
  rep.stop();
});

test('로그인 전(canSend=false)에는 보내지 않고 쌓아 둔다', async () => {
  let online = false;
  let calls = 0;
  const rep = new CatalogEventReporter({
    storage: memoryEventStorage(),
    send: async (e) => {
      calls++;
      return e.length;
    },
    canSend: () => online,
    intervalMs: 60_000,
  });
  rep.enqueue(ev());
  await rep.flush();
  assert.equal(calls, 0);
  assert.equal(rep.size(), 1);
  online = true;
  await rep.flush();
  assert.equal(calls, 1);
  rep.stop();
});

test('상한: 오래된 것부터 버린다', () => {
  const rep = new CatalogEventReporter({
    storage: memoryEventStorage(),
    send: async () => 0,
    canSend: () => false,
    maxQueue: 5,
  });
  for (let i = 0; i < 8; i++) rep.enqueue(ev({ duration_ms: i }));
  assert.equal(rep.size(), 5);
  assert.deepEqual(
    rep.pending().map((e) => e.duration_ms),
    [3, 4, 5, 6, 7],
  );
  assert.equal(rep.dropped, 3);
});

test('파일 보관: 재시작해도 남은 이벤트를 다시 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dex-catalog-events-'));
  try {
    const path = join(dir, 'events.json');
    const a = new CatalogEventReporter({
      storage: fileEventStorage(path),
      send: async () => 0,
      canSend: () => false,
    });
    a.enqueue(ev({ event: 'server_removed' }));
    assert.match(readFileSync(path, 'utf8'), /server_removed/);
    const b = new CatalogEventReporter({
      storage: fileEventStorage(path),
      send: async () => 0,
      canSend: () => false,
    });
    assert.equal(b.size(), 1);
    assert.equal(b.pending()[0].event, 'server_removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('주기 보내기: start 후 간격마다 보낸다', async () => {
  let sent = 0;
  const rep = new CatalogEventReporter({
    storage: memoryEventStorage(),
    send: async (e) => {
      sent += e.length;
      return e.length;
    },
    canSend: () => true,
    intervalMs: 10,
  });
  rep.start();
  rep.enqueue(ev());
  rep.enqueue(ev());
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent, 2);
  rep.stop();
});

test('묶음 하나가 400 이면 한 건씩 다시 보내 틀린 것만 버린다', async () => {
  const delivered: string[] = [];
  const rep = new CatalogEventReporter({
    storage: memoryEventStorage(),
    send: async (events) => {
      if (events.some((e) => e.server_name === 'bad'))
        throw Object.assign(new Error('400'), { status: 400 });
      delivered.push(...events.map((e) => e.server_name ?? ''));
      return events.length;
    },
    canSend: () => true,
    intervalMs: 60_000,
  });
  rep.enqueue(ev({ server_name: 'a' }));
  rep.enqueue(ev({ server_name: 'bad' }));
  rep.enqueue(ev({ server_name: 'c' }));
  await rep.flush();
  assert.deepEqual(delivered, ['a', 'c']);
  assert.equal(rep.size(), 0);
  assert.equal(rep.dropped, 1);
});

test('detail 이 2KB 에 가까우면 통째로 뺀다', () => {
  const detail = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`k${i}`, 'é'.repeat(119) + ' ']),
  );
  const out = sanitizeCatalogEvent(ev({ detail }))!;
  assert.ok(!out.detail || JSON.stringify(out.detail).length <= 1800);
});
