import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrowserConfirmRequest, BrowserPageInfo } from '@dex/protocol/browser';
import {
  BrowserConfirmCenter,
  CONFIRM_DIALOG_SCRIPT,
  PAGE_MESSAGES_SCRIPT,
  confirmPress,
  type ConfirmAnswer,
  type ConfirmRequest,
  type PageDialog,
} from '../src/main/browser-confirm';
import type { BrowserRuntime } from '../src/main/browser-runtime';
import { BROWSER_INTERACT_TOOL, BrowserToolProvider } from '../src/main/browser-tools';
import { confirmsFor } from '../src/renderer/src/browser-confirm-store';
import { ConfirmCard } from '../src/renderer/src/views/ConfirmCard';

// 사이트 확인창("…하시겠습니까?" 확인·취소)의 확정 버튼은 사용자가 허락해야 누른다 — 10/22 trace 54448 에서 에이전트가
// 승인요청 확인창의 확인까지 눌러 시연 상품이 실제로 승인요청됐다.

const SAVE: PageDialog = { text: '승인요청하시겠습니까?', buttons: ['취소', '확인'] };

/** 스크립트가 쓰는 만큼만 흉내 낸 DOM — 대화상자 하나(입력칸·버튼). */
function dom(dialog: { text: string; buttons: string[]; fields?: number } | null, alerts: string[] = []) {
  const node = (text: string) => ({ innerText: text, value: '', title: '', getAttribute: () => null, getClientRects: () => [1] });
  const top = dialog && {
    ...node(`${dialog.text} ${dialog.buttons.join(' ')}`),
    querySelectorAll: (selector: string) =>
      selector.startsWith('input') ? Array.from({ length: dialog.fields ?? 0 }, () => node('')) : dialog.buttons.map(node),
  };
  return {
    document: {
      querySelectorAll: (selector: string) => (selector === '[role=alert]' ? alerts.map(node) : top ? [top] : []),
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
  };
}

test('only a top dialog with a dismiss button and another button, and no fields, is a confirm dialog', () => {
  // vm 의 객체는 다른 realm 이라 JSON 으로 옮겨 비교한다.
  const run = (d: Parameters<typeof dom>[0]) => JSON.parse(JSON.stringify(runInNewContext(CONFIRM_DIALOG_SCRIPT, dom(d))));
  assert.deepEqual(run({ text: '승인요청하시겠습니까?', buttons: ['취소', '확인'] }), SAVE);
  assert.equal(run({ text: '협력사를 먼저 입력해 주세요.', buttons: ['확인'] }), null); // 알림 — fast-act-notice 가 닫는다
  assert.equal(run({ text: '협력사 검색', buttons: ['검색', '선택', '닫기'], fields: 1 }), null); // 조회 팝업
  assert.equal(run({ text: '설정', buttons: ['취소', '닫기'] }), null); // 거두는 버튼뿐
  assert.equal(run({ text: '표준카테고리 선택', buttons: ['펼치기', '펼치기', '선택', '닫기'] }), null); // 고르기 팝업
  assert.equal(run(null), null);
});

test('page messages carry any remaining dialog and visible alerts', () => {
  const messages = runInNewContext(PAGE_MESSAGES_SCRIPT, dom({ text: '검색키워드를 입력해 주세요.', buttons: ['확인'] }, ['필수 항목입니다']));
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), {
    dialog: { text: '검색키워드를 입력해 주세요.', buttons: ['확인'] },
    alerts: ['필수 항목입니다'],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(runInNewContext(PAGE_MESSAGES_SCRIPT, dom(null)))), {});
});

test('a press needs approval only when it can hit the confirm button', () => {
  assert.equal(confirmPress(null, { command: ['click', '@e1'], target: { name: '확인' } }), null);
  assert.equal(confirmPress(SAVE, { command: ['click', '@e1'], target: { name: '확인' } }), '확인');
  assert.equal(confirmPress(SAVE, { command: ['click', '@e2'], target: { name: '취소' } }), null);
  assert.equal(confirmPress(SAVE, { command: ['click', '@e9'] }), '이름 모를 요소');
  assert.equal(confirmPress(SAVE, { command: ['click', '@e7'], target: { role: 'treeitem', name: '여성의류' } }), null);
  assert.equal(confirmPress(SAVE, { command: ['press', 'Enter'] }), 'Enter 키');
  assert.equal(confirmPress(SAVE, { command: ['press', 'Escape'] }), null);
  assert.equal(confirmPress(SAVE, { command: ['mouse', 'move', '1', '2'] }), null);
  assert.equal(confirmPress(SAVE, { command: ['mouse', 'down'] }), '마우스 누르기');
  assert.equal(confirmPress(SAVE, { command: ['fill', '@e3', 'x'] }), null);
});

function request(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return { workflowId: 'wf', interactionId: 'chat-1', tool: BROWSER_INTERACT_TOOL, dialog: SAVE, press: '확인', pageUrl: 'https://bo.example.com/goods/reg?token=secret', ...overrides };
}

test('the center shows a card per request, answers by id and drops it on abort', async () => {
  const pushed: BrowserConfirmRequest[][] = [];
  const center = new BrowserConfirmCenter({ push: (list) => pushed.push(list), waitMs: 90_000 });
  const answer = center.ask(request());
  const [card] = center.list();
  assert.equal(card.dialogText, '승인요청하시겠습니까?');
  assert.equal(card.pageOrigin, 'https://bo.example.com'); // 경로·쿼리는 넘기지 않는다
  assert.equal(JSON.stringify(card).includes('secret'), false);
  assert.equal(center.resolve({ requestId: 'nope', choice: 'once' }), false);
  assert.equal(center.resolve({ requestId: card.requestId, choice: 'deny', message: '  임시저장까지만 하고 멈춰  ' }), true);
  assert.deepEqual(await answer, { choice: 'deny', message: '임시저장까지만 하고 멈춰' });
  assert.deepEqual(center.list(), []);
  assert.deepEqual(pushed.at(-1), []);

  const controller = new AbortController();
  const aborted = center.ask(request(), controller.signal);
  controller.abort();
  assert.deepEqual(await aborted, { choice: 'deny' });
  assert.deepEqual(center.list(), []);
});

/** 확인창이 떠 있는 탭 — 클릭한 명령과 카드 요청을 남긴다. */
function confirmPage(dialog: PageDialog | null, answers: ConfirmAnswer[]) {
  const info = { pageId: 'p1', workflowId: 'wf', url: 'https://bo.example.com/', title: 'BO', generation: 1 } as BrowserPageInfo;
  const commands: string[][] = [];
  const asked: ConfirmRequest[] = [];
  const runtime = {
    get: () => ({ ...info }),
    settle: async () => {},
    requestMark: () => 0,
    resolvePage: async () => ({ info: { ...info } }),
    refTarget: (_id: string, ref: string) => ({ '@e1': { role: 'button', name: '확인' }, '@e2': { role: 'button', name: '취소' } })[ref],
    pageScript: async (_wid: string, _id: string, code: string) =>
      code === CONFIRM_DIALOG_SCRIPT ? dialog : code === PAGE_MESSAGES_SCRIPT ? { dialog: { text: '승인요청되었습니다.', buttons: ['확인'] } } : null,
    runAgentCommand: async (_wid: string, _id: string | undefined, command: string[]) => {
      commands.push(command);
      return { page: { ...info }, result: { success: true } };
    },
  } as unknown as BrowserRuntime;
  const provider = new BrowserToolProvider(runtime);
  provider.configure(true, undefined, undefined, undefined, async (req) => {
    asked.push(req);
    return answers.shift() ?? { choice: 'deny' };
  });
  return { provider, commands, asked };
}

const click = (ref: string) => ({ action: 'click', ref });
const context = { workflowId: 'wf', interactionId: 'chat-1' };

test('the confirm button is pressed only after the user allows it, and the result carries the next dialog', async () => {
  const { provider, commands, asked } = confirmPage(SAVE, [{ choice: 'once' }]);
  const out = JSON.parse((await provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context)).content[0].text!);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].press, '확인');
  assert.deepEqual(commands, [['click', '@e1']]);
  assert.deepEqual(out.result.dialog, { text: '승인요청되었습니다.', buttons: ['확인'] });
});

test('a refusal without words is reported as the user denial and nothing is pressed', async () => {
  const { provider, commands } = confirmPage(SAVE, [{ choice: 'deny' }]);
  // 커넥터는 오류의 message 를 보낸다 — 런타임은 user_denied: 머리말을 사람의 거부로 본다.
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context), (error: Error) => /^user_denied: 사용자가 확인창/.test(error.message));
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, { action: 'keypress', key: 'Enter' }, context), /user_denied/);
  assert.deepEqual(commands, []);
});

test('a refusal with words hands them to the agent', async () => {
  const { provider, commands } = confirmPage(SAVE, [{ choice: 'deny', message: '검색키워드 먼저 채워' }]);
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context), /browser_denied: .*사용자의 말: "검색키워드 먼저 채워"\./);
  assert.deepEqual(commands, []);
});

test('"don\'t ask again" covers the same dialog in the same conversation only', async () => {
  const { provider, commands, asked } = confirmPage(SAVE, [{ choice: 'conversation' }, { choice: 'deny' }]);
  await provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context);
  await provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context);
  assert.equal(asked.length, 1);
  await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), { ...context, interactionId: 'chat-2' }), /user_denied/);
  assert.equal(asked.length, 2);
  assert.equal(commands.length, 2);
});

test('dismissing, pressing with no confirm dialog, and remote turns', async () => {
  const dismiss = confirmPage(SAVE, []);
  await dismiss.provider.callTool(BROWSER_INTERACT_TOOL, click('@e2'), context);
  assert.deepEqual([dismiss.asked.length, dismiss.commands.length], [0, 1]);

  const none = confirmPage(null, []);
  await none.provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), context);
  assert.deepEqual([none.asked.length, none.commands.length], [0, 1]);

  const remote = confirmPage(SAVE, [{ choice: 'once' }]);
  await assert.rejects(remote.provider.callTool(BROWSER_INTERACT_TOOL, click('@e1'), { ...context, remote: true }), /browser_denied: 다른 화면에서 보낸 요청/);
  assert.deepEqual([remote.asked.length, remote.commands.length], [0, 0]);
});

test('the chat shows its own cards with the three choices', () => {
  const card = (requestId: string, interactionId: string | undefined, createdAt: number): BrowserConfirmRequest => ({
    requestId, workflowId: 'wf', interactionId, tool: BROWSER_INTERACT_TOOL, dialogText: '승인요청하시겠습니까?', buttons: ['취소', '확인'], press: '확인', createdAt, expiresAt: createdAt + 90_000,
  });
  const all = [card('b', 'chat-1', 2), card('a', 'chat-1', 1), card('c', 'chat-2', 0), card('d', undefined, 3)];
  assert.deepEqual(confirmsFor(all, 'chat-1', 'wf').map((r) => r.requestId), ['a', 'b', 'd']);
  assert.deepEqual(confirmsFor(all, 'chat-2').map((r) => r.requestId), ['c']);
  const html = renderToStaticMarkup(React.createElement(ConfirmCard, { request: all[1] }));
  assert.match(html, /\[확인\] 을\(를\) 누르려고/);
  assert.match(html, /승인요청하시겠습니까\?/);
  assert.match(html, /누르기 \(이번만\)/);
  assert.match(html, /이 대화에서 같은 창은 다시 묻지 않기/);
  assert.match(html, /누르지 않고 다르게 하라고 말하기/);
  assert.match(html, /Esc · 누르지 않기/);
  assert.match(html, /tabindex="-1"/);
  assert.equal((html.match(/<button /g) ?? []).length, 3);
});
