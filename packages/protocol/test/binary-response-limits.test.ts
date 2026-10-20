import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { HttpClient, ApiError } from '../src/client';

test('GET and POST preserve exact binary bytes, MIME, and empty files', async () => {
  const bytes = Uint8Array.from([0, 255, 128, 1]);
  const seen: RequestInit[] = [];
  const client = new HttpClient({ baseUrl: 'https://example.test', fetch: async (_url, init) => {
    seen.push(init!); return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
  } });
  for (const result of [await client.getBinary('/get', { maxBytes: 4 }), await client.postBinary('/post', { text: 'synthetic' }, { maxBytes: 4 })]) {
    assert.deepEqual(result.bytes, bytes); assert.equal(result.contentType, 'audio/wav');
  }
  assert.deepEqual(seen.map((x) => x.method), ['GET', 'POST']);
  const empty = new HttpClient({ baseUrl: 'https://example.test', fetch: async () => new Response(null) });
  assert.equal((await empty.getBinary('/empty', { maxBytes: 0 })).bytes.length, 0);
});

test('actual byte cap covers absent and misleading Content-Length and cancels the body', async () => {
  for (const announced of [undefined, '1', '999']) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
    const client = new HttpClient({ baseUrl: 'https://example.test', fetch: async () => new Response(stream, { headers: announced ? { 'Content-Length': announced } : {} }) });
    await assert.rejects(client.getBinary('/large', { maxBytes: 3 }), (error: unknown) => error instanceof ApiError && error.status === 413);
    assert.equal(cancelled, true);
  }
});

test('non-streaming native fetch preserves binary bytes and still checks final size', async () => {
  const data = Uint8Array.from([255, 0, 42]);
  const response = () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }),
    arrayBuffer: async () => data.buffer, body: undefined }) as unknown as Response;
  const client = new HttpClient({ baseUrl: 'https://example.test', fetch: async () => response() });
  assert.deepEqual((await client.getBinary('/native')).bytes, data);
  await assert.rejects(client.getBinary('/native', { maxBytes: 2 }), (e: unknown) => e instanceof ApiError && e.status === 413);
});

test('pre-aborted binary requests never fetch; in-body abort cancels a stalled custom transport', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const never = new HttpClient({ baseUrl: 'https://example.test', fetch: async () => { calls++; return new Response(null); } });
  await assert.rejects(never.getBinary('/pre', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const active = new AbortController();
  let cancelled = false;
  const client = new HttpClient({ baseUrl: 'https://example.test', fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } })) });
  const pending = client.getBinary('/stall', { signal: active.signal });
  setTimeout(() => active.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('deadline covers a real HTTP response body after headers arrive', { timeout: 5000 }, async () => {
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.write('a'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const client = new HttpClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(client.getBinary('/stall', { timeoutMs: 50 }), { name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('401 hook is preserved and error bodies have a finite ceiling', async () => {
  let invalidated = 0;
  const client = new HttpClient({ baseUrl: 'https://example.test', onAuthFailure: () => invalidated++, fetch: async () => new Response('x'.repeat(20 * 1024), { status: 401 }) });
  await assert.rejects(client.getBinary('/denied'), (error: unknown) => error instanceof ApiError && error.status === 401 && (error.body as { code?: string }).code === 'BINARY_ERROR_BODY_TOO_LARGE');
  assert.equal(invalidated, 1);
});

test('late headers are cancelled even if a custom fetch ignores its signal', async () => {
  let resolveHeaders: (response: Response) => void = () => {};
  let cancelled = false;
  const client = new HttpClient({ baseUrl: 'https://example.test', fetch: () => new Promise((resolve) => { resolveHeaders = resolve; }) });
  const abort = new AbortController(); const pending = client.getBinary('/late', { signal: abort.signal });
  abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  resolveHeaders(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cancelled, true);
});

test('JSON upload cancellation remains active after response headers and preserves UTF-8 replies', async () => {
  const baseUrl = 'https://upload-cancel.example.test';
  // Empty multipart dispatch returns a streamed service response through the public API.
  const abort = new AbortController();
  let cancelled = false, ready: () => void = () => {};
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const client = new HttpClient({ baseUrl, fetch: async () => {
    ready();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }));
  } });
  const pending = client.upload('/owned', [], { signal: abort.signal });
  await started; await new Promise((resolve) => setTimeout(resolve, 0)); abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  const bytes = new TextEncoder().encode(JSON.stringify({ message: '정상 완료' }));
  const normal = new HttpClient({ baseUrl, fetch: async () => new Response(new ReadableStream({ start(c) {
    for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close();
  } })) });
  assert.deepEqual(await normal.upload('/owned', []), { message: '정상 완료' });
});
