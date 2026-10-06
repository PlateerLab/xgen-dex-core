import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DexError } from '@dex/engine';
import { NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import { createDesktopNativeFetch } from '../src/main/native-session-network';

test('Desktop HTTPS frames DELETE bodies and never retries proofs or rotation, follows redirects, or bypasses TLS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dex-desktop-tls-'));
  const key = join(directory, 'key.pem'); const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const counts = new Map<string, number>(); let body = ''; let rawBody = Buffer.alloc(0); let length: string | undefined;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const path = req.url!; counts.set(path, (counts.get(path) ?? 0) + 1);
    assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.origin, undefined);
    if (path === '/disconnect-get' || path === '/disconnect-post') { req.socket.destroy(); return; }
    if (path === '/redirect') { res.writeHead(302, { Location: '/followed' }); res.end(); return; }
    if (path === '/large') { res.end(Buffer.alloc(2 * 1024 * 1024 + 1)); return; }
    if (path === '/abort') return;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { rawBody = Buffer.concat(chunks); body = rawBody.toString(); length = req.headers['content-length']; res.writeHead(204); res.end(); });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `https://localhost:${address.port}`;
    const fetch = createDesktopNativeFetch(() => [readFileSync(cert, 'utf8')]);
    const init = { credentials: 'omit', redirect: 'error' } as const;
    const payload = JSON.stringify({ password: '테스트 전용 값' });
    assert.equal((await fetch(`${origin}/delete`, { ...init, method: 'DELETE', body: payload,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1', 'Transfer-Encoding': 'chunked' } })).status, 204);
    assert.equal(body, payload); assert.equal(length, String(Buffer.byteLength(payload)));
    const contentPath = '/api/agentflow/agent-sessions/018f1240-0000-7000-8000-000000000001/attachments/018f1240-0000-7000-8000-000000000002/content';
    const bytes = Uint8Array.from([0, 255, 128, 10]);
    const binaryFetch = createDesktopNativeFetch(() => { bytes.fill(5); return [readFileSync(cert, 'utf8')]; });
    assert.equal((await binaryFetch(origin + contentPath, { ...init, method: 'PUT', body: bytes,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1', 'Transfer-Encoding': 'chunked' } })).status, 204);
    assert.deepEqual([...rawBody], [0, 255, 128, 10]); assert.equal(length, '4');
    assert.equal((await fetch(origin + contentPath, { ...init, method: 'PUT', body: new Uint8Array(),
      headers: { 'Content-Type': 'application/octet-stream' } })).status, 204);
    assert.equal(length, '0'); assert.equal(rawBody.length, 0);
    for (const [url, changes] of [
      [origin + '/invalid', {}], [origin + contentPath + '?x=1', {}],
      [origin + contentPath, { method: 'POST' }], [origin + contentPath, { headers: { 'Content-Type': 'text/plain' } }],
    ] as const) {
      await assert.rejects(fetch(url, { ...init, method: 'PUT', body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' }, ...changes }), DexError);
    }
    for (const [path, method] of [['/disconnect-get', 'GET'], ['/disconnect-post', 'POST']] as const) {
      await assert.rejects(fetch(origin + path, { ...init, method, ...(method === 'POST' ? { body: '{}' } : {}),
        headers: { DPoP: 'one-use-test-proof' } }), NativePlatformTransportError);
      assert.equal(counts.get(path), 1, 'A failed attempt must return to the journal/watcher without transport retry');
    }
    await assert.rejects(fetch(`${origin}/redirect`, init), NativePlatformTransportError);
    assert.equal(counts.get('/followed'), undefined);
    await assert.rejects(fetch(`${origin}/large`, init), NativePlatformTransportError);
    await assert.rejects(createDesktopNativeFetch(() => [])(`${origin}/untrusted`, init), NativePlatformTransportError);
    assert.equal(counts.get('/untrusted'), undefined);
    for (const headers of [{ Cookie: 'session=test' }, { Origin: origin }] as Record<string, string>[]) {
      await assert.rejects(fetch(`${origin}/invalid`, { ...init, headers }), (e: unknown) => e instanceof DexError && e.code === 'usage_error');
    }
    await assert.rejects(fetch(`${origin}/invalid`, { ...init, credentials: 'include' }), DexError);
    await assert.rejects(fetch(`http://localhost:${address.port}/invalid`, init), DexError);
    assert.equal(counts.get('/invalid'), undefined);
    const controller = new AbortController(); const pending = fetch(`${origin}/abort`, { ...init, signal: controller.signal });
    controller.abort(); await assert.rejects(pending, (e: unknown) => e instanceof Error && e.name === 'AbortError');
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
