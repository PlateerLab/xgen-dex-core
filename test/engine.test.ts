import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryConfigStore } from '../src/config-store';
import { MemoryCredentialStore } from '../src/credential-store';
import { DexEngine } from '../src/engine';
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
