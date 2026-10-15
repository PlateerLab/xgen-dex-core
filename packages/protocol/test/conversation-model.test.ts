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

// ── 생각(thinking) — 지금 모델이 받는 값만 (2026-10-01) ──────────────

import {
  THINKING_PICKER_TEXT,
  parseThinking,
  selectedThinking,
  thinkingChipLabel,
  thinkingValueLabel,
} from '../src/conversation-model';

const THINKING = {
  supported: true,
  kind: 'levels',
  options: ['auto', 'off', 'low', 'medium', 'high', 'max'],
  default: 'off',
  can_disable: true,
  verified: true,
  current: 'high',
  selected: 'xhigh',
  source: 'conversation',
};

test('생각 묶음을 읽는다 — 고른 값(xhigh)과 이 모델에서 쓰는 값(high)이 다를 수 있다', () => {
  const s = parseConversationModel({ ...SERVER, thinking: THINKING });
  const t = s.thinking!;
  assert.equal(t.supported, true);
  assert.deepEqual(t.options, ['auto', 'off', 'low', 'medium', 'high', 'max']);
  assert.equal(t.current, 'high');
  assert.equal(selectedThinking(t), 'high', 'xhigh 를 받지 않는 모델 — 실제로 쓰는 high');
  assert.equal(thinkingChipLabel(t), '생각: 높게');
});

test('고른 값을 지금 모델이 받지 않으면 실제로 쓰는 값이 눌린다', () => {
  const t = parseThinking({ ...THINKING, options: ['auto', 'low', 'medium', 'high'], selected: 'off', current: 'low' })!;
  assert.equal(selectedThinking(t), 'low');
});

test('조절할 수 없는 모델 — 선택지 없이 "생각 조절 불가"', () => {
  const t = parseThinking({ supported: false, kind: 'none', options: [], current: 'auto', source: 'agent' })!;
  assert.equal(t.supported, false);
  assert.deepEqual(t.options, []);
  assert.equal(thinkingChipLabel(t), THINKING_PICKER_TEXT.unsupported);
});

test('켜기/끄기만 받는 모델 — 선택지는 기본·끄기·켜기', () => {
  const t = parseThinking({ supported: true, kind: 'toggle', options: ['auto', 'off', 'on'], current: 'on', source: 'agent' })!;
  assert.equal(t.kind, 'toggle');
  assert.deepEqual(t.options.map(thinkingValueLabel), ['기본', '끄기', '켜기']);
  assert.equal(selectedThinking(t), 'auto', '에이전트 설정을 따르면 기본이 눌려 있다');
});

test('옛 서버(생각 묶음 없음)는 null — 선택기를 그리지 않는다', () => {
  assert.equal(parseConversationModel(SERVER).thinking, null);
  assert.equal(thinkingChipLabel(null), '');
});

test('모델 소식에 실린 생각 묶음으로 바뀐다 — 모델이 바뀌면 받을 수 있는 값도 바뀐다', () => {
  const before = parseConversationModel({ ...SERVER, thinking: THINKING });
  const after = applyModelNotice(before, {
    current: { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', label: 'OpenAI: GPT-4o', group: 'OpenAI', source: 'conversation' },
    thinking: { supported: false, kind: 'none', options: [], current: 'auto', selected: 'xhigh', source: 'conversation' },
  });
  assert.equal(after.thinking?.supported, false);
  const untouched = applyModelNotice(before, { current: SERVER.current });
  assert.equal(untouched.thinking?.current, 'high', '옛 서버의 소식(생각 없음)은 생각을 그대로 둔다');
});

test('생각 값을 고르고 되돌린다 — PUT/DELETE …/thinking', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const http = {
    get: async () => ({}),
    put: async (url: string, body: unknown) => { calls.push(['PUT', url, body]); return { ...SERVER, thinking: THINKING }; },
    del: async (url: string) => { calls.push(['DELETE', url, null]); return { ...SERVER, thinking: { ...THINKING, source: 'agent' } }; },
  };
  const api = new ConversationModelApi(http as never);
  const set = await api.setThinking('conn-1', 'wf-1', 'high');
  assert.equal(set.thinking?.current, 'high');
  assert.deepEqual(calls[0], ['PUT', '/api/agentflow/conversations/conn-1/thinking', { workflow_id: 'wf-1', thinking: 'high' }]);
  const reset = await api.resetThinking('conn-1', 'wf-1');
  assert.equal(reset.thinking?.source, 'agent');
  assert.equal(calls[1][1], '/api/agentflow/conversations/conn-1/thinking?workflow_id=wf-1');
});
