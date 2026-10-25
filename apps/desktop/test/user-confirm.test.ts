import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UserConfirmRequest } from '@dex/protocol/user-confirm';
import type { LocalToolCallContext } from '@dex/engine/local-tools';
import {
  USER_CONFIRM_TOOL,
  USER_CONFIRM_WAIT_MS,
  UserConfirmCenter,
  UserConfirmTools,
  userConfirmToolSchema,
  type UserConfirmAnswer,
  type UserConfirmAsk,
} from '../src/main/user-confirm';
import { confirmsFor } from '../src/renderer/src/browser-confirm-store';
import { leftText } from '../src/renderer/src/user-confirm-store';
import { UserConfirmCard } from '../src/renderer/src/views/UserConfirmCard';

// 10/25 박소민 시나리오 — "내 확인을 받아 등록해 줘" 에 에이전트가 답변으로 묻고 턴을 끝내, 사용자가 "진행해줘" 를 보내면
// 새 턴이 처음부터 다시 시작했다. 확인은 같은 턴 안의 카드로 받는다.

const context = (overrides: Partial<LocalToolCallContext> = {}): LocalToolCallContext => ({
  workflowId: 'wf',
  workflowName: '상품 등록',
  interactionId: 'chat-1',
  deadlineAt: Date.now() + 599_000,
  ...overrides,
});

/** 답을 미리 정해 둔 asker — 받은 카드 내용과 대기 시간을 기록한다. */
function asker(answer: UserConfirmAnswer) {
  const asked: { request: UserConfirmAsk; waitMs: number }[] = [];
  return {
    asked,
    ask: async (request: UserConfirmAsk, waitMs: number) => {
      asked.push({ request, waitMs });
      return answer;
    },
  };
}

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text) as Record<string, string>;

test('the schema says what it does on its first line, short enough for the hidden tool catalog', () => {
  const schema = userConfirmToolSchema();
  assert.equal(schema.name, USER_CONFIRM_TOOL);
  const firstLine = String(schema.description).split('\n')[0];
  assert.ok(firstLine.length <= 72, firstLine);
  assert.match(firstLine, /confirm/);
  assert.deepEqual((schema.inputSchema as { required: string[] }).required, ['question']);
  assert.ok(USER_CONFIRM_WAIT_MS < 600_000, 'the server waits 600s for a device call');
});

test('the center shows a card per request, answers by id and drops it on timeout or abort', async () => {
  const pushed: UserConfirmRequest[][] = [];
  const notified: string[] = [];
  const center = new UserConfirmCenter({ push: (requests) => pushed.push(requests), notify: (request) => notified.push(request.question) });

  const proceed = center.ask({ workflowId: 'wf', interactionId: 'chat-1', question: '이대로 입력할까요?', details: '키워드: 가방' }, 60_000);
  const card = center.list()[0];
  assert.equal(card.question, '이대로 입력할까요?');
  assert.equal(card.details, '키워드: 가방');
  assert.equal(card.expiresAt - card.createdAt, 60_000);
  assert.deepEqual(notified, ['이대로 입력할까요?']);
  assert.equal(center.resolve({ requestId: card.requestId, choice: 'once' as never }), false);
  assert.equal(center.resolve({ requestId: card.requestId, choice: 'proceed', message: 'ignored' }), true);
  assert.deepEqual(await proceed, { choice: 'proceed' });
  assert.equal(center.resolve({ requestId: card.requestId, choice: 'proceed' }), false);
  assert.deepEqual(pushed.at(-1), []);

  const revise = center.ask({ workflowId: 'wf', question: 'q' }, 60_000);
  center.resolve({ requestId: center.list()[0].requestId, choice: 'revise', message: '  키워드에 선물용 추가  ' });
  assert.deepEqual(await revise, { choice: 'revise', message: '키워드에 선물용 추가' });

  assert.deepEqual(await center.ask({ workflowId: 'wf', question: 'q' }, 20), { choice: 'none', timedOut: true });
  const controller = new AbortController();
  const aborted = center.ask({ workflowId: 'wf', question: 'q' }, 60_000, controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { choice: 'none' });
  assert.deepEqual(center.list(), []);
});

test('proceed and revise come back as this turn\'s tool result', async () => {
  const yes = asker({ choice: 'proceed' });
  const proceed = parse(await new UserConfirmTools(yes).callTool(USER_CONFIRM_TOOL, { question: ' 이대로 입력할까요? ', details: '초안' }, context()));
  assert.equal(proceed.answer, 'proceed');
  assert.deepEqual(yes.asked[0].request, { workflowId: 'wf', workflowName: '상품 등록', interactionId: 'chat-1', question: '이대로 입력할까요?', details: '초안' });
  assert.equal(yes.asked[0].waitMs, USER_CONFIRM_WAIT_MS);

  const revise = parse(await new UserConfirmTools(asker({ choice: 'revise', message: '키워드에 선물용 추가' })).callTool(USER_CONFIRM_TOOL, { question: 'q' }, context()));
  assert.equal(revise.answer, 'revise');
  assert.equal(revise.message, '키워드에 선물용 추가');
  assert.match(revise.note, /다시 부르세요/);
});

test('a refusal without words is the user denial; no answer tells the agent to ask in its reply', async () => {
  await assert.rejects(
    new UserConfirmTools(asker({ choice: 'revise' })).callTool(USER_CONFIRM_TOOL, { question: 'q' }, context()),
    (error: Error) => /^user_denied: 사용자가 진행하지 않기로/.test(error.message),
  );
  const none = parse(await new UserConfirmTools(asker({ choice: 'none', timedOut: true })).callTool(USER_CONFIRM_TOOL, { question: 'q' }, context()));
  assert.equal(none.answer, 'none');
  assert.match(none.note, /답하지 않았습니다.*답변에 써서 턴을 끝내세요/);
});

test('remote turns, a missing question and a near deadline do not show a card', async () => {
  const never = asker({ choice: 'proceed' });
  const tools = new UserConfirmTools(never);
  const remote = parse(await tools.callTool(USER_CONFIRM_TOOL, { question: 'q' }, context({ remote: true, originName: '웹' })));
  assert.equal(remote.answer, 'unavailable');
  assert.match(remote.note, /웹에서 와서/);
  await assert.rejects(tools.callTool(USER_CONFIRM_TOOL, { question: '  ' }, context()), /question 이 비어/);
  assert.equal(parse(await tools.callTool(USER_CONFIRM_TOOL, { question: 'q' }, context({ deadlineAt: Date.now() + 8_000 }))).answer, 'unavailable');
  assert.equal(never.asked.length, 0);

  // 서버가 준 시한이 짧으면 그 안에서 끝낸다.
  const short = asker({ choice: 'proceed' });
  await new UserConfirmTools(short).callTool(USER_CONFIRM_TOOL, { question: 'q' }, context({ deadlineAt: Date.now() + 120_000 }));
  assert.ok(short.asked[0].waitMs <= 115_000 && short.asked[0].waitMs > 100_000, String(short.asked[0].waitMs));
});

test('the chat shows its own card with the question, the details and two choices', () => {
  const card = (requestId: string, interactionId: string | undefined, createdAt: number): UserConfirmRequest => ({
    requestId, workflowId: 'wf', interactionId, question: '이 내용으로 BO 에 입력하고 임시저장할까요?', details: '소개문: …\n키워드: 가방, 선물', createdAt, expiresAt: createdAt + 480_000,
  });
  const all = [card('b', 'chat-1', 2), card('a', 'chat-1', 1), card('c', 'chat-2', 0)];
  assert.deepEqual(confirmsFor(all, 'chat-1', 'wf').map((r) => r.requestId), ['a', 'b']);
  const html = renderToStaticMarkup(React.createElement(UserConfirmCard, { request: all[1] }));
  assert.match(html, /이 내용으로 BO 에 입력하고 임시저장할까요\?/);
  assert.match(html, /키워드: 가방, 선물/);
  assert.match(html, /진행<\/button>/);
  assert.match(html, /고칠 점 말하기/);
  assert.equal(leftText(479), '7분 59초');
  assert.equal(leftText(42), '42초');
});
