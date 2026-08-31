import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { MemoryConfigStore } from '@dex/engine';
import { MemoryCredentialStore } from '@dex/engine';
import { DexEngine } from '@dex/engine';
import { DexRpcServer } from '@dex/rpc/server';
import { startMockXgen } from './mock-xgen';

interface RpcMessage {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

function collectLines(stream: PassThrough): {
  messages: RpcMessage[];
  waitFor(predicate: (message: RpcMessage) => boolean): Promise<RpcMessage>;
} {
  const messages: RpcMessage[] = [];
  const waiters: Array<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
  }> = [];
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return {
    messages,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return Promise.race([
        new Promise<RpcMessage>((resolve) => waiters.push({ predicate, resolve })),
        new Promise<RpcMessage>((_resolve, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for RPC message')), 3000),
        ),
      ]);
    },
  };
}

test('stdio RPC initializes, lists agents, and streams chat notifications', async () => {
  const mock = await startMockXgen();
  const input = new PassThrough();
  const output = new PassThrough();
  const configs = new MemoryConfigStore();
  const credentials = new MemoryCredentialStore();
  const engine = new DexEngine(configs, credentials);
  const rpc = new DexRpcServer(engine, { input, output, log: () => {} });
  const localRoot = await mkdtemp(join(tmpdir(), 'dex-rpc-tools-'));
  try {
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');
    await engine.login('me@corp.com', 'pw123');
    const collector = collectLines(output);
    rpc.start();

    input.write('{"jsonrpc":"2.0","id":1,"method":"health"}\n');
    assert.equal((await collector.waitFor((message) => message.id === 1)).error?.code, -32002);

    input.write('{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":1}}\n');
    const initialized = await collector.waitFor((message) => message.id === 2);
    assert.equal(initialized.result?.protocolVersion, 1);
    assert.equal((initialized.result?.capabilities as Record<string, unknown>).localTools, true);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'localTools/configure',
        params: { enabled: true, cwd: localRoot, allowedRoots: [localRoot] },
      })}\n`,
    );
    const configured = await collector.waitFor((message) => message.id === 20);
    assert.equal((configured.result?.config as Record<string, unknown>).enabled, true);

    input.write('{"jsonrpc":"2.0","id":21,"method":"localTools/list","params":{}}\n');
    const toolList = (await collector.waitFor((message) => message.id === 21)).result as unknown as Array<Record<string, unknown>>;
    assert.equal(toolList.some((tool) => tool.name === 'ListDir'), true);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'localTools/run',
        params: { tool: 'ListDir', args: { path: localRoot } },
      })}\n`,
    );
    const localResult = await collector.waitFor((message) => message.id === 22);
    assert.ok(localResult.result?.content);

    input.write('{"jsonrpc":"2.0","id":23,"method":"localTools/configure","params":{"enabled":false}}\n');
    await collector.waitFor((message) => message.id === 23);

    input.write('{"jsonrpc":"2.0","id":3,"method":"agents/list","params":{}}\n');
    const listed = await collector.waitFor((message) => message.id === 3);
    const items = listed.result?.items as Array<Record<string, unknown>>;
    assert.equal(items[0]?.workflowId, 'wf_abc');

    input.write(
      '{"jsonrpc":"2.0","id":4,"method":"chat/start","params":{"workflowId":"wf_abc","input":"rpc hello"}}\n',
    );
    const started = await collector.waitFor((message) => message.id === 4);
    const streamId = String(started.result?.streamId);
    assert.ok(streamId);
    const event = await collector.waitFor(
      (message) => message.method === 'chat/event' && message.params?.streamId === streamId,
    );
    assert.ok(event.params?.event);
    const completed = await collector.waitFor(
      (message) => message.method === 'chat/complete' && message.params?.streamId === streamId,
    );
    assert.equal(completed.params?.interactionId, started.result?.interactionId);
    assert.ok(collector.messages.indexOf(started) < collector.messages.indexOf(event));
  } finally {
    rpc.close();
    input.destroy();
    output.destroy();
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(localRoot, { recursive: true, force: true });
  }
});
