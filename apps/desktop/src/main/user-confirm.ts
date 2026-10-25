/**
 * 에이전트가 일을 이어 가기 전에 사용자에게 묻는 기기 도구(`UserConfirm`) — 답은 같은 턴의 도구 결과로 돌아간다.
 *
 * 10/25 실측("내 확인을 받아 등록해 줘" 같은 요청)에서 에이전트는 초안을 답변으로 쓰고 "진행이라고 답해 달라" 며
 * 턴을 끝냈다. 사용자가 "진행해줘" 를 보내면 새 턴이 처음부터 다시 시작했다 — 대화 기록을 다시 읽고, 브라우저 안내를 다시
 * 부르고, 무엇을 하던 중이었는지 다시 정했다. 이 도구는 그 왕복을 한 턴 안의 카드 하나로 바꾼다.
 *
 * 카드는 사이트 확인창 카드(browser-confirm)와 같은 자리(채팅 입력창 위)에 뜬다. 고르기는 둘 — 1 진행, 2 고칠 점 말하기.
 * 다른 화면(웹·휴대폰)에서 보낸 턴은 이 PC 앞에 사람이 없을 수 있어 카드를 띄우지 않고, 답변으로 물으라고 돌려준다.
 */

import { randomUUID } from 'node:crypto';
import type { UserConfirmChoice, UserConfirmRequest, UserConfirmResolveRequest } from '@dex/protocol/user-confirm';
import type { LocalToolCallContext, LocalToolDelegate, LocalToolResult, LocalToolSchema } from '@dex/engine/local-tools';
import { ConfirmDeclined } from './browser-confirm';
import { diag } from './diag-log';

export const USER_CONFIRM_TOOL = 'UserConfirm';
/** 답을 기다리는 시간 — 초안을 읽고 고칠 점을 적을 만큼. 서버가 기기 호출을 기다리는 600초보다 짧아야 한다. */
export const USER_CONFIRM_WAIT_MS = 8 * 60_000;
/** 호출 시한(deadlineAt)보다 이만큼 먼저 끝낸다 — 시한에 걸려 끊기기 전에 "답 없음" 을 돌려주도록. */
const DEADLINE_MARGIN_MS = 5_000;
const MIN_WAIT_MS = 10_000;
const QUESTION_MAX = 300;
const DETAILS_MAX = 6_000;
const MESSAGE_MAX = 2_000;
const ASK_IN_REPLY = '진행하지 말고, 확인할 내용을 답변에 써서 턴을 끝내세요 — 사용자가 다음 메시지로 답합니다.';

export function userConfirmToolSchema(): LocalToolSchema {
  return {
    name: USER_CONFIRM_TOOL,
    title: '사용자 확인',
    annotations: { readOnlyHint: true, openWorldHint: false },
    // 첫 줄은 숨김 목록(ToolSearch 카탈로그)에 그대로 실린다 — 72자 안에서 무엇을 하는지 말한다.
    description:
      "Ask the user to confirm before going on; the answer returns this turn.\n" +
      'Shows a card above the chat input with your question and details; the user picks [진행] (proceed) or writes what to change. ' +
      'Use it when the user asked you to check with them first, or before an action that is hard to undo (saving, submitting, sending). ' +
      'Put everything they need to judge in details (draft text, values you will enter), since they decide from the card alone. ' +
      'Prefer this over ending your turn with a question: the work continues in this turn after the answer. ' +
      'Result answer: proceed = continue as asked; revise = apply the user message, then ask again if the change needs their check; ' +
      'none/unavailable = do not proceed, ask in your reply instead.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: QUESTION_MAX, description: 'One line, e.g. "이 내용으로 입력하고 저장할까요?"' },
        details: { type: 'string', maxLength: DETAILS_MAX, description: 'What the user reviews: the draft, the values to enter, what will happen.' },
      },
      required: ['question'],
    },
  };
}

/** 카드에 띄울 내용과 어느 대화인지. */
export type UserConfirmAsk = {
  workflowId: string;
  workflowName?: string;
  interactionId?: string;
  question: string;
  details?: string;
};

/** none — 답이 없었다(시한·호출 중단). */
export type UserConfirmAnswer = { choice: UserConfirmChoice | 'none'; message?: string; timedOut?: boolean };

/**
 * 답을 기다리는 카드 목록 — main 이 들고 renderer 에 통째로 보낸다(push). 답은 requestId 로 받는다(resolve).
 * 사이트 확인창 카드(BrowserConfirmCenter)와 같은 모양이다.
 */
export class UserConfirmCenter {
  private pending = new Map<string, { request: UserConfirmRequest; finish: (answer: UserConfirmAnswer) => void }>();

  constructor(
    private readonly hooks: {
      push: (requests: UserConfirmRequest[]) => void;
      notify?: (request: UserConfirmRequest, workflowName?: string) => void;
    },
  ) {}

  list(): UserConfirmRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.request }));
  }

  /** 카드를 띄우고 답을 기다린다 — waitMs 가 지나거나 signal 이 끊기면(서버가 호출을 그만둠·[정지]) 카드를 거두고 none 으로 끝낸다. */
  ask(request: UserConfirmAsk, waitMs: number, signal?: AbortSignal): Promise<UserConfirmAnswer> {
    return new Promise<UserConfirmAnswer>((resolve) => {
      if (signal?.aborted) return resolve({ choice: 'none' });
      const requestId = randomUUID();
      const createdAt = Date.now();
      const card: UserConfirmRequest = {
        requestId,
        workflowId: request.workflowId,
        ...(request.interactionId ? { interactionId: request.interactionId } : {}),
        question: request.question,
        ...(request.details ? { details: request.details } : {}),
        createdAt,
        expiresAt: createdAt + waitMs,
      };
      const finish = (answer: UserConfirmAnswer) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.hooks.push(this.list());
        resolve(answer);
      };
      const cancel = () => finish({ choice: 'none' });
      const timer = setTimeout(() => finish({ choice: 'none', timedOut: true }), waitMs);
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, { request: card, finish });
      this.hooks.push(this.list());
      this.hooks.notify?.(card, request.workflowName);
    });
  }

  /** renderer 의 답. 이미 끝난 카드면 false. */
  resolve(answer: UserConfirmResolveRequest): boolean {
    const entry = this.pending.get(String(answer?.requestId ?? ''));
    if (!entry || (answer.choice !== 'proceed' && answer.choice !== 'revise')) return false;
    const message = answer.choice === 'revise' && typeof answer.message === 'string' ? answer.message.trim().slice(0, MESSAGE_MAX) : '';
    entry.finish({ choice: answer.choice, ...(message ? { message } : {}) });
    return true;
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function reply(payload: Record<string, unknown>): LocalToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** 기기 도구 `UserConfirm` — 브라우저 도구와 함께 로컬 도구 제공자에 붙는다(joinDelegates). */
export class UserConfirmTools implements LocalToolDelegate {
  constructor(private readonly center: Pick<UserConfirmCenter, 'ask'>) {}

  advertise(): LocalToolSchema[] {
    return [userConfirmToolSchema()];
  }

  owns(tool: string): boolean {
    return tool === USER_CONFIRM_TOOL;
  }

  async callTool(tool: string, raw: unknown, context?: LocalToolCallContext): Promise<LocalToolResult> {
    if (tool !== USER_CONFIRM_TOOL) throw new Error(`unknown local tool: ${tool}`);
    const args = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const question = text(args.question, QUESTION_MAX);
    if (!question) throw new Error('question 이 비어 있습니다 — 사용자에게 물을 한 줄을 주세요.');
    const details = text(args.details, DETAILS_MAX);
    if (context?.remote)
      return reply({ answer: 'unavailable', note: `이 요청은 ${context.originName || '다른 기기'}에서 와서 이 PC 의 카드로 물을 수 없습니다. ${ASK_IN_REPLY}` });
    const workflowId = context?.workflowId ?? '';
    const waitMs = Math.min(USER_CONFIRM_WAIT_MS, (context?.deadlineAt ?? Infinity) - Date.now() - DEADLINE_MARGIN_MS);
    if (!workflowId || waitMs < MIN_WAIT_MS) return reply({ answer: 'unavailable', note: `카드를 띄울 수 없습니다. ${ASK_IN_REPLY}` });
    diag('user-confirm', 'ask', { question: question.length, details: details.length, waitMs });
    const answer = await this.center.ask(
      { workflowId, workflowName: context?.workflowName, interactionId: context?.interactionId, question, ...(details ? { details } : {}) },
      waitMs,
      context?.signal,
    );
    diag('user-confirm', 'answer', { choice: answer.choice, timedOut: !!answer.timedOut, said: !!answer.message });
    if (answer.choice === 'proceed') return reply({ answer: 'proceed', note: '사용자가 [진행]을 골랐습니다. 물어본 대로 이어서 하세요.' });
    if (answer.choice === 'revise' && answer.message)
      return reply({
        answer: 'revise',
        message: answer.message,
        note: '사용자가 아직 진행을 허락하지 않았습니다. 이 말을 반영하고, 반영한 결과를 다시 확인받아야 하면 UserConfirm 을 다시 부르세요.',
      });
    // 말 없이 거절했다 — 사람의 거부로 알려(user_denied) 같은 턴에 같은 질문을 다시 띄우지 않게 한다.
    if (answer.choice === 'revise') throw new ConfirmDeclined('사용자가 진행하지 않기로 했습니다. 물어본 일을 하지 말고, 어떻게 할지 답변으로 물어보세요.');
    return reply({
      answer: 'none',
      note: answer.timedOut ? `사용자가 ${Math.round(waitMs / 1000)}초 안에 답하지 않았습니다. ${ASK_IN_REPLY}` : `답을 받지 못했습니다. ${ASK_IN_REPLY}`,
    });
  }
}
