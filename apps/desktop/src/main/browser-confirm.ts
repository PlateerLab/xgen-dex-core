/**
 * 사이트 확인창의 확정 버튼은 사용자가 허락해야 누른다 — 서버 에이전트의 브라우저 도구(browser-tools)용.
 *
 * 10/22 박소민 시연(trace 54448)에서 에이전트가 승인요청을 눌렀고, 사이트가 띄운 "승인요청하시겠습니까?" 창의 확인까지 눌러
 * 시연 상품이 실제로 승인요청됐다. 그날 오전에 버튼 이름(저장·등록·승인요청)과 사용자 메시지를 해석하던 저장 가드를
 * 걷어낸 뒤였다 — 직접 "임시저장해줘" 라고 해도 해석이 빗나가 매번 되물었다(db036ea2).
 *
 * 여기서는 이름이 아니라 화면 구조로 본다. 사이트가 "정말 할까요?" 를 묻는 창 — 입력칸이 없고, 취소·닫기류 버튼과 그 밖의
 * 버튼이 함께 있는 맨 위 대화상자 — 이 떠 있을 때, 취소·닫기류가 아닌 쪽을 누르거나 키·마우스로 누를 수 있는 조작만 묻는다.
 * 저장 버튼 자체는 그 창을 띄울 뿐이라 묻지 않는다. 확인 버튼 하나뿐인 알림(fast-act-notice)과 입력칸이 있는 조회 팝업은
 * 확인창이 아니다. 확인창 없이 바로 저장하는 사이트는 이 방법으로 막지 못한다.
 *
 * 허락은 채팅 카드로 받는다(이번만 / 이 대화에서 같은 창은 다시 묻지 않기 / 누르지 않고 다르게 하라고 말하기).
 * 다른 화면(웹·휴대폰)에서 보낸 턴은 이 PC 앞에 사람이 없을 수 있어 묻지 않고 누르지 않는다.
 */

import { randomUUID } from 'node:crypto';
import type { BrowserConfirmChoice, BrowserConfirmRequest, BrowserConfirmResolveRequest } from '@dex/protocol/browser';

/** 떠 있는 대화상자 — 문구와 버튼 이름. */
export type PageDialog = { text: string; buttons: string[] };

/** 페이지 스크립트가 돌려준 값이 확인창 모양인가. */
export function isPageDialog(value: unknown): value is PageDialog {
  const dialog = value as PageDialog | null;
  return !!dialog && typeof dialog.text === 'string' && Array.isArray(dialog.buttons) && dialog.buttons.every((b) => typeof b === 'string');
}

/** 클릭 결과에 싣는 화면 문구 — 맨 위 대화상자와 보이는 경고(role=alert). */
export type PageMessages = { dialog?: PageDialog; alerts?: string[] };

const DISMISS = String.raw`^(취소|닫기|아니오|아니요|cancel|close|no|[x×✕✖])$`;

/** 취소·닫기류 버튼 이름인가 — 누르면 확인창을 거두는 쪽. */
export function dismisses(name: string | undefined): boolean {
  return new RegExp(DISMISS, 'i').test((name ?? '').replace(/\s+/g, ' ').trim());
}

const DIALOG_DOM = String.raw`
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const topDialog = () => {
    const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(visible);
    const top = dialogs[dialogs.length - 1];
    if (!top) return null;
    const fields = [...top.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox],[role=listbox]')].filter(visible);
    const buttons = [...top.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(visible)
      .map((el) => squash(el.innerText || el.value || el.getAttribute('aria-label') || el.title)).filter(Boolean);
    const all = squash(top.innerText);
    // 버튼 글은 문구 뒤에 순서대로 붙는다("…하시겠습니까? 취소 확인") — 뒤에서부터 뗀다.
    const text = squash(buttons.reduceRight((s, b) => { s = s.trimEnd(); return s.endsWith(b) ? s.slice(0, -b.length) : s; }, all)).slice(0, 300);
    return { text, buttons, fields: fields.length };
  };
`;

/** 페이지에서 실행한다 — 맨 위 대화상자가 확인창이면 { text, buttons }, 아니면 null. */
export const CONFIRM_DIALOG_SCRIPT = `(() => {
  ${DIALOG_DOM}
  const dismiss = new RegExp(${JSON.stringify(DISMISS)}, 'i');
  const top = topDialog();
  // 확인창은 버튼 2~3개다(취소·확인, 닫기 아이콘). 버튼이 더 많은 창은 고르기 팝업(트리 펼치기·페이지 넘기기)이다.
  if (!top || top.fields || top.buttons.length < 2 || top.buttons.length > 3) return null;
  if (!top.buttons.some((b) => dismiss.test(b)) || top.buttons.every((b) => dismiss.test(b))) return null;
  return { text: top.text, buttons: top.buttons };
})()`;

/** 페이지에서 실행한다 — 조작 뒤 화면에 남은 대화상자(종류 무관)와 보이는 경고 문구. */
export const PAGE_MESSAGES_SCRIPT = `(() => {
  ${DIALOG_DOM}
  const top = topDialog();
  const alerts = [...document.querySelectorAll('[role=alert]')].filter(visible)
    .map((el) => squash(el.innerText).slice(0, 200)).filter(Boolean).slice(0, 5);
  return {
    ...(top && (top.text || top.buttons.length) ? { dialog: { text: top.text, buttons: top.buttons } } : {}),
    ...(alerts.length ? { alerts } : {}),
  };
})()`;

/** BrowserInteract 조작 하나 — agent-browser 명령과, 클릭이면 고른 요소의 역할·이름. */
export type GuardedCommand = { command: string[]; target?: { role?: string; name?: string } };

/**
 * 확인창이 떠 있을 때 이 명령이 확정 버튼을 누를 수 있나 — 누를 수 있으면 누를 버튼(또는 키) 이름, 아니면 null.
 * 클릭은 고른 요소가 취소·닫기류가 아닌 버튼이면 묻는다(역할·이름을 모르면 묻는다). Enter·Space 와 마우스 누르기는 창의 기본 버튼을
 * 누를 수 있어 묻는다. Escape·이동·읽기는 묻지 않는다.
 */
export function confirmPress(dialog: PageDialog | null, { command, target }: GuardedCommand): string | null {
  if (!dialog) return null;
  const [verb, arg] = command;
  if (verb === 'click' || verb === 'dblclick') {
    // 버튼이 아닌 것(트리·목록 항목)을 누르는 것은 고르기다. 역할을 모르면 묻는다.
    if (dismisses(target?.name) || (target?.role && target.role !== 'button')) return null;
    return target?.name?.trim() || '이름 모를 요소';
  }
  if (verb === 'press') return /^(enter|return|space|spacebar| )$/i.test(String(arg ?? '').split('+').pop() ?? '') ? `${arg} 키` : null;
  if (verb === 'mouse') return arg === 'move' ? null : '마우스 누르기';
  return null;
}

/** 카드에 띄울 내용 — 확인창과 누를 버튼, 어느 대화·탭인지. */
export type ConfirmRequest = {
  workflowId: string;
  workflowName?: string;
  interactionId?: string;
  tool: string;
  dialog: PageDialog;
  /** 누르려는 버튼(또는 키) 이름. */
  press: string;
  pageTitle?: string;
  pageUrl?: string;
};

export type ConfirmAnswer = { choice: BrowserConfirmChoice; message?: string; timedOut?: boolean };

/** 카드를 띄우고 답을 기다린다 — signal 이 끊기면(서버가 호출을 그만둠·[정지]·시한) 카드를 거두고 deny 로 끝낸다. */
export type ConfirmAsker = (request: ConfirmRequest, signal?: AbortSignal) => Promise<ConfirmAnswer>;

/**
 * 답을 기다리는 카드 목록 — main 이 들고 renderer 에 통째로 보낸다(push). 답은 requestId 로 받는다(resolve). 팝업 허용
 * 요청(browser-runtime queueBlockedPopup)과 같은 모양이다. 페이지 주소는 origin 만 넘긴다.
 */
export class BrowserConfirmCenter {
  private pending = new Map<string, { request: BrowserConfirmRequest; finish: (answer: ConfirmAnswer) => void }>();

  constructor(
    private readonly hooks: {
      push: (requests: BrowserConfirmRequest[]) => void;
      notify?: (request: BrowserConfirmRequest, workflowName?: string) => void;
      waitMs: number;
    },
  ) {}

  list(): BrowserConfirmRequest[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.request, buttons: [...entry.request.buttons] }));
  }

  ask: ConfirmAsker = (request, signal) =>
    new Promise<ConfirmAnswer>((resolve) => {
      if (signal?.aborted) return resolve({ choice: 'deny' });
      const requestId = randomUUID();
      const createdAt = Date.now();
      const card: BrowserConfirmRequest = {
        requestId,
        workflowId: request.workflowId,
        ...(request.interactionId ? { interactionId: request.interactionId } : {}),
        tool: request.tool,
        dialogText: request.dialog.text,
        buttons: request.dialog.buttons.slice(0, 6),
        press: request.press,
        ...(request.pageTitle ? { pageTitle: request.pageTitle } : {}),
        ...(origin(request.pageUrl) ? { pageOrigin: origin(request.pageUrl) } : {}),
        createdAt,
        expiresAt: createdAt + this.hooks.waitMs,
      };
      const finish = (answer: ConfirmAnswer) => {
        if (!this.pending.delete(requestId)) return;
        signal?.removeEventListener('abort', cancel);
        this.hooks.push(this.list());
        resolve(answer);
      };
      const cancel = () => finish({ choice: 'deny' });
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, { request: card, finish });
      this.hooks.push(this.list());
      this.hooks.notify?.(card, request.workflowName);
    });

  /** renderer 의 답. 이미 끝난 카드면 false. */
  resolve(answer: BrowserConfirmResolveRequest): boolean {
    const entry = this.pending.get(String(answer?.requestId ?? ''));
    if (!entry || !['once', 'conversation', 'deny'].includes(answer.choice)) return false;
    const message = answer.choice === 'deny' && typeof answer.message === 'string' ? answer.message.trim().slice(0, 1_000) : '';
    entry.finish({ choice: answer.choice, ...(message ? { message } : {}) });
    return true;
  }
}

function origin(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 사용자가 거절했다 — 런타임은 `user_denied:` 머리말을 사람의 거부로 알아보고 같은 턴에 같은 호출을 다시 하지 않는다
 * (xgen-agent-runtime host/tools.py `_DENIAL_CODES`, stages/s10_tool/denial_guard.py).
 */
export class ConfirmDeclined extends Error {
  readonly code = 'user_denied';

  constructor(message: string) {
    super(`user_denied: ${message}`);
    this.name = 'ConfirmDeclined';
  }
}

/** "이 대화에서 같은 창은 다시 묻지 않기" — 대화(workflowId·interactionId)와 창 문구별로 기억한다. */
export class ConfirmGrants {
  private grants = new Set<string>();

  private key(workflowId: string, interactionId: string | undefined, dialog: PageDialog): string {
    return JSON.stringify([workflowId, interactionId ?? '', dialog.text.replace(/\s+/g, '')]);
  }

  has(workflowId: string, interactionId: string | undefined, dialog: PageDialog): boolean {
    return this.grants.has(this.key(workflowId, interactionId, dialog));
  }

  add(workflowId: string, interactionId: string | undefined, dialog: PageDialog): void {
    this.grants.add(this.key(workflowId, interactionId, dialog));
  }

  clear(interactionId?: string): void {
    if (interactionId === undefined) this.grants.clear();
    else for (const key of this.grants) if ((JSON.parse(key) as string[])[1] === interactionId) this.grants.delete(key);
  }
}

/** 누르지 않았을 때 모델에 돌려줄 글 — why 가 없으면 사용자가 거절한 것이다. */
export function declinedMessage(press: string, dialog: PageDialog, message?: string, why?: string): string {
  const said = message?.trim();
  const where = `확인창("${dialog.text.slice(0, 80)}")의 [${press}]`;
  return (
    (why ? `${why} ${where} 을(를) 누르지 않았습니다.` : `사용자가 ${where} 을(를) 누르지 않았습니다.`) +
    (said ? ` 사용자의 말: "${said}".` : '') +
    ' 같은 버튼을 다른 방법(키·마우스·eval)으로 누르지 말고, 사용자의 말을 따르거나 어떻게 할지 물어보세요.'
  );
}
