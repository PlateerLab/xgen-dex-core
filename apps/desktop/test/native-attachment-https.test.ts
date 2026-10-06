import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeDeviceKeyStore } from '@dex/engine';
import { nativeKeyThumbprint } from '@dex/engine/native-dpop';
import { AgentTurnComposer, AgentTurnComposeFailure } from '@dex/protocol/agent-turn-composer';
import type { NativeAttachmentDraftView } from '@dex/rpc';
import { readSelectedNativeAttachments } from '../src/main/native-attachment-files';
import { DesktopNativeSessions } from '../src/main/native-session';
import { createDesktopNativeFetch } from '../src/main/native-session-network';

test('real HTTPS selected files recover a lost PUT then retry the original ordered attachment turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-attachment-https-'));
  const keyPath = join(directory, 'key.pem'); const certPath = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const device = '018f1240-0000-7000-8000-000000000001'; const loginSid = '018f1240-0000-7000-8000-000000000002';
  const sessionId = '018f1240-0000-7000-8000-000000000003'; const turnId = '018f1240-0000-7000-8000-000000000004';
  const challenge = Buffer.alloc(32, 5).toString('base64url');
  let origin = ''; let publicKey: JsonWebKey; let access = ''; let registered = false; let host: DesktopNativeSessions | undefined;
  let firstPut = true; let firstTurn = true; let originalTurn: unknown;
  const seenProofs = new Set<string>(); const calls: string[] = []; const failures: unknown[] = [];
  const reservations = new Map<string, { id: string; metadata: Record<string, any> }>();
  const uploaded = new Map<string, Record<string, unknown>>(); const turnRequests: unknown[] = [];
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
    try {
      const path = request.url!; calls.push(`${request.method} ${path}`);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
      };
      const body = request.headers['content-type'] === 'application/json' ? JSON.parse(bytes.toString() || '{}') : {};
      assert.equal(request.headers.cookie, undefined);
      if (path === '/api/auth/login') return json(200, { success: true, user_id: '7', access_token: 'e30.e30.c2ln' });
      if (path === '/api/auth/logout') return json(200, { success: true });
      if (path.includes('/registration/status/')) return json(200, registered ? { device_id: device, state: 'trusted' } : null);
      if (path.endsWith('/registration/challenge')) { publicKey = body.public_key_jwk; return json(200, { challenge, expires_in_seconds: 300 }); }
      if (path.endsWith('/registration/complete')) { registered = true; return json(200, { device_id: device, state: 'pending' }); }
      if (path.endsWith('/begin')) return json(200, { flow_id: loginSid, device_id: device, challenge, expires_in_seconds: 300 });
      if (path.endsWith('/complete')) {
        const exp = Math.floor(Date.now() / 1000) + 600;
        access = `e30.${Buffer.from(JSON.stringify({ sub: '7', sid: loginSid, device_id: device, platform_type: 'desktop', token_use: 'platform_access', exp,
          cnf: { jkt: nativeKeyThumbprint(publicKey as any) } })).toString('base64url')}.c2ln`;
        return json(200, { session_id: loginSid, state: 'active', token_type: 'DPoP', access_token: access,
          refresh_token: Buffer.alloc(32, 9).toString('base64url'), access_expires_at: new Date(exp * 1000).toISOString() });
      }
      assert.equal(request.headers.authorization, `DPoP ${access}`);
      const proof = String(request.headers.dpop); const [header, payload, signature] = proof.split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`),
        { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
      assert.equal(claims.htm, request.method); assert.equal(claims.htu, `${origin}${path}`);
      assert.equal(claims.ath, createHash('sha256').update(access).digest('base64url'));
      assert.equal(seenProofs.has(claims.jti), false); seenProofs.add(claims.jti);
      const root = `/api/agentflow/agent-sessions/${sessionId}`;
      if (path === `${root}/attachments` && request.method === 'POST') {
        const existing = reservations.get(body.upload_key);
        const item = existing ?? { id: `018f1240-0000-7000-8000-${String(10 + reservations.size).padStart(12, '0')}`, metadata: body };
        if (existing) assert.deepEqual(body, existing.metadata); else reservations.set(body.upload_key, item);
        return json(201, { attachment_id: item.id, status: uploaded.has(item.id) ? 'ready' : 'reserved', expires_at: new Date(Date.now() + 60000).toISOString() });
      }
      const item = [...reservations.values()].find((candidate) => path.startsWith(`${root}/attachments/${candidate.id}`));
      if (item && path.endsWith('/content') && request.method === 'PUT') {
        assert.equal(request.headers['content-type'], 'application/octet-stream');
        assert.equal(request.headers['content-length'], String(bytes.length));
        assert.equal(bytes.length, item.metadata.size_bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), item.metadata.sha256);
        const { filename, size_bytes, media_type, sha256 } = item.metadata;
        const receipt = { origin, user_id: '7', session_id: sessionId, workflow_id: 'flow', attachment_id: item.id, filename, size_bytes, media_type, sha256 };
        uploaded.set(item.id, receipt);
        if (firstPut) { firstPut = false; request.socket.destroy(); return; }
        return json(200, receipt);
      }
      if (item && request.method === 'GET') return json(200, uploaded.get(item.id));
      if (path === `${root}/turns` && request.method === 'POST') {
        assert.equal(body.expected_state_version, 2); assert.equal(body.input_text, '첨부 원문\n두 번째 줄');
        for (const reference of body.attachments) assert.equal(uploaded.get(reference.attachment_id)?.sha256, reference.sha256);
        turnRequests.push(body);
        if (firstTurn) { firstTurn = false; originalTurn = body; request.socket.destroy(); return; }
        assert.deepEqual(body, originalTurn);
        return json(202, { turn_id: turnId, status: 'accepted', accepted_sequence: 3, state_version: 3, replayed: true });
      }
      throw new Error('Unexpected fixture route');
    } catch (error) { failures.push(error); response.writeHead(500); response.end(); }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `https://localhost:${address.port}`;
    const firstFile = join(directory, 'first.bin'); const secondFile = join(directory, '첨부.txt');
    await writeFile(firstFile, Uint8Array.from([0, 255, 128, 10])); await writeFile(secondFile, '테스트 파일');
    const secrets = new Map<string, string>();
    const keys = new NativeDeviceKeyStore({ env: {}, lockDirectory: directory, keychain: async () => ({
      getPassword: async (s, n) => secrets.get(`${s}:${n}`) ?? null,
      setPassword: async (s, n, v) => { secrets.set(`${s}:${n}`, v); }, deletePassword: async (s, n) => secrets.delete(`${s}:${n}`),
    }) });
    const requireCert = await readFile(certPath, 'utf8');
    host = new DesktopNativeSessions({ current: () => ({ origin, userId: '7' }), keys,
      fetch: createDesktopNativeFetch(() => [requireCert]), notify: () => {},
      attachmentPicker: (signal) => readSelectedNativeAttachments([firstFile, secondFile], signal) });
    const value = async (method: string, params: Record<string, unknown> = {}) => {
      const reply = await host!.request(method, params); assert.ok(reply.ok, JSON.stringify(reply)); return reply.value as any;
    };
    await value('device', { action: 'register', email: 'fixture@example.test', password: 'fixture-only-password' });
    await value('session', { action: 'login', email: 'fixture@example.test', password: 'fixture-only-password' });
    const scope = { agent_session_id: sessionId, workflow_id: 'flow' };
    const picked = await value('pick-attachments', scope); const drafts = picked.attachments as NativeAttachmentDraftView[];
    assert.equal(drafts.length, 2); assert.equal(JSON.stringify(picked).includes(directory), false);
    assert.equal(JSON.stringify(picked).includes('"bytes":'), false); assert.equal(JSON.stringify(picked).includes(access), false);
    const lostPut = await host.request('upload-attachment', { ...scope, selection_id: drafts[0].selection_id });
    assert.equal(lostPut.ok, false); if (!lostPut.ok) assert.equal(lostPut.outcome, 'unknown');
    const recovered = await value('recover-attachment', { ...scope, selection_id: drafts[0].selection_id });
    assert.equal(recovered.attachments[0].status, 'ready');
    const complete = await value('upload-attachment', { ...scope, selection_id: drafts[1].selection_id });
    const refs = [...complete.attachments].reverse().map((file: NativeAttachmentDraftView) => ({ attachment_id: file.receipt!.attachment_id, sha256: file.receipt!.sha256 }));
    const composer = new AgentTurnComposer(async (request) => {
      const reply = await host!.request('submit-turn', { agent_session_id: request.agent_session_id, ...request.input });
      if (reply.ok) return reply.value;
      throw new AgentTurnComposeFailure(reply.outcome ?? 'unavailable');
    }, () => {}, () => 'original-fixture-key');
    composer.context({ platform_type: 'desktop', profile: 'desktop', server_url: origin, user_id: '7' }, {
      id: sessionId, workflow_id: 'flow', title: 'Fixture', current_sequence: 2, state_version: 2, message_history_complete: true, latest_turn: null,
    }, true);
    await assert.rejects(composer.submit('첨부 원문\n두 번째 줄', refs), AgentTurnComposeFailure);
    assert.equal(composer.view.status, 'unknown'); assert.equal(composer.view.canRetry, true);
    assert.equal((await composer.retry())!.state_version, 3);
    assert.equal(turnRequests.length, 2); assert.deepEqual((turnRequests[0] as any).attachments, refs);
    assert.equal(calls.filter((call) => call.includes('/content')).length, 2);
    assert.deepEqual((await value('attachments', scope)).attachments, []);
    assert.deepEqual(failures, []);
  } finally {
    host?.reset(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
