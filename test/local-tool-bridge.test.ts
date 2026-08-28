import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { LocalToolBridge } from '../src/local-tool-bridge';
import { LocalToolProvider } from '../src/local-tools';

test('local tool bridge advertises tools and answers authenticated mcp_call frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dex-local-bridge-'));
  await writeFile(join(directory, 'bridge.txt'), 'connected', 'utf8');
  const provider = new LocalToolProvider({
    enabled: true,
    cwd: directory,
    timeoutMs: 10_000,
    allowedRoots: [directory],
    blockedCommands: [],
    allowDangerous: false,
  });
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  let authorization = '';
  const resultFrame = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp_result timeout')), 5_000);
    server.on('connection', (socket, request) => {
      authorization = String(request.headers.authorization ?? '');
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === 'hello') {
          const tools = frame.tools as Array<Record<string, unknown>>;
          assert.equal(tools.some((tool) => tool.server === 'local' && tool.name === 'ListDir'), true);
          socket.send(
            JSON.stringify({
              type: 'ready',
              catalog_id: frame.catalog_id,
              tool_count: tools.length,
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'mcp_call',
              request_id: 'request-1',
              server: 'local',
              tool: 'ListDir',
              args: { path: directory },
            }),
          );
        } else if (frame.type === 'mcp_result') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
    });
  });
  const bridge = new LocalToolBridge(provider);
  try {
    bridge.start({
      profile: 'corp',
      serverUrl: `http://127.0.0.1:${port}`,
      userId: 'user-1',
      getToken: async () => 'ACCESS.jwt',
      refreshAuth: async () => null,
    });
    const ready = await bridge.waitUntilReady(5_000);
    assert.equal(ready.catalogSynced, true);
    const response = await resultFrame;
    assert.equal(authorization, 'Bearer ACCESS.jwt');
    assert.equal(response.request_id, 'request-1');
    assert.equal(response.ok, true);
    assert.match(JSON.stringify(response.result), /bridge\.txt/);
    assert.equal(bridge.status().lastCall?.tool, 'ListDir');
  } finally {
    bridge.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
