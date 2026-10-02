/** Opt-in production Mobile writer/read/model over trusted localhost TLS. Software key/memory vault are fixture seams. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, createServer, request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createMobileDeviceKeys, mobileKeyThumbprint } from '../apps/mobile/src/lib/native-device-key';
import { createMobileSessionVault, mobileVaultScope, type MobilePlatformRecord } from '../apps/mobile/src/lib/native-session-vault';
import { createMobileAgentFetch } from '../apps/mobile/src/lib/native-agent-http';
import { createMobileAgentFocusSource } from '../apps/mobile/src/lib/native-agent-focus';
import { createMobileAgentConversationWatcher } from '../apps/mobile/src/lib/native-agent-conversation-watch';
import { createMobileAgentMutationFetch, createMobileTurnKey } from '../apps/mobile/src/lib/native-agent-mutation-http';
import { createMobileAgentMutationSource } from '../apps/mobile/src/lib/native-agent-mutation';
import { MobileAgentConversationModel } from '../apps/mobile/src/lib/native-agent-conversation-model';
import { createMobileAgentLifecycleFetch } from '../apps/mobile/src/lib/native-agent-lifecycle-http';
import { createMobileAgentLifecycleSource } from '../apps/mobile/src/lib/native-agent-lifecycle';
const testSessions = process.argv.includes('--sessions');
const certificates = resolve('../xgen-infra/compose/full-stack/.local-certs');
const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const jwk = pair.publicKey.export({ format: 'jwk' });
const publicKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as const;
const sessionId = randomUUID(); const platformSid = randomUUID(); const deviceId = randomUUID(); const turnId = randomUUID();
const installId = randomUUID(); const userId = '1000000123';
const otherSessionId = randomUUID(); let focusId: string | null = testSessions ? null : sessionId;
let focusVersion = testSessions ? 0 : 1; let creations = 0; let lifecycleWrites = 0;
let origin = ''; let account = { origin, userId, authScope: randomUUID(), accessToken: 'unused-legacy' };
let stateVersion = 4; let sequence = 0; let turn: { id: string; status: 'running' | 'cancelled'; accepted_sequence: number } | null = null;
let executions = 0; let writes = 0; let proofCount = 0; let errors = 0; let loseAck = true; let exactBody: string | null = null;
let access = ''; const jtIs = new Set<string>(); const writesSeen: string[] = []; const values = new Map<string, string>();
const jwt = (header: object, claims: object) => {
  const input = [header, claims].map((v) => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
function verifyRequest(req: IncomingMessage) {
  assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.origin, undefined);
  assert.equal(req.headers.authorization, `DPoP ${access}`); assert.equal(req.headers.accept, 'application/json');
  const parts = String(req.headers.dpop).split('.'); const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
  assert.equal(header.typ, 'dpop+jwt'); assert.equal(header.alg, 'ES256'); assert.deepEqual(header.jwk, publicKey);
  assert.equal(claims.htm, req.method); assert.equal(claims.htu, `${origin}${req.url!.split('?')[0]}`);
  assert.equal(claims.ath, createHash('sha256').update(access).digest('base64url'));
  assert.equal(jtIs.has(claims.jti), false); jtIs.add(claims.jti);
  assert(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url')));
  proofCount++;
}
const server = createServer({ cert: readFileSync(join(certificates, 'localhost.pem')), key: readFileSync(join(certificates, 'localhost-key.pem')) }, (req, res) => {
  void (async () => {
    verifyRequest(req); const path = req.url!; const url = new URL(path, origin);
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET') {
      if (path === '/api/agentflow/me/agent-state') return reply({ active_agent_session_id: focusId, version: focusVersion, event_id: focusVersion ? sessionId : null });
      if (url.pathname === '/api/agentflow/me/agent-sessions') { assert.equal(url.search, '?limit=100'); return reply({ items: [...(creations ? [sessionId] : []), otherSessionId].map((id) => ({
        id, workflow_id: 'fixture-owned-workflow', title: 'Mobile shared', status: 'active', state_version: id === sessionId ? stateVersion : 1,
        current_sequence: id === sessionId ? sequence : 0 })), next_cursor: null, has_more: false }); }
      if (url.pathname === '/api/agentflow/me/agent-events') return reply({ events: [], next_cursor: focusVersion, snapshot_version: focusVersion, has_more: false });
      const selected = focusId === otherSessionId ? otherSessionId : sessionId;
      const selectedVersion = selected === sessionId ? stateVersion : 1; const selectedSequence = selected === sessionId ? sequence : 0;
      if (path === `/api/agentflow/agent-sessions/${selected}/snapshot`) return reply({ id: selected, workflow_id: 'fixture-owned-workflow', title: 'Mobile shared',
        state_version: selectedVersion, current_sequence: selectedSequence, latest_turn: selected === sessionId ? turn : null, message_history_complete: false });
      if (url.pathname === `/api/agentflow/agent-sessions/${selected}/events`) return reply({ type: 'agent_session.events', events: [], next_cursor: selectedSequence,
        snapshot_sequence: selectedSequence, state_version: selectedVersion, has_more: false });
      if (url.pathname === `/api/agentflow/agent-sessions/${selected}/messages`) return reply({ type: 'agent_session.messages', messages: [], next_cursor: 0,
        snapshot_sequence: selectedSequence, state_version: selectedVersion, has_more: false });
      assert.fail('Unexpected GET route');
    }
    assert.equal(req.headers['content-type'], 'application/json');
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part)); const serialized = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(serialized);
    if (testSessions && path === '/api/agentflow/agent-sessions') {
      assert.equal(req.method, 'POST'); assert.equal(body.expected_version, focusVersion); assert.equal(body.workflow_id, 'fixture-owned-workflow');
      creations++; lifecycleWrites++; assert.equal(creations, 1); focusId = sessionId; focusVersion++;
      req.socket.destroy(); return; // Creation committed, acknowledgement lost: never replay it.
    }
    if (testSessions && path === '/api/agentflow/me/agent-state') {
      assert.equal(req.method, 'PUT'); assert.equal(body.expected_version, focusVersion); lifecycleWrites++;
      assert([null, sessionId, otherSessionId].includes(body.active_agent_session_id));
      if (focusId !== body.active_agent_session_id) focusVersion++;
      focusId = body.active_agent_session_id; return reply({ active_agent_session_id: focusId, version: focusVersion, event_id: sessionId });
    }
    assert.equal(req.method, 'POST'); writes++; writesSeen.push(serialized);
    if (path === `/api/agentflow/agent-sessions/${sessionId}/turns`) {
      if (exactBody === null) {
        assert.equal(body.expected_state_version, 4); assert.equal(body.input_text, '  Mobile exact\n끝\n');
        exactBody = serialized; executions++; stateVersion = 5; sequence = 1; turn = { id: turnId, status: 'running', accepted_sequence: 1 };
      } else assert.equal(serialized, exactBody);
      if (loseAck) { loseAck = false; req.socket.destroy(); return; }
      return reply({ turn_id: turnId, status: 'running', accepted_sequence: 1, state_version: 5, replayed: true }, 202);
    }
    if (path === `/api/agentflow/agent-sessions/${sessionId}/stop`) {
      assert.deepEqual(body, { turn_id: turnId, expected_state_version: 5 });
      assert.equal(turn?.status, 'running'); turn!.status = 'cancelled'; stateVersion = 6; sequence = 2;
      return reply({ turn_id: turnId, state_version: 5, requested: true }, 202);
    }
    assert.fail('No legacy or arbitrary write route is allowed');
  })().catch(() => { errors++; res.destroy(); });
});
const agent = new Agent({ ca: readFileSync(join(caRoot, 'rootCA.pem')), keepAlive: false });
const inFlight = new Map<string, ReturnType<typeof httpsRequest>>();
async function bridge(id: string, selected: string, path: string, token: string, dpop: string, body?: string, method?: string): Promise<unknown> {
  assert.equal(selected, origin);
  return new Promise((resolveResponse, reject) => {
    const request = httpsRequest(`${origin}${path}`, { agent, method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Accept: 'application/json', Authorization: `DPoP ${token}`, DPoP: dpop, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (part) => chunks.push(Buffer.from(part))); res.on('error', reject);
      res.on('end', () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    inFlight.set(id, request); request.on('error', reject); request.on('close', () => inFlight.delete(id)); request.end(body);
  });
}
let model: MobileAgentConversationModel | null = null;
try {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); assert(address && typeof address !== 'string'); origin = `https://localhost:${address.port}`; account = { ...account, origin };
  const exp = Math.floor(Date.now() / 1000) + 300;
  access = jwt({ alg: 'ES256' }, { sub: userId, sid: platformSid, device_id: deviceId, platform_type: 'mobile', token_use: 'platform_access', cnf: { jkt: mobileKeyThumbprint(publicKey) }, exp });
  const record: MobilePlatformRecord = { version: 1, platform: 'mobile', origin, userId, installId, keyThumbprint: mobileKeyThumbprint(publicKey), deviceId, sessionId: platformSid,
    generation: randomUUID(), phase: 'ready', refreshToken: Buffer.alloc(32, 2).toString('base64url'), accessToken: access, accessExpiresAt: new Date(exp * 1000).toISOString() };
  values.set(mobileVaultScope(account), JSON.stringify(record)); const before = [...values.entries()];
  const current = () => account;
  const native = { newRequestId: randomUUID, newTurnKey: randomUUID,
    prepare: async () => ({ installId, publicKey, storage: 'android-tee' }), signChallenge: async () => assert.fail('No refresh/login'),
    signDpop: async (_o: string, _u: string, _i: string, _t: string, method: string, htu: string, token: string) =>
      jwt({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicKey }, { jti: randomUUID(), htm: method, htu, iat: Math.floor(Date.now() / 1000), ath: createHash('sha256').update(token).digest('base64url') }),
    readRequest: (id: string, o: string, path: string, token: string, dpop: string) => bridge(id, o, path, token, dpop),
    turnRequest: bridge, cancelRequest: (id: string) => { inFlight.get(id)?.destroy(new Error('Cancelled')); },
    lifecycleRequest: (id: string, o: string, path: string, method: 'POST' | 'PUT', token: string, dpop: string, body: string) => bridge(id, o, path, token, dpop, body, method),
  };
  const keys = createMobileDeviceKeys(native, current); const vault = createMobileSessionVault({ getItemAsync: async (k) => values.get(k) ?? null,
    setItemAsync: async (k, v) => { values.set(k, v); }, deleteItemAsync: async (k) => { values.delete(k); } });
  const source = createMobileAgentFocusSource({ current, keys, vault, fetch: createMobileAgentFetch(native, origin) });
  const writer = createMobileAgentMutationSource({ current, keys, vault, fetch: createMobileAgentMutationFetch(native, origin) });
  const lifecycle = testSessions ? createMobileAgentLifecycleSource({ current, keys, vault, fetch: createMobileAgentLifecycleFetch(native, origin) }) : null;
  model = new MobileAgentConversationModel(account, createMobileAgentConversationWatcher(source), writer, () => undefined, () => createMobileTurnKey(native), () => source.dispose(),
    lifecycle ? { read: source.readCatalog, send: lifecycle.send, dispose: lifecycle.dispose } : undefined);
  const waitFor = async (check: () => boolean) => { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Mobile fixture deadline'); await new Promise((r) => setTimeout(r, 20)); } };
  model.setVisible(true);
  if (testSessions) {
    await model.refreshCatalog(); assert.equal(model.state.catalog.canWrite, true);
    await Promise.all([model.createSession('fixture-owned-workflow', 'Mobile shared'), model.createSession('fixture-owned-workflow')]);
    assert.equal(creations, 1); assert.equal(lifecycleWrites, 1); assert.equal(model.state.catalog.writeBlocked, true);
    model.setVisible(false); model.setVisible(true); await model.start(true);
    assert.equal(model.state.turn.canSubmit, false); assert.equal(await model.createSession('fixture-owned-workflow'), false);
    await model.refreshCatalog(); await waitFor(() => model!.state.turn.canSubmit);
    model.setDraft('same focus draft'); await model.selectSession(sessionId); await waitFor(() => model!.state.turn.canSubmit);
    assert.equal(model.state.draft, 'same focus draft');
    await model.selectSession(otherSessionId); await waitFor(() => model!.state.conversation?.snapshot?.id === otherSessionId);
    assert.equal(model.state.draft, ''); await model.selectSession(sessionId); await waitFor(() => model!.state.turn.canSubmit);
  } else await model.start(true);
  assert.equal(model.state.turn.canSubmit, true); model.setDraft('  Mobile exact\n끝\n');
  await Promise.all([model.submit(), model.submit()]); assert.equal(executions, 1); assert.equal(writes, 1);
  await waitFor(() => model!.state.turn.canRetry); assert.equal(model.state.turn.status, 'unknown');
  model.setVisible(false); await waitFor(() => !model!.state.watching); assert.equal(model.state.draft, '');
  model.setVisible(true); assert.equal(model.state.turn.canRetry, false);
  if (testSessions) { await model.refreshCatalog(); await waitFor(() => model!.state.turn.canRetry); assert.equal(await model.selectSession(otherSessionId), false); }
  else await model.start(true);
  await model.retry(); await waitFor(() => model!.state.turn.canStop); assert.equal(model.state.draft, '');
  assert.equal(executions, 1); assert.equal(writes, 2); assert.equal(writesSeen[0], writesSeen[1]);
  await model.stopTurn(); await waitFor(() => model!.state.turn.canSubmit); assert.equal(model.state.conversation?.snapshot?.latest_turn?.status, 'cancelled');
  assert.equal(writes, 3); assert.equal(errors, 0); assert.deepEqual([...values.entries()], before);
  if (testSessions) { await model.selectSession(null); assert.equal(model.state.conversation, null); assert.equal(model.state.draft, '');
    assert.equal(model.state.turn.canSubmit, false); assert.equal(lifecycleWrites, 5); assert.equal(creations, 1); }
  for (const secret of [access, record.refreshToken!]) assert.equal(JSON.stringify(model.state).includes(secret), false);
  console.log(`Mobile production read + writer + composer model over trusted HTTPS: 1 execution / 3 explicit writes / ${proofCount} fresh ES256 proofs; lost ACK, screen suspend, exact retry/stop, terminal recovery, unchanged vault, no legacy dispatch PASS`);
  if (testSessions) console.log('Mobile production catalog/create/select/clear over trusted HTTPS: 1 creation despite lost ACK/double click, 5 explicit lifecycle writes, catalog recheck lock, same-focus draft, selected-snapshot binding, unknown-turn lifecycle gate PASS');
} finally {
  model?.dispose(); for (const request of inFlight.values()) request.destroy(); values.clear(); agent.destroy(); server.closeAllConnections();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}
