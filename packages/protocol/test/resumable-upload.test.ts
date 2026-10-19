import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  ResumableUploader,
  UploadUnsupportedError,
  blobSource,
  bytesSource,
  partsFromFormData,
  type ResumeStore,
} from '../src/resumable-upload';
import { sha256HexOfBytes, sha256HexSync } from '../src/sha256';

// ── SHA-256: NIST FIPS 180-4 vectors + random lengths vs node:crypto ─────────

test('pure sha256 matches NIST vectors and node:crypto at every block boundary', async () => {
  const enc = new TextEncoder();
  assert.equal(sha256HexSync(enc.encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256HexSync(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256HexSync(enc.encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 8 * 1024 * 1024 + 3]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const want = createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256HexSync(bytes), want, `length ${n}`);
    assert.equal(await sha256HexOfBytes(bytes), want, `length ${n} (subtle)`);
  }
});

// ── fake gateway ──────────────────────────────────────────────────────────

interface FakeOpts { chunk?: number; unsupported?: 'old' | 'off'; flakyChunks?: number; dispatchRunning?: number; }

function fakeGateway(opts: FakeOpts = {}) {
  const chunk = opts.chunk ?? 4;
  const sessions = new Map<string, { size: number; name: string; type: string; chunks: Map<number, Uint8Array> }>();
  const log: string[] = [];
  let flaky = opts.flakyChunks ?? 0;
  let running = opts.dispatchRunning ?? 0;
  const dispatched: Array<Record<string, unknown>> = [];
  const results = new Map<string, Response>();
  let seq = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input, 'http://gw');
    const method = (init.method ?? 'GET').toUpperCase();
    log.push(`${method} ${url.pathname}`);
    if (opts.unsupported === 'old') return json(502, { success: false, error: 'Unknown service' });
    if (opts.unsupported === 'off') return json(503, { error: { code: 'UPLOAD_UNAVAILABLE' } });
    const h = new Headers(init.headers);

    if (method === 'POST' && url.pathname === '/api/uploads') {
      const b = JSON.parse(String(init.body));
      const id = `u${++seq}`.padEnd(32, '0');
      sessions.set(id, { size: b.size, name: b.filename, type: b.content_type, chunks: new Map() });
      return json(201, { upload_id: id, chunk_size: chunk, total_chunks: Math.ceil(b.size / chunk), size: b.size });
    }
    let m = url.pathname.match(/^\/api\/uploads\/(\w+)\/chunks\/(\d+)$/);
    if (m && method === 'PUT') {
      const s = sessions.get(m[1]);
      if (!s) return json(404, { error: { code: 'UPLOAD_NOT_FOUND' } });
      if (flaky > 0) { flaky--; return json(503, { error: { code: 'UPLOAD_BUSY' } }, { 'Retry-After': '0' }); }
      const body = new Uint8Array(init.body as ArrayBuffer);
      const sha = createHash('sha256').update(body).digest('hex');
      assert.equal(h.get('x-chunk-sha256'), sha, 'client sent the right hash');
      s.chunks.set(Number(m[2]), body);
      return json(200, { received_count: s.chunks.size });
    }
    m = url.pathname.match(/^\/api\/uploads\/(\w+)$/);
    if (m && method === 'GET') {
      const s = sessions.get(m[1]);
      if (!s) return json(404, { error: { code: 'UPLOAD_NOT_FOUND' } });
      return json(200, { upload_id: m[1], chunk_size: chunk, total_chunks: Math.ceil(s.size / chunk), size: s.size,
        received: [...s.chunks.keys()].sort((a, b) => a - b) });
    }
    if (method === 'POST' && url.pathname === '/api/uploads/dispatch') {
      const req = JSON.parse(String(init.body));
      const seen: Record<string, string> = {};
      h.forEach((v, k) => { seen[k] = v; });
      dispatched.push({ ...req, headers: seen });
      const assemble = (id: string) => {
        const s = sessions.get(id)!;
        const out = new Uint8Array(s.size);
        for (const [i, c] of s.chunks) out.set(c, i * chunk);
        return out;
      };
      for (const id of (req.mode === 'raw' ? [req.upload_id] : req.parts.filter((p: { upload_id?: string }) => p.upload_id).map((p: { upload_id: string }) => p.upload_id))) {
        const s = sessions.get(id);
        if (!s) return json(404, { error: { code: 'UPLOAD_NOT_FOUND' } }, { 'x-upload-dispatch': 'error' });
      }
      const payload = req.mode === 'raw'
        ? { raw: new TextDecoder().decode(assemble(req.upload_id)), content_type: req.content_type }
        : { parts: req.parts.map((p: { name: string; upload_id?: string; value?: string; filename?: string }) =>
            p.upload_id ? [p.name, p.filename, createHash('sha256').update(assemble(p.upload_id)).digest('hex')] : [p.name, p.value]) };
      const done = json(200, { path: req.path, query: req.query ?? null, ...payload }, { 'x-upload-dispatch': 'done' });
      if (!req.keep) for (const id of Object.keys(sessions)) void id;
      if (running > 0) {
        running--;
        results.set(req.dispatch_id, done);
        return json(202, { dispatch_id: req.dispatch_id, state: 'running' }, { 'x-upload-dispatch': 'running' });
      }
      return done;
    }
    m = url.pathname.match(/^\/api\/uploads\/dispatch\/([\w-]+)$/);
    if (m && method === 'GET') {
      const r = results.get(m[1]);
      return r ?? json(404, { error: { code: 'DISPATCH_NOT_FOUND' } }, { 'x-upload-dispatch': 'error' });
    }
    if (method === 'DELETE') { sessions.delete(url.pathname.split('/').pop()!); return json(200, {}); }
    return json(500, { unexpected: url.pathname });
  };
  return { fetchImpl, log, sessions, dispatched };
}

const noSleep = async () => {};

function memoryStore(): ResumeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), delete: (k) => void data.delete(k) };
}

// ── engine ────────────────────────────────────────────────────────────────

test('multipart send keeps field/file order, filenames and reports byte progress', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep,
    headers: () => ({ Authorization: 'Bearer t' }) });
  const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])], '보고서 "최종".pdf', { type: 'application/pdf' });
  const form = new FormData();
  form.append('collection_name', '내 컬렉션');
  form.append('file', file);
  form.append('user_id', '7');
  const progress: number[] = [];
  const res = await up.send({ path: '/api/retrieval/documents/upload-sse?x=1' }, { parts: partsFromFormData(form) },
    { headers: { 'X-Approval-Line': '{"line_id":1}', 'content-type': 'multipart/form-data' }, onProgress: (p) => progress.push(p.loaded) });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.path, '/api/retrieval/documents/upload-sse');
  assert.equal(j.query, 'x=1');
  assert.deepEqual(j.parts.map((p: string[]) => p[0]), ['collection_name', 'file', 'user_id']);
  assert.equal(j.parts[1][1], '보고서 "최종".pdf');
  assert.equal(j.parts[1][2], createHash('sha256').update(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).digest('hex'));
  assert.equal(progress.at(-1), 10);
  const d = gw.dispatched[0] as { headers: Record<string, string> };
  assert.equal(d.headers['x-approval-line'], '{"line_id":1}', 'original headers ride along');
  assert.equal(d.headers['content-type'], 'application/json', 'no duplicated multipart content-type');
  assert.equal(d.headers['authorization'], 'Bearer t');
});

test('raw mode sends the body itself (base64 JSON payloads)', async () => {
  const gw = fakeGateway({ chunk: 5 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep });
  const body = new TextEncoder().encode(JSON.stringify({ path: 'a.txt', content_b64: 'QUJD' }));
  const res = await up.send({ method: 'PUT', path: '/api/agentflow/geny-workspace/wf/ide/file' },
    { raw: bytesSource(body, 'body.json', 'application/json') });
  const j = await res.json();
  assert.deepEqual(JSON.parse(j.raw), { path: 'a.txt', content_b64: 'QUJD' });
  assert.equal(j.content_type, 'application/json');
  assert.equal((gw.dispatched[0] as { method: string }).method, 'PUT');
});

test('transient chunk failures are retried and a reload resumes from the stored session', async () => {
  const gw = fakeGateway({ chunk: 4, flakyChunks: 2 });
  const store = memoryStore();
  const data = new Uint8Array(17).map((_, i) => i);
  const src = () => bytesSource(data, 'a.bin');

  // First attempt: abort after the first chunk lands.
  const ctl = new AbortController();
  const up1 = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep, store, concurrency: 1 });
  await assert.rejects(up1.upload(src(), { signal: ctl.signal, onProgress: (n) => { if (n >= 4) ctl.abort(); } }),
    (e: Error) => e.name === 'AbortError');
  assert.equal(store.data.size, 1, 'upload id remembered');
  const [id] = [...store.data.values()];
  const before = gw.sessions.get(id)!.chunks.size;
  assert.ok(before >= 1);

  // "Reload": a new uploader with the same store continues — chunks already there are not sent again.
  const puts = () => gw.log.filter((l) => l.startsWith('PUT')).length;
  const putsBefore = puts();
  const up2 = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep, store });
  const s = await up2.upload(src());
  assert.equal(s.upload_id, id);
  assert.equal(gw.sessions.get(id)!.chunks.size, 5);
  assert.equal(puts() - putsBefore, 5 - before, 'only the missing chunks were sent');
});

test('the same file object is not sent again after a 409/428 retry', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep });
  const file = new File([new Uint8Array(9)], 'c.bin');
  await up.send({ path: '/api/filestore/items/upload' }, { parts: [{ name: 'file', source: blobSource(file) }] }, { keep: true });
  const puts = gw.log.filter((l) => l.startsWith('PUT')).length;
  await up.send({ path: '/api/filestore/items/upload?on_conflict=overwrite' }, { parts: [{ name: 'file', source: blobSource(file) }] });
  assert.equal(gw.log.filter((l) => l.startsWith('PUT')).length, puts, 'no re-upload');
  assert.equal(gw.log.filter((l) => l.startsWith('POST /api/uploads/dispatch')).length, 2);
});

test('a long dispatch is followed to its result', async () => {
  const gw = fakeGateway({ dispatchRunning: 1 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep });
  const res = await up.send({ path: '/api/x/y' }, { parts: [{ name: 'file', source: bytesSource(new Uint8Array(3)) }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upload-dispatch'), 'done');
  assert.ok(gw.log.some((l) => l.startsWith('GET /api/uploads/dispatch/')));
});

test('an expired session is uploaded again and the request resent once', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep });
  const file = new File([new Uint8Array(6)], 'e.bin');
  await up.send({ path: '/api/a/b' }, { parts: [{ name: 'file', source: blobSource(file) }] }, { keep: true });
  gw.sessions.clear(); // gateway swept the staged chunks
  const res = await up.send({ path: '/api/a/b' }, { parts: [{ name: 'file', source: blobSource(file) }] });
  assert.equal(res.status, 200);
});

test('an old gateway is detected and remembered so callers fall back to the direct request', async () => {
  for (const kind of ['old', 'off'] as const) {
    const gw = fakeGateway({ unsupported: kind });
    const base = `http://gw-${kind}`;
    const up = new ResumableUploader({ baseUrl: base, fetch: gw.fetchImpl, sleep: noSleep });
    await assert.rejects(up.send({ path: '/api/a/b' }, { parts: [{ name: 'f', source: bytesSource(new Uint8Array(1)) }] }),
      UploadUnsupportedError);
    assert.equal(ResumableUploader.knownUnsupported(base), true);
    const calls = gw.log.length;
    await assert.rejects(up.send({ path: '/api/a/b' }, { parts: [] }), UploadUnsupportedError);
    assert.equal(gw.log.length, calls, 'no second probe');
  }
});

test('empty files and field-only forms work', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: gw.fetchImpl, sleep: noSleep });
  const res = await up.send({ path: '/api/a/b' }, { parts: [
    { name: 'file', source: bytesSource(new Uint8Array(0), 'empty.txt', 'text/plain') },
    { name: 'note', value: 'x' },
  ] });
  const j = await res.json();
  assert.equal(j.parts[0][1], 'empty.txt');
  assert.deepEqual(j.parts[1], ['note', 'x']);
});

// ── HttpClient: every upload goes chunked, old gateways get the single request ──

import { ApiError, HttpClient } from '../src/client';

test('HttpClient.upload sends files chunked with auth and returns the service JSON', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const http = new HttpClient({ baseUrl: 'http://gw-http', fetch: (u, i) => gw.fetchImpl(u.replace('http://gw-http', 'http://gw'), i) });
  http.setToken('tok');
  const seen: number[] = [];
  const out = await http.upload<{ parts: string[][] }>('/api/agentflow/geny-workspace/wf/storage/upload?subdir=uploads',
    [{ name: 'file', file: new Uint8Array(10), filename: '큰 영상.mp4', type: 'video/mp4' }],
    { onProgress: (p) => seen.push(p.loaded) });
  assert.equal(out.parts[0][1], '큰 영상.mp4');
  assert.equal(seen.at(-1), 10);
  assert.ok(gw.log.filter((l) => l.startsWith('PUT')).length === 3, '10 bytes in 4-byte chunks');
  assert.equal((gw.dispatched[0] as { headers: Record<string, string> }).headers['authorization'], 'Bearer tok');
});

test('fetch is called without a receiver (a browser fetch throws Illegal invocation otherwise)', async () => {
  // A browser's fetch only works with the window (or nothing) as `this`. Stand one in for the global fetch,
  // then use the defaults (no `fetch` option) and also hand that fetch over directly, as a host might.
  const gw = fakeGateway({ chunk: 4 });
  const strictFetch = function (this: unknown, input: string, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return gw.fetchImpl(input.replace('http://gw-http', 'http://gw'), init);
  };
  const saved = globalThis.fetch;
  globalThis.fetch = strictFetch as typeof fetch;
  try {
    const up = new ResumableUploader({ baseUrl: 'http://gw', sleep: noSleep });
    const res = await up.send({ path: '/api/retrieval/file/upload' }, { raw: bytesSource(new Uint8Array(10), 'a.bin') });
    assert.equal(res.status, 200);

    const http = new HttpClient({ baseUrl: 'http://gw-http' });
    const out = await http.upload<{ parts: string[][] }>('/api/retrieval/file/upload',
      [{ name: 'file', file: new Uint8Array(10), filename: '광고시안.mp4', type: 'video/mp4' }]);
    assert.equal(out.parts[0][1], '광고시안.mp4');
  } finally {
    globalThis.fetch = saved;
  }
  const passed = new HttpClient({ baseUrl: 'http://gw-http', fetch: strictFetch as typeof fetch });
  const out = await passed.upload<{ parts: string[][] }>('/api/retrieval/file/upload',
    [{ name: 'file', file: new Uint8Array(10), filename: 'b.bin' }]);
  assert.equal(out.parts[0][1], 'b.bin');
});

test('HttpClient falls back to one direct request on a gateway without /api/uploads', async () => {
  const calls: Array<{ url: string; body: unknown; type: string | null }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: init.body, type: new Headers(init.headers).get('content-type') });
    if (url.includes('/api/uploads')) return new Response('{"success":false,"error":"Unknown service"}', { status: 502 });
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const http = new HttpClient({ baseUrl: 'http://old-gw', fetch: fetchImpl });
  assert.deepEqual(await http.upload('/api/a/b', [{ name: 'file', file: new Uint8Array([1, 2]), filename: 'a.bin' },
    { name: 'note', value: 'x' }]), { ok: true });
  const direct = calls.at(-1)!;
  assert.equal(direct.url, 'http://old-gw/api/a/b');
  assert.ok(direct.body instanceof FormData);
  assert.equal((direct.body as FormData).get('note'), 'x');
  assert.equal(((direct.body as FormData).get('file') as File).name, 'a.bin');

  // raw body (IDE save / preview image) also falls back, with its content type.
  await http.uploadBody('PUT', '/api/ide/file', new TextEncoder().encode('{"a":1}'), 'application/json');
  assert.equal(calls.at(-1)!.type, 'application/json');
  assert.equal(calls.filter((c) => c.url.includes('/api/uploads')).length, 1, 'probed once, then remembered');
});

test('a gateway refusal becomes an ApiError with its message (e.g. over 1 GiB)', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ success: false,
    detail: { code: 'UPLOAD_TOO_LARGE', message: '파일이 1GiB 를 넘습니다.' } }), { status: 413 });
  const http = new HttpClient({ baseUrl: 'http://gw-413', fetch: fetchImpl });
  await assert.rejects(http.upload('/api/a/b', [{ name: 'file', file: new Uint8Array(1), filename: 'x' }]),
    (e: unknown) => e instanceof ApiError && e.status === 413
      && (e.body as { detail: { message: string } }).detail.message === '파일이 1GiB 를 넘습니다.');
});

test('a React Native {uri} file uses the host source, or goes direct without one', async () => {
  const gw = fakeGateway({ chunk: 4 });
  const fetchImpl = (u: string, i?: RequestInit) => gw.fetchImpl(u.replace(/http:\/\/gw-rn\d/, 'http://gw'), i);
  const data = new Uint8Array([9, 8, 7, 6, 5]);
  const withSource = new HttpClient({ baseUrl: 'http://gw-rn1', fetch: fetchImpl,
    uriSource: (ref, filename, type) => ({ ...bytesSource(data, filename, type), lastModified: ref.uri.length }) });
  const out = await withSource.upload<{ parts: string[][] }>('/api/a/b',
    [{ name: 'file', file: { uri: 'file:///cache/v.mov' }, filename: 'v.mov', type: 'video/quicktime' }]);
  assert.equal(out.parts[0][2], createHash('sha256').update(data).digest('hex'));

  const direct: unknown[] = [];
  const noSource = new HttpClient({ baseUrl: 'http://gw-rn2', fetch: async (_u, i) => {
    direct.push(i?.body);
    return new Response('{}', { status: 200 });
  } });
  await noSource.upload('/api/a/b', [{ name: 'file', file: { uri: 'file:///cache/v.mov' }, filename: 'v.mov', type: 'video/quicktime' }]);
  assert.equal(direct.length, 1, 'no chunk protocol without a ranged-read source');
});

test('a request whose response never starts is abandoned and retried (a stalled link does not hang the upload)', async () => {
  const gw = fakeGateway({ chunk: 4 });
  let stalls = 1;
  const fetchImpl = (url: string, init: RequestInit = {}) => {
    if (stalls > 0 && (init.method ?? 'GET') === 'PUT') {
      stalls--;
      // Never answers; only the abort ends it.
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return gw.fetchImpl(url, init);
  };
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: fetchImpl, sleep: noSleep, timeouts: { chunk: 20 } });
  const res = await up.send({ path: '/api/a/b' }, { parts: [{ name: 'file', source: bytesSource(new Uint8Array(6)) }] });
  assert.equal(res.status, 200);
  assert.equal(stalls, 0);
});

test('the caller can still cancel while a request is waiting', async () => {
  const fetchImpl = (_url: string, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const up = new ResumableUploader({ baseUrl: 'http://gw-stall', fetch: fetchImpl, sleep: noSleep });
  const ctl = new AbortController();
  const p = up.send({ path: '/api/a/b' }, { parts: [{ name: 'file', source: bytesSource(new Uint8Array(1)) }] }, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
});

test('cross-origin: the "running" marker header is hidden, the 202 body still says so', async () => {
  const gw = fakeGateway({ dispatchRunning: 1 });
  // A browser hides non-exposed headers on cross-origin responses.
  const hide = async (u: string, i?: RequestInit) => {
    const r = await gw.fetchImpl(u, i);
    const h = new Headers(r.headers);
    h.delete('x-upload-dispatch');
    return new Response(r.body, { status: r.status, headers: h });
  };
  const up = new ResumableUploader({ baseUrl: 'http://gw', fetch: hide, sleep: noSleep });
  const res = await up.send({ path: '/api/x/y' }, { parts: [{ name: 'file', source: bytesSource(new Uint8Array(3)) }] });
  assert.equal(res.status, 200);
  assert.ok(gw.log.some((l) => l.startsWith('GET /api/uploads/dispatch/')));
});
