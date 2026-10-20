import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { getMcpBridge } from '../src/mcp-bridge';
import { getMcpManager } from '../src/mcp-manager';

type BridgeInternals = {
  ws: WebSocket;
  pendingCatalogId: string;
  protocolReady: boolean;
  connectionGeneration: number | null;
  onMessage(text: string, from: WebSocket): Promise<void>;
  inflight: Map<string, unknown>;
};

function socket(): WebSocket & { sent: string[] } {
  const value = {
    readyState: WebSocket.OPEN as number,
    sent: [] as string[],
    send(data: string) { this.sent.push(String(data)); },
    close() { this.readyState = WebSocket.CLOSED; },
    removeAllListeners() {},
    on() { return this; },
  };
  return value as unknown as WebSocket & { sent: string[] };
}

test('v2 ready만 호출을 열고 duplicate/cancel/late result를 exact correlation으로 막는다', async () => {
  const bridge = getMcpBridge();
  bridge.stop();
  const internal = bridge as unknown as BridgeInternals;
  const ws = socket();
  internal.ws = ws;
  internal.pendingCatalogId = 'catalog-1';

  await internal.onMessage(JSON.stringify({
    type: 'ready', catalog_id: 'catalog-1', tool_count: 1,
  }), ws);
  assert.equal(internal.protocolReady, false, 'legacy ready must not enable calls');

  await internal.onMessage(JSON.stringify({
    type: 'ready', catalog_id: 'catalog-1', tool_count: 1,
    protocol_version: 2, connection_generation: 7,
  }), ws);
  assert.equal(internal.protocolReady, true);
  assert.equal(internal.connectionGeneration, 7);

  const manager = getMcpManager();
  const originalCall = manager.callTool.bind(manager);
  const originalSanitizeOutput = manager.sanitizeOutput.bind(manager);
  const originalSanitizeError = manager.sanitizeError.bind(manager);
  let calls = 0;
  let resolveLate!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  (manager as unknown as { callTool: typeof manager.callTool }).callTool = async (_server, _tool, _args, nextSignal) => {
    calls++;
    signal = nextSignal;
    return new Promise((resolve) => { resolveLate = resolve; });
  };
  (manager as unknown as { sanitizeOutput: typeof manager.sanitizeOutput }).sanitizeOutput = (_name, value) => value;
  (manager as unknown as { sanitizeError: typeof manager.sanitizeError }).sanitizeError = (_name, value) => String(value);

  const call = {
    type: 'mcp_call', request_id: 'r1', server: 'fake', tool: 'slow', args: {},
    protocol_version: 2, connection_generation: 7, request_nonce: 'nonce-1',
  };
  const running = internal.onMessage(JSON.stringify(call), ws);
  await new Promise((resolve) => setImmediate(resolve));
  await internal.onMessage(JSON.stringify(call), ws);
  assert.equal(calls, 1, 'duplicate request id must not dispatch twice');
  assert.match(ws.sent.at(-1) ?? '', /duplicate_request/);

  await internal.onMessage(JSON.stringify({
    type: 'mcp_cancel', request_id: 'r1', protocol_version: 2,
    connection_generation: 7, request_nonce: 'wrong',
  }), ws);
  assert.equal(signal?.aborted, false, 'wrong nonce must not cancel');
  await internal.onMessage(JSON.stringify({
    type: 'mcp_cancel', request_id: 'r1', protocol_version: 2,
    connection_generation: 7, request_nonce: 'nonce-1',
  }), ws);
  assert.equal(signal?.aborted, true);
  resolveLate({ secret: 'late-success' });
  await running;
  assert.equal(ws.sent.some((frame) => frame.includes('late-success')), false);

  (manager as unknown as { callTool: typeof manager.callTool }).callTool = originalCall;
  (manager as unknown as { sanitizeOutput: typeof manager.sanitizeOutput }).sanitizeOutput = originalSanitizeOutput;
  (manager as unknown as { sanitizeError: typeof manager.sanitizeError }).sanitizeError = originalSanitizeError;
  bridge.stop();
});

test('old socket completion is never forwarded to a replacement socket', async () => {
  const bridge = getMcpBridge();
  bridge.stop();
  const internal = bridge as unknown as BridgeInternals;
  const oldSocket = socket();
  const replacement = socket();
  internal.ws = oldSocket;
  internal.protocolReady = true;
  internal.connectionGeneration = 8;
  const manager = getMcpManager();
  const originalCall = manager.callTool.bind(manager);
  let finish!: (value: unknown) => void;
  (manager as unknown as { callTool: typeof manager.callTool }).callTool = async () =>
    new Promise((resolve) => { finish = resolve; });
  const running = internal.onMessage(JSON.stringify({
    type: 'mcp_call', request_id: 'old', server: 'fake', tool: 'slow', args: {},
    protocol_version: 2, connection_generation: 8, request_nonce: 'old-nonce',
  }), oldSocket);
  await new Promise((resolve) => setImmediate(resolve));
  internal.ws = replacement;
  internal.connectionGeneration = 9;
  finish({ value: 'old-result' });
  await running;
  assert.equal(oldSocket.sent.some((frame) => frame.includes('old-result')), false);
  assert.equal(replacement.sent.length, 0);
  (manager as unknown as { callTool: typeof manager.callTool }).callTool = originalCall;
  bridge.stop();
});
