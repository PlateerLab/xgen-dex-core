import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Secrets } from '../src/main/secrets';
import { Store } from '../src/main/store';
import { TurnRunner, type EnginePort } from '../src/main/turn-runner';
import { createXdApi } from '../src/main/xd-api';

const plainCrypto = {
  available: () => true,
  backend: () => '',
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
};

function setup(allowFakeProvider = false) {
  const root = mkdtempSync(join(tmpdir(), 'xd-api-'));
  const workspaceDir = join(root, 'workspace');
  const stateDir = join(root, '.xd');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const store = new Store(join(stateDir, 'xd.db'));
  const secrets = new Secrets(join(stateDir, 'secrets'), plainCrypto);
  const pending: Array<() => void> = [];
  const engine: EnginePort = {
    turn: (cmd) => new Promise((resolve) => pending.push(() => resolve({ type: 'done', id: cmd.id }))),
    cancel: () => {},
    approvalReply: () => {},
  };
  const runner = new TurnRunner({ store, engine, secret: (id) => secrets.get(id), emit: () => {}, allowFakeProvider });
  const api = createXdApi({
    store,
    secrets,
    runner,
    engine: { info: null, running: false },
    workspaceDir,
    stateDir,
    allowFakeProvider,
  });
  return { api, store, root, workspaceDir, stateDir, pending };
}

test('에이전트를 만들면 작업 공간 폴더가 생기고, 같은 이름은 (2) 가 된다', () => {
  const { api, workspaceDir, store } = setup();
  const a = api.agentsCreate({ name: '리서치 도우미' });
  const b = api.agentsCreate({ name: '리서치 도우미' });
  assert.equal(a.workspace, '리서치 도우미');
  assert.equal(b.workspace, '리서치 도우미 (2)');
  assert.ok(existsSync(join(workspaceDir, '리서치 도우미')));
  assert.ok(existsSync(join(workspaceDir, '리서치 도우미 (2)')));
  // 디스크에 같은 이름의 폴더가 이미 있으면(지난 에이전트가 남긴 것) 그 폴더를 가로채지 않는다
  mkdirSync(join(workspaceDir, 'Notes'));
  assert.equal(api.agentsCreate({ name: 'Notes' }).workspace, 'Notes (2)');
  assert.throws(() => api.agentsCreate({ name: '   ' }), /name is required/);
  assert.throws(() => api.agentsCreate({ name: 'x', accountId: 'missing' }), /no account/);
  store.close();
});

test('에이전트를 지우면 엔진 상태는 지우고 작업 공간(사용자 파일)은 남긴다', () => {
  const { api, workspaceDir, stateDir, store } = setup();
  const a = api.agentsCreate({ name: 'Keep' });
  writeFileSync(join(workspaceDir, 'Keep', 'report.md'), '# mine');
  mkdirSync(join(stateDir, 'agents', a.id, 'memory'), { recursive: true });
  api.agentsDelete(a.id);
  assert.equal(api.agentsGet(a.id), null);
  assert.ok(existsSync(join(workspaceDir, 'Keep', 'report.md')));
  assert.equal(existsSync(join(stateDir, 'agents', a.id)), false);
  store.close();
});

test('대화를 지우면 그 대화의 기록(STM)만 지운다', async () => {
  const { api, stateDir, store, pending } = setup(true);
  const acc = api.accountsCreate({ kind: 'xd_fake', label: 'f' });
  const a = api.agentsCreate({ name: 'A', accountId: acc.id, model: 'm' });
  const { conversationId } = await api.turnSend({ agentId: a.id, text: 'q' });
  assert.throws(() => api.conversationsDelete(conversationId), /turn running/);
  pending.shift()?.();
  await new Promise((r) => setImmediate(r));
  const sessions = join(stateDir, 'agents', a.id, 'memory', 'sessions');
  mkdirSync(join(sessions, conversationId), { recursive: true });
  mkdirSync(join(sessions, 'other'), { recursive: true });
  api.conversationsDelete(conversationId);
  assert.equal(store.getConversation(conversationId), null);
  assert.equal(existsSync(join(sessions, conversationId)), false);
  assert.ok(existsSync(join(sessions, 'other')));
  store.close();
});

test('계정: 종류 검사, 키는 비밀 저장소에, 목록에는 있음/없음만', () => {
  const { api, store } = setup();
  assert.throws(() => api.accountsCreate({ kind: 'xd_fake', label: 'x' }), /unknown account kind/);
  assert.throws(() => api.accountsCreate({ kind: 'nope', label: 'x' }), /unknown account kind/);
  const acc = api.accountsCreate({ kind: 'anthropic', label: '내 키', secret: 'sk-ant-1' });
  assert.equal(acc.hasSecret, true);
  assert.equal(JSON.stringify(api.accountsList()).includes('sk-ant-1'), false);
  assert.equal(api.accountsSetSecret(acc.id, null).hasSecret, false);
  const local = api.accountsCreate({ kind: 'openai_compatible', label: 'Ollama', baseUrl: ' http://localhost:11434/v1 ' });
  assert.equal(local.baseUrl, 'http://localhost:11434/v1');
  api.accountsDelete(acc.id);
  assert.deepEqual(api.accountsList().map((a) => a.label), ['Ollama']);
  assert.deepEqual(api.secretsStatus(), { encrypted: true, backend: '' });
  store.close();
});

test('모델 목록: API 종류는 엔진에 묻고, Claude Code 는 별칭, Codex 는 홈의 캐시', async () => {
  const { api, store, stateDir } = setup();
  const asked: unknown[] = [];
  const codexHome = join(stateDir, 'cli', 'codex', 'home');
  mkdirSync(codexHome, { recursive: true });
  const withEngine = createXdApi({
    store,
    secrets: new Secrets(join(stateDir, 'secrets'), plainCrypto),
    runner: new TurnRunner({ store, engine: { turn: async () => ({ type: 'done', id: 'x' }), cancel() {}, approvalReply() {} }, secret: () => null, emit() {} }),
    engine: {
      info: null,
      running: false,
      models: async (input) => {
        asked.push(input);
        return { ok: true, models: [{ id: 'm1' }] };
      },
    },
    cli: { home: () => codexHome } as never,
    workspaceDir: join(stateDir, '..', 'workspace'),
    stateDir,
  });
  const acc = withEngine.accountsCreate({ kind: 'openai_compatible', label: 'vLLM', baseUrl: 'http://h:8000/v1', secret: 'k' });
  assert.deepEqual(await withEngine.modelsList(acc.id), { ok: true, models: [{ id: 'm1' }] });
  assert.deepEqual(asked.pop(), { provider: 'vllm', apiKey: 'k', baseUrl: 'http://h:8000/v1' });
  await withEngine.modelsProbe({ kind: 'ollama', baseUrl: ' ' });
  assert.deepEqual(asked.pop(), { provider: 'ollama', apiKey: null, baseUrl: null });
  const claude = withEngine.accountsCreate({ kind: 'claude_code', label: 'Claude' });
  assert.deepEqual((await withEngine.modelsList(claude.id)).models.map((m) => m.id), ['sonnet', 'opus', 'haiku']);
  const codex = withEngine.accountsCreate({ kind: 'codex', label: 'Codex' });
  assert.deepEqual(await withEngine.modelsList(codex.id), { ok: false, models: [], error: 'not_cached' });
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-x', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] }));
  assert.deepEqual((await withEngine.modelsList(codex.id)).models, [{ id: 'gpt-x' }]);
  assert.equal(asked.length, 0); // CLI 는 엔진에 묻지 않는다
  void api;
  store.close();
});
