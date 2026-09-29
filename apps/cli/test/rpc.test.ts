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
  waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs?: number): Promise<RpcMessage>;
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
    waitFor(predicate, timeoutMs = 3000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return Promise.race([
        new Promise<RpcMessage>((resolve) => waiters.push({ predicate, resolve })),
        new Promise<RpcMessage>((_resolve, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for RPC message')), timeoutMs),
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
    assert.equal((initialized.result?.capabilities as Record<string, unknown>).localFolders, true);
    assert.equal((initialized.result?.capabilities as Record<string, unknown>).conversationModel, true);

    // 옛 확장이 보내는 켜기·허용 폴더는 버리고, 남은 설정(위험 명령 사전 승인)만 받는다.
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'localTools/configure',
        params: { enabled: true, cwd: localRoot, allowedRoots: [localRoot], allowDangerous: false },
      })}\n`,
    );
    const configured = await collector.waitFor((message) => message.id === 20);
    assert.deepEqual(configured.result?.config, { allowDangerous: false });

    input.write('{"jsonrpc":"2.0","id":21,"method":"localTools/list","params":{}}\n');
    const toolList = (await collector.waitFor((message) => message.id === 21)).result as unknown as Array<Record<string, unknown>>;
    assert.equal(toolList.some((tool) => tool.name === 'ListDir'), true);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'localTools/run',
        params: { tool: 'ListDir', args: { path: localRoot }, folders: [localRoot] },
      })}\n`,
    );
    const localResult = await collector.waitFor((message) => message.id === 22);
    assert.ok(localResult.result?.content);

    // 폴더 없이 부르면 파일 도구는 거부한다.
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 23,
        method: 'localTools/run',
        params: { tool: 'ListDir', args: { path: localRoot } },
      })}\n`,
    );
    const refused = await collector.waitFor((message) => message.id === 23);
    assert.match(String(refused.error?.message ?? ''), /NO_FOLDER/);

    input.write('{"jsonrpc":"2.0","id":3,"method":"agents/list","params":{}}\n');
    const listed = await collector.waitFor((message) => message.id === 3);
    const items = listed.result?.items as Array<Record<string, unknown>>;
    assert.equal(items[0]?.workflowId, 'wf_abc');

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'chat/start',
        params: { workflowId: 'wf_abc', input: 'rpc hello', localFolders: [localRoot] },
      })}\n`,
    );
    const started = await collector.waitFor((message) => message.id === 4);
    const streamId = String(started.result?.streamId);
    assert.ok(streamId);
    // 폴더가 연결된 대화는 첫 턴 전에 이 PC 브리지를 최대 3초 기다린다(이 가짜
    // 서버에는 브리지 소켓이 없으므로 그만큼 기다린 뒤 턴이 시작된다).
    const event = await collector.waitFor(
      (message) => message.method === 'chat/event' && message.params?.streamId === streamId,
      8000,
    );
    assert.ok(event.params?.event);
    const completed = await collector.waitFor(
      (message) => message.method === 'chat/complete' && message.params?.streamId === streamId,
    );
    assert.equal(completed.params?.interactionId, started.result?.interactionId);
    assert.ok(collector.messages.indexOf(started) < collector.messages.indexOf(event));
    // 작업 영역 폴더가 이 대화의 폴더로 서버에 실린다.
    const sent = mock.requests.chatFolders.at(-1) as Array<Record<string, unknown>>;
    assert.deepEqual(sent.map((folder) => folder.path), [localRoot]);
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

/**
 * 정지는 연결이 아니라 **대화**를 향한다.
 *
 * 서버는 더 이상 SSE 끊김을 취소로 읽지 않는다 — 그렇게 읽던 시절엔 화면 잠금·
 * 절전·기기 이동이 곧 실행 중단이었다. 그래서 `chat/cancel`(그만 보기)과
 * `chat/stop`(사람이 누른 [정지])은 **다른 일**이어야 하고, 후자만 서버까지 닿는다.
 */
test('chat/stop 은 서버까지 닿고 chat/cancel 은 닿지 않는다', async () => {
  const mock = await startMockXgen();
  const input = new PassThrough();
  const output = new PassThrough();
  const engine = new DexEngine(new MemoryConfigStore(), new MemoryCredentialStore());
  const rpc = new DexRpcServer(engine, { input, output, log: () => {} });
  try {
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');
    await engine.login('me@corp.com', 'pw123');
    const collector = collectLines(output);
    rpc.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n');
    await collector.waitFor((message) => message.id === 1);

    // 그만 보기 — 서버 실행은 남는다.
    input.write(
      '{"jsonrpc":"2.0","id":2,"method":"chat/start","params":{"workflowId":"wf_abc","interactionId":"int-detach","input":"hi"}}\n',
    );
    await collector.waitFor((message) => message.id === 2);
    input.write('{"jsonrpc":"2.0","id":3,"method":"chat/cancel","params":{"streamId":"nope"}}\n');
    await collector.waitFor((message) => message.id === 3);
    assert.deepEqual(mock.stopped, []);

    // 사람이 누른 [정지] — 스트림이 없어도 대화로 닿는다(다른 기기에서 시작한 턴).
    input.write(
      '{"jsonrpc":"2.0","id":4,"method":"chat/stop","params":{"interactionId":"int-live"}}\n',
    );
    const stopped = await collector.waitFor((message) => message.id === 4);
    assert.equal(stopped.result?.stopped, true);
    assert.deepEqual(mock.stopped, ['int-live']);
  } finally {
    rpc.close();
    input.destroy();
    output.destroy();
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

/** 기기를 옮겨 들어온 클라이언트는 [진행 중] 을 그대로 복원해야 한다. */
test('history/snapshot 은 지금 도는 턴을 함께 알려 준다', async () => {
  const mock = await startMockXgen();
  const input = new PassThrough();
  const output = new PassThrough();
  const engine = new DexEngine(new MemoryConfigStore(), new MemoryCredentialStore());
  const rpc = new DexRpcServer(engine, { input, output, log: () => {} });
  try {
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');
    await engine.login('me@corp.com', 'pw123');
    mock.running.add('int-live');
    const collector = collectLines(output);
    rpc.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n');
    await collector.waitFor((message) => message.id === 1);

    input.write(
      '{"jsonrpc":"2.0","id":2,"method":"history/snapshot","params":{"workflowId":"wf_abc","interactionId":"int-live"}}\n',
    );
    const live = await collector.waitFor((message) => message.id === 2);
    assert.equal(live.result?.running, true);
    assert.equal((live.result?.turns as unknown[]).length, 1);

    input.write(
      '{"jsonrpc":"2.0","id":3,"method":"history/snapshot","params":{"workflowId":"wf_abc","interactionId":"int-done"}}\n',
    );
    const done = await collector.waitFor((message) => message.id === 3);
    assert.equal(done.result?.running, false);
  } finally {
    rpc.close();
    input.destroy();
    output.destroy();
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

/** 대화 도중 모델 바꾸기 — 세션은 그대로, 다음 답변부터. 지금 모델이 늘 맨 앞이다. */
test('conversation/model 은 지금 모델을 맨 앞에 두고 바꾸고 되돌린다', async () => {
  const mock = await startMockXgen();
  const input = new PassThrough();
  const output = new PassThrough();
  const engine = new DexEngine(new MemoryConfigStore(), new MemoryCredentialStore());
  const rpc = new DexRpcServer(engine, { input, output, log: () => {} });
  try {
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');
    await engine.login('me@corp.com', 'pw123');
    const collector = collectLines(output);
    rpc.start();
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}\n');
    await collector.waitFor((message) => message.id === 1);

    input.write('{"jsonrpc":"2.0","id":2,"method":"conversation/model","params":{"workflowId":"wf_abc","interactionId":"int-1"}}\n');
    const first = await collector.waitFor((message) => message.id === 2);
    assert.equal((first.result?.current as { label: string }).label, 'Anthropic: Sonnet 4.5');
    assert.equal((first.result?.current as { source: string }).source, 'agent');

    input.write(
      '{"jsonrpc":"2.0","id":3,"method":"conversation/model/set","params":{"workflowId":"wf_abc","interactionId":"int-1","provider":"anthropic","model":"claude-haiku-4-5"}}\n',
    );
    const set = await collector.waitFor((message) => message.id === 3);
    assert.equal((set.result?.current as { label: string }).label, 'Anthropic: Haiku 4.5');
    assert.equal((set.result?.choices as Array<{ label: string }>)[0]!.label, 'Anthropic: Haiku 4.5', '지금 모델이 맨 앞');

    input.write('{"jsonrpc":"2.0","id":4,"method":"conversation/model/reset","params":{"workflowId":"wf_abc","interactionId":"int-1"}}\n');
    const reset = await collector.waitFor((message) => message.id === 4);
    assert.equal((reset.result?.current as { source: string }).source, 'agent');

    input.write(
      '{"jsonrpc":"2.0","id":5,"method":"conversation/model/set","params":{"workflowId":"wf_abc","interactionId":"int-1","provider":"openai","model":"gpt-9"}}\n',
    );
    const refused = await collector.waitFor((message) => message.id === 5);
    assert.ok(refused.error, '고를 수 없는 모델은 거절된다');
  } finally {
    rpc.close();
    input.destroy();
    output.destroy();
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
