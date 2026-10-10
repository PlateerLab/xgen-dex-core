import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { XdConversationListItem } from '../src/main/store';
import {
  agentNameTaken,
  conversationTitle,
  dropConversation,
  isExistingAgent,
  NEW_AGENT,
  replaceConversation,
  START_TEXT,
  startLock,
} from '../src/renderer/src/start-model';

const agents = [
  { id: 'a', name: 'Research' },
  { id: 'b', name: '리서치 도우미' },
];

test('에이전트 이름 겹침: 대소문자·앞뒤 빈칸·한글 조합 꼴을 가리지 않고, 자기 자신은 뺀다', () => {
  assert.equal(agentNameTaken('research', agents), true);
  assert.equal(agentNameTaken('  RESEARCH ', agents), true);
  assert.equal(agentNameTaken('리서치 도우미'.normalize('NFD'), agents), true);
  assert.equal(agentNameTaken('Research', agents, 'a'), false);
  assert.equal(agentNameTaken('Research 2', agents), false);
  assert.equal(agentNameTaken('   ', agents), false);
  assert.equal(agentNameTaken('아무거나', []), false);
});

test('시작 화면 잠금: 있는 에이전트는 바로 보내고, 새 에이전트는 이름, 겹침, 제공자, 모델 순으로 까닭 하나', () => {
  const base = { agentId: NEW_AGENT, name: '', accountId: 'acc', model: 'm' };
  assert.equal(startLock({ ...base, agentId: 'a' }, agents), null);
  assert.deepEqual(startLock(base, agents), { reason: 'name', message: '에이전트 이름을 먼저 입력해 주세요.' });
  assert.deepEqual(startLock({ ...base, name: ' research ' }, agents), {
    reason: 'duplicate',
    message: '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.',
  });
  assert.equal(startLock({ ...base, name: '새것', accountId: '' }, agents)?.message, START_TEXT.accountRequired);
  assert.equal(startLock({ ...base, name: '새것', model: '  ' }, agents)?.reason, 'model');
  assert.equal(startLock({ ...base, name: '새것' }, agents), null);
  // 고르고 있던 에이전트가 그 사이 지워졌다면 새 에이전트로 본다
  assert.equal(isExistingAgent('gone', agents), false);
  assert.equal(startLock({ ...base, agentId: 'gone' }, agents)?.reason, 'name');
  assert.equal(isExistingAgent(NEW_AGENT, agents), false);
});

const item = (id: string, title: string, updatedAt: number): XdConversationListItem => ({
  id,
  agentId: 'a',
  agentName: 'Research',
  title,
  createdAt: 1,
  updatedAt,
});

test('대화 줄: 빈 제목은 "새 대화", 이름을 바꾸면 그 자리에서 고치고, 지우면 빠진다', () => {
  assert.equal(conversationTitle({ title: '  ' }), '새 대화');
  assert.equal(conversationTitle({ title: '보고서' }), '보고서');
  const list = [item('c2', '둘째', 20), item('c1', '첫째', 10)];
  const renamed = replaceConversation(list, { id: 'c1', agentId: 'a', title: '새 이름', createdAt: 1, updatedAt: 10 });
  assert.deepEqual(
    renamed.map((c) => [c.id, c.title, c.agentName]),
    [
      ['c2', '둘째', 'Research'],
      ['c1', '새 이름', 'Research'],
    ],
  );
  assert.deepEqual(dropConversation(renamed, 'c2').map((c) => c.id), ['c1']);
});
