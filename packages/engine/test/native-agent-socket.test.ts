import assert from 'node:assert/strict';
import { createServer, type Server as HttpsServer } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  createNativeAgentSocketTransport,
  NativeSocketAuthentication,
  NativeSocketBusy,
  NativeSocketCursorConflict,
  NativeSocketInvalid,
  NativeSocketUnavailable,
  type NativeAgentSocket,
} from '../src/native-agent-socket';

const SID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'access.safe.jwt';
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKXn0cGhenNEZH
eM6F0bviHLw/3RVrZ6uxPkDhCoAptEd7+CnD4hslCk+wn865tnX0NBL7lBlPZFVb
UCEz5UlhFNyRWJQU55dWMOS0Z9z21K868D7JuvOyOGjHXDcr7naVdeQx9InD79cW
Dxc0tQjqmZH7DdyZMTLSx1PiAexbLm1gaOAp9B9X1/rDDgdiGWpZj7+2s+WECF6R
+kP42+4Qmu4VGvrF5iqDmE37g78ZwFd4NDOgU2DzVsFh8NWzteOzAzCy/jl989hY
JOOUsf6m4oJuPlOjpp9ZcrBWLMS7cvOH7S9zv6uZj6SQtWY3g7Idn6Esn9yithCz
hkx1YT5tAgMBAAECggEAFLRyrfmgcmfHif/691eUVsfUXd9flefbOezx4+R4ZOvw
RWeIVGWRm+pQaXSMSNV5f4UFbS6DoWsVTZym7QGYTqG9CHTs36+rPPMPL0MSKUHs
9MWIUwj47oLVe5I8hdbl1JhlgtPvdXfYRIZCPE8KbMBOHobWS2ksd0LUGwNR3Kk2
WJ+C2GxKAgixuheauiypAbjP6sTaDwkxdZ7oO8wGbbvM+Sad0o7RHaGMXoERgxPT
FO93BYDkDT6f0lbHpYWfX6S6YVDGqLKNf5QyVnva/4gnXgE1OPVEDygvrH6NWbj5
R3WEhtXfbnpAPjgsXnIgXai3EyEKjbaLfolHDaDIuQKBgQD6Jalbrgfo9JDNi2Kt
gmBcv9UhZUyINL2uhCWZl1FgJVrM5GYtESkg/YTUmWJ8Rt2Yx7EFM7LoaHpcidoX
ReOPoNEEA/x6tcy/kKzvjnjMSAOjIzJzxTYkYZ8bz7cZ3Mj1v2j2teW123fI/Xzd
UbZaDlpvAgyDnEZOZzQ+ovSYlQKBgQDPGqUeL5Qd8N3oNRu1lqIl+QfgwYZ8qyaD
ZEN8W6H39f0499XNAKljMG8pPlbm5vR991K+Sy9zAsZJJYf5UXQu0TiPIGlki/SU
FTjnWf2K7mE6l58CARF2K4VlXgKGgNiDLvL14tw7HpzFBZ4zwPz4UJdvKcxLW1yw
r1i47MigeQKBgF5Xh+kg2LDeVCKBWEUSL9+rJenDd7rDEWrZQgkMTc+SJw2xcmu6
1iUwGEHKW599ZqPxZG0O04HdrZBrGUq/vBR2VX5LNpTdLgxttxteQ2bgHicP5j5N
eZ79BnIJxAfIAi7U8vRhI/KThDjUiZw67ihG04qcXjXg4Y8+UzDwaomFAoGBAKh6
Yoy14+afhcZbPdlxWyNM/U2n4YIVsVT+AbBu0spnAMKRSwpkWWfphOSmZAefJpI6
2sMXYthLD4d90qnNy5gyd7JniZVUDXlR8mKyYIHe/pWttprox428Rd56pc9Jjdja
HqhNDx/A/YOB2Hr9qk1PMoIqHJnJDxRk8OYvKd7xAoGBAPaFeHySm7OMHbHeGVAS
eu0qwfBkkd04txrb0Dsc1PlrsuM/9lDRCZ/jWMsULKzqX0m0WtupbQKlCDsBnd8P
/PgOdtr2lu9rO6rhMAscJSQ3+7hZHSAryA0qGZf90ABSdC/eGUYNMOpx8XTrrOg8
TQuK+K1sMj4T9URs0Vsu6Vky
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUS+EOcKGP1lkxLQlMuzf9BWdOkqkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAwMTA1MjYwMFoXDTM2MDky
ODA1MjYwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAyl59HBoXpzRGR3jOhdG74hy8P90Va2ersT5A4QqAKbRH
e/gpw+IbJQpPsJ/OubZ19DQS+5QZT2RVW1AhM+VJYRTckViUFOeXVjDktGfc9tSv
OvA+ybrzsjhox1w3K+52lXXkMfSJw+/XFg8XNLUI6pmR+w3cmTEy0sdT4gHsWy5t
YGjgKfQfV9f6ww4HYhlqWY+/trPlhAhekfpD+NvuEJruFRr6xeYqg5hN+4O/GcBX
eDQzoFNg81bBYfDVs7XjswMwsv45ffPYWCTjlLH+puKCbj5To6afWXKwVizEu3Lz
h+0vc7+rmY+kkLVmN4OyHZ+hLJ/corYQs4ZMdWE+bQIDAQABo28wbTAdBgNVHQ4E
FgQU+6FZDJnzzhgUIrkd5xkSWaimzx0wHwYDVR0jBBgwFoAU+6FZDJnzzhgUIrkd
5xkSWaimzx0wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAB+yoygoDrrZNinulYAd3adzukfBwrO8
aBbRDZ58MTNYi1d3UwYxxkD8qtt/sEhYqhlIq4koZl5KnD5Q61p0EQV2mDh0GOS+
N+3YlQh56Rjk+5OxZUQWAqVt72oMFEYaahRuBqdw97a4fZDVE92w/FJiBtJTncQQ
OJ2Vxyx6C5OAjc/3R6nkNzSQ+1Y+dGCqqonArGQ33kQkPaUi08+7YvsbogCq4ORD
vBrr7pHAdxTT5j9F7t0Pn8eJBoloKoO6PX2UXXvLuKBo6Lzimm8OfsvHQl2HtX5t
2uvulzFg4jalrFLnKuobFtzoAs4zTa/AvJbWli3nnEsc0uN6ssjql9U=
-----END CERTIFICATE-----`;

type Upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer, accept: () => void) => void;

async function fixture(upgrade?: Upgrade) {
  const requests: IncomingMessage[] = [];
  const peers: WebSocket[] = [];
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = createServer({ key: KEY, cert: CERT });
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    requests.push(request);
    const accept = () => wss.handleUpgrade(request, socket, head, (peer) => {
      peers.push(peer);
      wss.emit('connection', peer, request);
    });
    (upgrade ?? ((_request, _socket, _head, next) => next()))(request, socket, head, accept);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `https://127.0.0.1:${address.port}`;
  const transport = createNativeAgentSocketTransport(origin, { certificates: () => [CERT] });
  const controller = new AbortController();
  const proof = () => jwt({ htm: 'GET', htu: `${origin}/api/agentflow/agent-sessions/${SID}/events` });
  const open = (after = 0, signal = controller.signal) => transport.open(SID, after, TOKEN, proof(), signal);
  const close = async () => {
    controller.abort();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return { server, wss, peers, requests, origin, transport, controller, proof, open, close };
}

function jwt(payload: object): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>, upgrade?: Upgrade) {
  const f = await fixture(upgrade);
  try { await run(f); } finally { await f.close(); }
}

test('uses the canonical WSS route and only explicit credential headers', async () => withFixture(async (f) => {
  f.wss.once('connection', (peer) => peer.send('{"sequence":1}'));
  const socket = await f.open(Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await socket.next(), { sequence: 1 });
  const request = f.requests[0]!;
  assert.equal(request.url, `/api/agentflow/agent-sessions/${SID}/events?after_seq=9007199254740991`);
  assert.equal(request.headers.authorization, `DPoP ${TOKEN}`);
  assert.equal(request.headers.dpop, f.proof());
  for (const forbidden of ['cookie', 'origin', 'sec-websocket-protocol', 'sec-websocket-extensions', 'proxy-authorization']) {
    assert.equal(request.headers[forbidden], undefined);
  }
  assert.equal(socket.closed, false);
  await socket.close();
  assert.equal(socket.closed, true);
}));

test('rejects noncanonical origins, identifiers, cursors, JWTs and proof targets before wire I/O', async () => {
  for (const origin of ['http://example.test', 'https://EXAMPLE.test', 'https://example.test/',
    'https://user@example.test', 'https://example.test?x=1', 'https://example.test:443']) {
    assert.throws(() => createNativeAgentSocketTransport(origin), NativeSocketInvalid);
  }
  await withFixture(async (f) => {
    const badProof = jwt({ htm: 'GET', htu: `${f.origin}/api/agentflow/agent-sessions/${SID}/events?after_seq=0` });
    const invalidCalls: Array<() => Promise<NativeAgentSocket>> = [
      () => f.transport.open('aaaaaaaa-0000-4000-8000-000000000001'.toUpperCase(), 0, TOKEN, f.proof(), f.controller.signal),
      () => f.transport.open('00000000-0000-0000-8000-000000000001', 0, TOKEN, f.proof(), f.controller.signal),
      () => f.transport.open('00000000-0000-4000-7000-000000000001', 0, TOKEN, f.proof(), f.controller.signal),
      () => f.transport.open(SID, -1, TOKEN, f.proof(), f.controller.signal),
      () => f.transport.open(SID, Number.MAX_SAFE_INTEGER + 1, TOKEN, f.proof(), f.controller.signal),
      () => f.transport.open(SID, 0, 'not-a-jwt', f.proof(), f.controller.signal),
      () => f.transport.open(SID, 0, TOKEN, badProof, f.controller.signal),
    ];
    for (const call of invalidCalls) await assert.rejects(call(), NativeSocketInvalid);
    assert.equal(f.requests.length, 0);
  });
});

test('accepts a one MiB text frame and rejects oversized, binary, malformed UTF-8 and invalid JSON frames', async () => {
  const exact = JSON.stringify({ value: 'x'.repeat(1024 * 1024 - 12) });
  assert.equal(Buffer.byteLength(exact), 1024 * 1024);
  await withFixture(async (f) => {
    f.wss.once('connection', (peer) => peer.send(exact));
    const socket = await f.open();
    assert.deepEqual(await socket.next(), JSON.parse(exact));
    await socket.close();
  });
  for (const send of [
    (peer: WebSocket) => peer.send(Buffer.from('{}')),
    (peer: WebSocket) => peer.send('x'.repeat(1024 * 1024 + 1)),
    (peer: WebSocket) => (peer as unknown as { _socket: Duplex })._socket.write(Buffer.from([0x81, 0x02, 0xc3, 0x28])),
    (peer: WebSocket) => peer.send('{bad json'),
  ]) {
    await withFixture(async (f) => {
      f.wss.once('connection', send);
      const socket = await f.open();
      await assert.rejects(socket.next(), NativeSocketInvalid);
      await waitFor(() => socket.closed);
      await assert.rejects(socket.next(), NativeSocketInvalid);
    });
  }
});

test('bounds queued frames and bytes, while a pending consumer bypasses the queue', async () => {
  await withFixture(async (f) => {
    const socket = await f.open();
    const pending = socket.next();
    await assert.rejects(socket.next(), NativeSocketBusy);
    f.peers[0]!.send('{"direct":true}');
    assert.deepEqual(await pending, { direct: true });
    for (let index = 0; index < 9; index++) f.peers[0]!.send(JSON.stringify({ index }));
    await waitFor(() => socket.closed);
    await assert.rejects(socket.next(), NativeSocketInvalid);
  });
  await withFixture(async (f) => {
    const socket = await f.open();
    const large = JSON.stringify({ value: 'x'.repeat(800_000) });
    f.peers[0]!.send(large); f.peers[0]!.send(large); f.peers[0]!.send(large);
    await waitFor(() => socket.closed);
    await assert.rejects(socket.next(), NativeSocketInvalid);
  });
});

test('classifies handshake status without exposing response bodies or credentials', async () => {
  const cases: Array<[number, new (...args: never[]) => Error]> = [
    [401, NativeSocketAuthentication], [403, NativeSocketAuthentication], [409, NativeSocketCursorConflict],
    [408, NativeSocketUnavailable], [429, NativeSocketUnavailable], [500, NativeSocketUnavailable],
    [503, NativeSocketUnavailable], [302, NativeSocketInvalid], [404, NativeSocketInvalid],
  ];
  for (const [status, ErrorType] of cases) {
    await withFixture(async (f) => {
      const result = f.open();
      await assert.rejects(result, (error: unknown) => error instanceof ErrorType
        && !JSON.stringify(error).includes('private-server-body')
        && !JSON.stringify(error).includes(TOKEN));
    }, (_request, socket) => {
      const body = 'private-server-body';
      const redirect = status === 302 ? 'Location: https://attacker.example/events\r\n' : '';
      socket.end(`HTTP/1.1 ${status} Failure\r\n${redirect}Content-Length: ${body.length}\r\n\r\n${body}`);
    });
  }
});

test('classifies peer close codes and retains the terminal failure', async () => {
  const cases: Array<[number, new (...args: never[]) => Error]> = [
    [4401, NativeSocketAuthentication], [4403, NativeSocketAuthentication], [4409, NativeSocketCursorConflict],
    [1002, NativeSocketInvalid], [1003, NativeSocketInvalid], [1007, NativeSocketInvalid], [1009, NativeSocketInvalid],
    [1000, NativeSocketUnavailable], [1011, NativeSocketUnavailable],
  ];
  for (const [code, ErrorType] of cases) {
    await withFixture(async (f) => {
      f.wss.once('connection', (peer) => peer.close(code));
      const socket = await f.open();
      await assert.rejects(socket.next(), ErrorType);
      await waitFor(() => socket.closed);
      await assert.rejects(socket.next(), ErrorType);
    });
  }
});

test('abort terminates handshake and pending next, and close is idempotent', async () => {
  let upgradeCount = 0;
  await withFixture(async (f) => {
    const aborted = new AbortController();
    const opening = f.open(0, aborted.signal);
    await waitFor(() => f.requests.length === 1);
    aborted.abort();
    await assert.rejects(opening, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    const replacement = await f.open();
    await replacement.close();
  }, (_request, _socket, _head, accept) => { if (++upgradeCount === 2) accept(); });
  await withFixture(async (f) => {
    const socket = await f.open();
    const pending = socket.next();
    f.controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await waitFor(() => socket.closed);
    await assert.rejects(socket.next(), (error: unknown) => error instanceof Error && error.name === 'AbortError');
    const first = socket.close(); const second = socket.close();
    assert.equal(first, second);
    await first;
  });
});

test('explicit close discards already queued frames before close acknowledgement', async () => withFixture(async (f) => {
  const socket = await f.open();
  f.peers[0]!.send('{"sequence":1}');
  f.peers[0]!.send('{"sequence":2}');
  assert.deepEqual(await socket.next(), { sequence: 1 });
  const closing = socket.close();
  await assert.rejects(socket.next(), NativeSocketUnavailable);
  await closing;
  await assert.rejects(socket.next(), NativeSocketUnavailable);
}));

test('shares the origin latch across factories and releases it after actual close', async () => withFixture(async (f) => {
  const first = await f.open();
  const other = createNativeAgentSocketTransport(f.origin, { certificates: () => [CERT] });
  await assert.rejects(other.open(SID, 0, TOKEN, f.proof(), new AbortController().signal), NativeSocketBusy);
  const closing = first.close();
  await assert.rejects(other.open(SID, 0, TOKEN, f.proof(), new AbortController().signal), NativeSocketBusy);
  await closing;
  const second = await other.open(SID, 0, TOKEN, f.proof(), new AbortController().signal);
  await second.close();
}));

test('explicit close terminates a peer that never acknowledges and holds the origin until actual close', async () => withFixture(async (f) => {
  const socket = await f.open();
  const peerSocket = (f.peers[0] as unknown as { _socket: Duplex })._socket;
  peerSocket.pause();
  const other = createNativeAgentSocketTransport(f.origin, { certificates: () => [CERT] });
  const started = Date.now();
  const closing = socket.close();
  await assert.rejects(other.open(SID, 0, TOKEN, f.proof(), new AbortController().signal), NativeSocketBusy);
  await closing;
  assert.equal(socket.closed, true);
  assert.ok(Date.now() - started >= 900);
  assert.ok(Date.now() - started < 2500);
  peerSocket.resume();
  const replacement = await other.open(SID, 0, TOKEN, f.proof(), new AbortController().signal);
  await replacement.close();
}));

test('rejects the fixture certificate by default and accepts only explicit trusted injection', async () => withFixture(async (f) => {
  const plain = createNativeAgentSocketTransport(f.origin);
  await assert.rejects(plain.open(SID, 0, TOKEN, f.proof(), new AbortController().signal), NativeSocketUnavailable);
  await waitFor(() => f.requests.length === 0);
  let socket: NativeAgentSocket | undefined;
  for (let attempt = 0; attempt < 50 && !socket; attempt++) {
    try { socket = await f.open(); }
    catch (error) {
      if (!(error instanceof NativeSocketBusy)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assert.ok(socket);
  await socket.close();
}));

test('assertAvailable is synchronous and certificate provider failures stay generic', async () => withFixture(async (f) => {
  f.transport.assertAvailable();
  const broken = createNativeAgentSocketTransport(f.origin, { certificates: () => { throw new Error('private-cert-path'); } });
  await assert.rejects(broken.open(SID, 0, TOKEN, f.proof(), f.controller.signal),
    (error: unknown) => error instanceof NativeSocketUnavailable && !error.message.includes('private-cert-path'));
}));

test('accepts more than 64 bounded certificates while preserving default trust', async () => withFixture(async (f) => {
  const certificates = Array.from({ length: 65 }, () => CERT);
  const transport = createNativeAgentSocketTransport(f.origin, { certificates: () => certificates });
  const socket = await transport.open(SID, 0, TOKEN, f.proof(), new AbortController().signal);
  await socket.close();
}));
