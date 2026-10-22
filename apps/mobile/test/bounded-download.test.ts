import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedDownload, type NativeDownloadPort } from '../src/lib/bounded-download';

function fixture(size = 3) {
  let progress: (written: number, expected: number) => void = () => {};
  let resolve: (result: { uri: string; status: number } | undefined) => void = () => {};
  let starts = 0, cancels = 0, removes = 0;
  const port: NativeDownloadPort = {
    create(callback) {
      progress = callback;
      return {
        downloadAsync() { starts++; return new Promise((done) => { resolve = done; }); },
        async cancelAsync() { cancels++; },
      };
    },
    async size() { return size; },
    async remove() { removes++; },
  };
  return {
    port,
    progress: (written: number, expected = -1) => progress(written, expected),
    finish: (status = 200) => resolve({ uri: 'file:///private-cache/owned.bin', status }),
    counts: () => ({ starts, cancels, removes }),
  };
}

test('native download keeps exact-size legitimate and empty files', async () => {
  for (const size of [0, 3]) {
    const f = fixture(size);
    const result = boundedDownload(f.port, { maxBytes: size });
    f.finish();
    assert.equal(await result, 'file:///private-cache/owned.bin');
    assert.deepEqual(f.counts(), { starts: 1, cancels: 0, removes: 0 });
  }
});

test('pre-aborted native download does not start; in-flight abort removes late results', async () => {
  const pre = new AbortController(); pre.abort();
  const unopened = fixture();
  await assert.rejects(boundedDownload(unopened.port, { maxBytes: 3, signal: pre.signal }), { name: 'AbortError' });
  assert.equal(unopened.counts().starts, 0);
  const f = fixture(), controller = new AbortController();
  const result = boundedDownload(f.port, { maxBytes: 3, signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.ok(f.counts().cancels > 0);
  const before = f.counts().removes;
  f.finish(); await Promise.resolve(); await Promise.resolve();
  assert.ok(f.counts().removes > before, 'late native file is discarded');
});

test('announced/actual progress and final stat independently reject oversized native files', async () => {
  for (const mode of ['announced', 'written', 'final']) {
    const f = fixture(4);
    const result = boundedDownload(f.port, { maxBytes: 3 });
    if (mode === 'announced') f.progress(1, 4);
    else if (mode === 'written') f.progress(4);
    else f.finish();
    await assert.rejects(result, /limit|oversized/);
    assert.ok(f.counts().removes > 0);
  }
});

test('native body deadline and non-success status discard the cache file', async () => {
  const stalled = fixture();
  await assert.rejects(boundedDownload(stalled.port, { maxBytes: 3, timeoutMs: 10 }), { name: 'AbortError' });
  assert.ok(stalled.counts().removes > 0);
  for (const status of [302, 401, 500]) {
    const f = fixture();
    const result = boundedDownload(f.port, { maxBytes: 3 }); f.finish(status);
    await assert.rejects(result, /download failed/);
    assert.ok(f.counts().removes > 0);
  }
});
