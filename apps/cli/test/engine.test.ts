import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryConfigStore } from '@dex/engine';
import { MemoryCredentialStore } from '@dex/engine';
import { DexEngine } from '@dex/engine';
import { startMockXgen } from './mock-xgen';

test('engine covers profile → login → restore → agents → streamed chat → history', async () => {
  const mock = await startMockXgen();
  const configs = new MemoryConfigStore();
  const credentials = new MemoryCredentialStore();
  try {
    const engine = new DexEngine(configs, credentials);
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');

    const login = await engine.login('me@corp.com', 'pw123');
    assert.equal(login.authenticated, true);
    assert.equal(login.user?.username, 'alice');
    assert.equal((await credentials.get('corp'))?.accessToken, 'ACCESS.jwt');

    const restored = await new DexEngine(configs, credentials).authStatus();
    assert.equal(restored.authenticated, true);
    assert.equal(restored.user?.permissions.includes('main.agentflow:read'), true);

    const agents = await engine.listAgents();
    assert.equal(agents.items[0]?.workflowId, 'wf_abc');

    const events = [];
    for await (const event of engine.chat({ workflowId: 'wf_abc', input: 'hello' })) events.push(event);
    assert.equal(events.some((event) => event.kind === 'tool'), true);
    assert.equal(
      events.filter((event) => event.kind === 'text').map((event) => event.content).join(''),
      'You said: hello',
    );
    assert.deepEqual(mock.requests.chatInputs, ['hello']);

    assert.equal((await engine.listConversations())[0]?.interactionId, 'interaction-1');
    assert.equal((await engine.historyTurns('wf_abc', 'interaction-1'))[0]?.output, 'world');
  } finally {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('대화 목록: 마지막으로 말한 순서로 한 쪽씩, 이름 바꾸기·지우기·사라진 에이전트 대화 정리', async () => {
  const mock = await startMockXgen();
  try {
    const engine = new DexEngine(new MemoryConfigStore(), new MemoryCredentialStore());
    await engine.setProfile('corp', mock.baseUrl);
    await engine.useProfile('corp');
    await engine.login('me@corp.com', 'pw123');

    // 한 줄에 제목·꼬리표·[지워짐] 이 실려 온다. 사라진 에이전트 수는 첫 쪽에만 온다.
    const first = await engine.conversationPage({ limit: 1 });
    assert.equal(first.conversations[0]?.title, 'hello');
    assert.equal(first.conversations[0]?.agentDeleted, false);
    assert.equal(first.agentDeletedCount, 1);
    assert.ok(first.nextCursor, '다음 쪽이 있다');
    const second = await engine.conversationPage({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.conversations[0]?.tag, 'teams');
    assert.equal(second.conversations[0]?.agentDeleted, true);
    assert.equal(second.nextCursor, null);
    assert.equal(second.agentDeletedCount, undefined);

    // 이름 바꾸기: 빈 이름이면 첫 메시지 제목으로 돌아간다.
    assert.deepEqual(await engine.renameConversation('wf_abc', 'interaction-1', '분기 보고'), {
      title: '분기 보고',
      customTitle: true,
    });
    assert.deepEqual(await engine.renameConversation('wf_abc', 'interaction-1', ''), {
      title: 'hello',
      customTitle: false,
    });

    // 이름 겹침 검사.
    assert.equal(await engine.agentNameTaken('Sales Agent'), true);
    assert.equal(await engine.agentNameTaken('새 도우미'), false);

    // 사라진 에이전트 대화 정리 → 지운 수, 그리고 한 대화 지우기.
    assert.equal(await engine.purgeDeletedAgentConversations(), 1);
    await engine.deleteConversation('wf_abc', 'interaction-1', 'Sales Agent');
    assert.deepEqual((await engine.conversationPage()).conversations, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      mock.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('changing a profile server invalidates credentials for the old origin', async () => {
  const configs = new MemoryConfigStore();
  const credentials = new MemoryCredentialStore();
  const engine = new DexEngine(configs, credentials);
  await engine.setProfile('corp', 'https://first.example.com');
  await credentials.set('corp', {
    serverUrl: 'https://first.example.com',
    accessToken: 'secret',
  });
  await engine.setProfile('corp', 'https://second.example.com');
  assert.equal(await credentials.get('corp'), null);
});
