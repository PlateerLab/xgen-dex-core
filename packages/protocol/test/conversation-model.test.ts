// 대화의 모델 — 서버 모양 해석, 지금 모델이 맨 앞, 소식으로 지금 모델만 바뀌는 것.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/client';
import {
  ConversationModelApi,
  applyModelNotice,
  orderedChoices,
  parseConversationModel,
} from '../src/conversation-model';

const SERVER = {
  supported: true,
  locked: false,
  current: { provider: 'anthropic', model: 'claude-haiku-4-5', name: 'Haiku 4.5', label: 'Anthropic: Haiku 4.5', group: 'Anthropic', source: 'agent' },
  agent: { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Anthropic: Haiku 4.5' },
  choices: [
    { provider: 'anthropic', model: 'claude-haiku-4-5', name: 'Haiku 4.5', label: 'Anthropic: Haiku 4.5', group: 'Anthropic' },
    { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI' },
  ],
};

test('서버 모양을 읽는다 — 이름은 서버가 준 "제공자: 모델"', () => {
  const s = parseConversationModel(SERVER);
  assert.equal(s.supported, true);
  assert.equal(s.current?.label, 'Anthropic: Haiku 4.5');
  assert.equal(s.current?.source, 'agent');
  assert.deepEqual(s.choices.map((c) => c.label), ['Anthropic: Haiku 4.5', 'OpenAI: GPT-4o']);
});

test('Geny 가 아니거나 옛 서버면 선택기가 없다', () => {
  assert.equal(parseConversationModel({ supported: false }).supported, false);
  assert.equal(parseConversationModel(null).supported, false);
});

test('다른 화면이 모델을 바꾼 소식 — 지금 모델이 맨 앞으로 온다', () => {
  const s = applyModelNotice(parseConversationModel(SERVER), {
    type: 'model',
    current: { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI', source: 'conversation' },
  });
  assert.equal(s.current?.label, 'OpenAI: GPT-4o');
  assert.equal(s.current?.source, 'conversation');
  assert.deepEqual(orderedChoices(s).map((c) => c.label), ['OpenAI: GPT-4o', 'Anthropic: Haiku 4.5']);
});

test('API — 옛 서버(404)는 선택기 없음, 고르기는 PUT, 되돌리기는 DELETE', async () => {
  const calls: string[] = [];
  const api = new ConversationModelApi({
    get: async (p: string) => {
      calls.push(`GET ${p}`);
      throw new ApiError(404, 'nope');
    },
    put: async (p: string, body?: unknown) => {
      calls.push(`PUT ${p} ${JSON.stringify(body)}`);
      return SERVER;
    },
    del: async (p: string) => {
      calls.push(`DELETE ${p}`);
      return SERVER;
    },
  } as never);
  assert.equal((await api.get('chat 1', 'wf1')).supported, false);
  await api.set('chat 1', 'wf1', { provider: 'openai', model: 'gpt-4o' });
  await api.reset('chat 1', 'wf1');
  assert.deepEqual(calls, [
    'GET /api/agentflow/conversations/chat%201/model?workflow_id=wf1',
    'PUT /api/agentflow/conversations/chat%201/model {"workflow_id":"wf1","provider":"openai","model":"gpt-4o"}',
    'DELETE /api/agentflow/conversations/chat%201/model?workflow_id=wf1',
  ]);
});
