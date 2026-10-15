import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, TurnCommand, TurnTerminal } from '../src/main/engine-service';
import { Store } from '../src/main/store';
import { BusyError, TurnRunner, engineConfig, type EnginePort, type XdTurnEvent } from '../src/main/turn-runner';

/** 시험이 사건을 흘려 넣는 엔진. */
class FakeEngine implements EnginePort {
  calls: TurnCommand[] = [];
  cancelled: string[] = [];
  replies: Array<[string, string, string]> = [];
  private pending = new Map<string, { listener: (e: EngineEvent) => void; resolve: (t: TurnTerminal) => void }>();

  turn(cmd: TurnCommand, listener: (e: EngineEvent) => void): Promise<TurnTerminal> {
    this.calls.push(cmd);
    return new Promise((resolve) => this.pending.set(cmd.id, { listener, resolve }));
  }
  push(id: string, event: EngineEvent): void {
    this.pending.get(id)?.listener({ ...event, id });
  }
  end(id: string, terminal: Omit<TurnTerminal, 'id'>): void {
    const p = this.pending.get(id);
    this.pending.delete(id);
    p?.listener({ ...terminal, id } as EngineEvent);
    p?.resolve({ ...terminal, id } as TurnTerminal);
  }
  cancel(id: string): void {
    this.cancelled.push(id);
  }
  approvalReply(id: string, request: string, answer: string): void {
    this.replies.push([id, request, answer]);
  }
}

function setup(opts: { kind?: string; secret?: string | null; confirm?: (c: string, agentName: string) => Promise<'once' | 'session' | 'deny'> } = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'xd-runner-')), 'xd.db'));
  const engine = new FakeEngine();
  const events: XdTurnEvent[] = [];
  const account = store.createAccount({ kind: opts.kind ?? 'anthropic', label: 'k', baseUrl: opts.kind === 'openai_compatible' ? 'http://localhost:11434/v1' : null });
  const agent = store.createAgent({ name: '리서치', workspace: '리서치', accountId: account.id, model: 'claude-x', options: { temperature: 0.3, settings: { GENY_TOOLS_WEB_ENABLED: '0' } } });
  const runner = new TurnRunner({
    store,
    engine,
    secret: () => (opts.secret === undefined ? 'sk-test' : opts.secret),
    emit: (e) => events.push(e),
    confirmDangerous: opts.confirm ? (c, ctx) => opts.confirm!(c, ctx.agentName) : undefined,
  });
  return { store, engine, events, runner, agent, account };
}

const chatKinds = (events: XdTurnEvent[]) =>
  events.filter((e) => e.type === 'chat').map((e) => (e.type === 'chat' ? e.event.kind : ''));

test('턴의 사건이 Dex 화면 모양으로 나가고, 끝나면 답·작업 과정·사용량이 저장된다', async () => {
  const { store, engine, events, runner, agent } = setup();
  const { turnId, conversationId, done } = runner.send({ agentId: agent.id, text: '찾아 줘' });
  engine.push(turnId, { type: 'started' });
  engine.push(turnId, { type: 'chunk', text: '찾아' });
  engine.push(turnId, { type: 'chunk', text: '봅니다. ' });
  engine.push(turnId, { type: 'tool', event: { type: 'tool_call', tool_name: 'Read', tool_input: '{"file_path":"a"}', tool_use_id: 'u1' } });
  engine.push(turnId, { type: 'tool', event: { type: 'tool_result', tool_name: 'Read', result: 'A', tool_use_id: 'u1', duration_ms: 3 } });
  engine.push(turnId, { type: 'chunk', text: '끝.' });
  engine.push(turnId, { type: 'usage', usage: { input_tokens: 5, output_tokens: 2 } });
  engine.end(turnId, { type: 'done' });
  const saved = await done;

  assert.deepEqual(chatKinds(events), ['text', 'text', 'tool', 'tool', 'text', 'end']);
  const tool = events.find((e) => e.type === 'chat' && e.event.kind === 'tool');
  assert.equal(tool?.type === 'chat' && tool.event.kind === 'tool' && tool.event.event.toolName, 'Read');
  assert.equal(saved.status, 'done');
  assert.equal(saved.answer, '찾아봅니다. 끝.');
  assert.deepEqual(
    (saved.process as Array<{ kind: string }>).map((p) => p.kind),
    ['text', 'tool', 'tool', 'text'],
  );
  assert.deepEqual(saved.usage, { input_tokens: 5, output_tokens: 2 });
  assert.equal(events[events.length - 1].type, 'finished');

  // 엔진에 간 명령 — 에이전트·제공자 설정·옵션
  const cmd = engine.calls[0];
  assert.equal(cmd.conversation, conversationId);
  assert.deepEqual(cmd.agent, { id: agent.id, name: '리서치', workspace: '리서치', folders: [], memory: true });
  assert.deepEqual(cmd.config, {
    provider: 'anthropic',
    model: 'claude-x',
    api_key: 'sk-test',
    temperature: 0.3,
    settings: { GENY_TOOLS_WEB_ENABLED: '0' },
  });
  assert.deepEqual(cmd.history, []);

  // 같은 대화의 다음 턴에는 앞 턴이 이력으로 간다
  const second = runner.send({ agentId: agent.id, conversationId, text: '이어서' });
  assert.deepEqual(engine.calls[1].history, [
    { role: 'user', content: '찾아 줘' },
    { role: 'assistant', content: '찾아봅니다. 끝.' },
  ]);
  engine.end(second.turnId, { type: 'done' });
  await second.done;
  assert.equal(store.listTurns(conversationId).length, 2);
  store.close();
});

test('화면이 만든 대화 id 를 그대로 쓴다', async () => {
  const { store, engine, runner, agent } = setup();
  const id = `conn-${agent.id}-1759400000000`;
  const t = runner.send({ agentId: agent.id, conversationId: id, text: 'q' });
  assert.equal(t.conversationId, id);
  engine.end(t.turnId, { type: 'done' });
  await t.done;
  assert.equal(store.getConversation(id)?.agentId, agent.id);
  assert.throws(() => runner.send({ agentId: agent.id, conversationId: 'bad id!', text: 'q' }));
  store.close();
});

test('대화 하나에 턴 하나 — 도는 중에 보내면 거절하고 기록하지 않는다', async () => {
  const { store, engine, runner, agent } = setup();
  const first = runner.send({ agentId: agent.id, text: 'q1' });
  assert.throws(() => runner.send({ agentId: agent.id, conversationId: first.conversationId, text: 'q2' }), BusyError);
  assert.equal(store.listTurns(first.conversationId).length, 1);
  engine.end(first.turnId, { type: 'done' });
  await first.done;
  store.close();
});

test('계정·키·모델이 없으면 엔진에 가지 않고 그 까닭으로 끝난다', async () => {
  const noKey = setup({ secret: null });
  const t = noKey.runner.send({ agentId: noKey.agent.id, text: 'q' });
  const saved = await t.done;
  assert.equal(saved.status, 'error');
  assert.equal(saved.error?.code, 'no_key');
  assert.equal(noKey.engine.calls.length, 0);
  const err = noKey.events.find((e) => e.type === 'chat' && e.event.kind === 'error');
  assert.equal(err?.type === 'chat' && err.event.kind === 'error' && err.event.info?.title, '이 제공자의 API 키가 없습니다.');

  const { store, runner, agent } = setup();
  store.updateAgent(agent.id, { accountId: null });
  assert.equal((await runner.send({ agentId: agent.id, text: 'q' }).done).error?.code, 'no_account');
  store.close();
  noKey.store.close();
});

test('OpenAI 호환은 키 없이, 주소와 함께 vllm 으로 간다', async () => {
  const { store, engine, runner, agent } = setup({ kind: 'openai_compatible', secret: null });
  const t = runner.send({ agentId: agent.id, text: 'q' });
  assert.equal(engine.calls[0].config.provider, 'vllm');
  assert.equal(engine.calls[0].config.base_url, 'http://localhost:11434/v1');
  assert.equal('api_key' in engine.calls[0].config, false);
  engine.end(t.turnId, { type: 'done' });
  await t.done;
  store.close();
});

test('엔진의 실패는 사람이 읽는 말과 함께 error 로 저장된다', async () => {
  const { store, engine, events, runner, agent } = setup();
  const t = runner.send({ agentId: agent.id, text: 'q' });
  engine.push(t.turnId, { type: 'chunk', text: '부분 답' });
  engine.end(t.turnId, { type: 'error', code: 'runtime', message: 'Error code: 401 - invalid x-api-key' } as never);
  const saved = await t.done;
  assert.equal(saved.status, 'error');
  assert.equal(saved.answer, '부분 답');
  assert.deepEqual(saved.error, { code: 'runtime', message: 'Error code: 401 - invalid x-api-key' });
  const err = events.find((e) => e.type === 'chat' && e.event.kind === 'error');
  assert.ok(err?.type === 'chat' && err.event.kind === 'error' && err.event.info?.title);
  store.close();
});

test('정지는 그 대화의 턴을 엔진에 취소로 보내고, cancelled 로 저장된다', async () => {
  const { store, engine, runner, agent } = setup();
  const t = runner.send({ agentId: agent.id, text: 'q' });
  assert.equal(runner.cancelConversation(t.conversationId), true);
  assert.deepEqual(engine.cancelled, [t.turnId]);
  engine.end(t.turnId, { type: 'cancelled' });
  assert.equal((await t.done).status, 'cancelled');
  assert.equal(runner.cancelConversation(t.conversationId), false);
  store.close();
});

test('위험 명령은 확인 창의 대답을 엔진에 돌려주고, 물을 수 없으면 거부한다', async () => {
  const asked: string[] = [];
  const { store, engine, events, runner, agent } = setup({
    confirm: async (c, agentName) => {
      asked.push(`${agentName}: ${c}`);
      return 'session';
    },
  });
  const t = runner.send({ agentId: agent.id, text: 'q' });
  engine.push(t.turnId, { type: 'approval_request', request: 'r1', command: 'rm -rf build' });
  await new Promise((r) => setImmediate(r));
  // 누가 묻는지(에이전트 이름)와 함께 묻고, 대답하면 화면의 "묻는 중" 을 걷는 사건이 나간다
  assert.deepEqual(asked, ['리서치: rm -rf build']);
  assert.deepEqual(engine.replies, [[t.turnId, 'r1', 'session']]);
  assert.ok(events.some((e) => e.type === 'approval' && e.command === 'rm -rf build'));
  assert.ok(events.some((e) => e.type === 'approval_done' && e.request === 'r1' && e.answer === 'session'));
  engine.end(t.turnId, { type: 'done' });
  await t.done;
  store.close();

  const silent = setup();
  const t2 = silent.runner.send({ agentId: silent.agent.id, text: 'q' });
  silent.engine.push(t2.turnId, { type: 'approval_request', request: 'r1', command: 'rm -rf x' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(silent.engine.replies, [[t2.turnId, 'r1', 'deny']]);
  silent.engine.end(t2.turnId, { type: 'done' });
  await t2.done;
  silent.store.close();
});

test('시험용 제공자는 허락했을 때만', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'xd-runner-')), 'xd.db'));
  const acc = store.createAccount({ kind: 'xd_fake', label: 'fake' });
  const agent = store.createAgent({ name: 'A', workspace: 'A', accountId: acc.id, model: 'm' });
  assert.deepEqual(engineConfig(agent, acc, null), { ok: false, code: 'unsupported_provider', message: 'account kind xd_fake' });
  assert.equal(engineConfig(agent, acc, null, { allowFakeProvider: true }).ok, true);
  store.close();
});

test('CLI 계정: 실행 파일·전용 홈·인증 방식이 엔진 설정으로 가고, 구독 로그인에는 키를 싣지 않는다', () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'xd-runner-')), 'xd.db'));
  const cli = (name: 'claude' | 'codex') => (name === 'claude' ? { binary: '/x/claude', home: '/r/.xd/cli/claude/home' } : null);
  const oauth = store.createAccount({ kind: 'claude_code', label: 'c' });
  const agent = store.createAgent({ name: 'A', workspace: 'A', accountId: oauth.id, model: 'sonnet' });
  const sub = engineConfig(agent, oauth, 'sk-should-not-go', { cli });
  assert.deepEqual(sub, { ok: true, config: { provider: 'claude_code', model: 'sonnet', cli: { binary: '/x/claude', home: '/r/.xd/cli/claude/home', auth: 'oauth' } } });

  const keyed = store.createAccount({ kind: 'claude_code', label: 'k', baseUrl: 'http://gw', settings: { auth: 'api_key' } });
  assert.deepEqual(engineConfig(agent, keyed, null, { cli }), { ok: false, code: 'no_key', message: 'no API key for claude_code' });
  const withKey = engineConfig(agent, keyed, 'sk-1', { cli });
  assert.equal(withKey.ok && withKey.config.api_key, 'sk-1');
  assert.equal(withKey.ok && withKey.config.base_url, 'http://gw');

  const codex = store.createAccount({ kind: 'codex', label: 'x' });
  assert.deepEqual(engineConfig(agent, codex, null, { cli }), { ok: false, code: 'no_cli', message: 'codex is not installed' });
  const vllm = store.createAccount({ kind: 'openai_compatible', label: 'v' });
  assert.equal(engineConfig(agent, vllm, null, { cli }).ok, false);
  const ollama = store.createAccount({ kind: 'ollama', label: 'o' });
  assert.deepEqual(engineConfig(agent, ollama, null), { ok: true, config: { provider: 'ollama', model: 'sonnet' } });
  store.close();
});

test('MCP: 턴에 켜 둔 서버를 비밀을 되살려 싣고, 엔진의 상태 사건을 화면으로 넘긴다', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'xd-runner-')), 'xd.db'));
  const engine = new FakeEngine();
  const events: XdTurnEvent[] = [];
  const account = store.createAccount({ kind: 'anthropic', label: 'k' });
  const agent = store.createAgent({
    name: 'M',
    workspace: 'M',
    accountId: account.id,
    model: 'claude-x',
    options: { mcpServers: [{ name: 'Demo', transport: 'stdio', command: 'demo --x', env: { T: '' } }, { name: 'Off', command: 'y', enabled: false }] },
  });
  const runner = new TurnRunner({
    store,
    engine,
    secret: (id) => (id === `mcp-${agent.id}` ? JSON.stringify({ Demo: { env: { T: 's3' } } }) : 'sk-test'),
    emit: (e) => events.push(e),
  });
  const t = runner.send({ agentId: agent.id, text: 'q' });
  assert.deepEqual(engine.calls[0].agent.mcp_servers, [{ slug: 'demo', label: 'Demo', transport: 'stdio', command: 'demo', args: ['--x'], env: { T: 's3' } }]);
  engine.push(t.turnId, { type: 'mcp', servers: [{ slug: 'demo', label: 'Demo', state: 'failed', error: 'boom', tools: 0 }] });
  assert.deepEqual(
    events.filter((e) => e.type === 'mcp').map((e) => (e as Extract<XdTurnEvent, { type: 'mcp' }>).servers),
    [[{ slug: 'demo', label: 'Demo', state: 'failed', error: 'boom', tools: 0 }]],
  );
  engine.end(t.turnId, { type: 'done' });
  await t.done;
  store.close();
});
