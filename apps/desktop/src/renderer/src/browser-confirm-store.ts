/**
 * 에이전트가 누르려는 사이트 확인창 버튼 — main 이 보낸, 답을 기다리는 카드 목록(main browser-confirm).
 *
 * main 이 목록을 통째로 보내고(onConfirm), 처음 구독할 때 한 번 읽는다(confirmList). 대화는 interactionId 로 가린다 —
 * 없으면 workflowId.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { BrowserConfirmChoice, BrowserConfirmRequest } from '@dex/protocol/browser';
import { xgen } from './bridge';

const EMPTY: BrowserConfirmRequest[] = [];

class BrowserConfirmStore {
  private requests: BrowserConfirmRequest[] = EMPTY;
  private listeners = new Set<() => void>();
  private wired = false;

  subscribe = (listener: () => void): (() => void) => {
    this.wire();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): BrowserConfirmRequest[] => this.requests;

  set(requests: BrowserConfirmRequest[]): void {
    this.requests = requests.length ? requests : EMPTY;
    for (const listener of this.listeners) listener();
  }

  private wire(): void {
    if (this.wired || !xgen?.browser?.onConfirm) return;
    this.wired = true;
    xgen.browser.onConfirm((requests) => this.set(requests));
    void xgen.browser.confirmList().then((requests) => this.set(requests)).catch(() => {});
  }
}

export const browserConfirmStore = new BrowserConfirmStore();

/** 그 대화의 카드 — 오래된 것부터. */
export function confirmsFor(
  requests: BrowserConfirmRequest[],
  interactionId: string,
  workflowId?: string,
): BrowserConfirmRequest[] {
  return requests
    .filter((request) => (request.interactionId ? request.interactionId === interactionId : !!workflowId && request.workflowId === workflowId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function useBrowserConfirms(interactionId: string, workflowId?: string): BrowserConfirmRequest[] {
  const all = useSyncExternalStore(browserConfirmStore.subscribe, browserConfirmStore.get, () => EMPTY);
  return useMemo(() => confirmsFor(all, interactionId, workflowId), [all, interactionId, workflowId]);
}

/** 카드의 고르기 — Claude Code 의 확인과 같은 세 가지. 3 은 할 말을 받는다. */
export const CONFIRM_OPTIONS: { key: '1' | '2' | '3'; choice: BrowserConfirmChoice; label: string }[] = [
  { key: '1', choice: 'once', label: '누르기 (이번만)' },
  { key: '2', choice: 'conversation', label: '누르기, 이 대화에서 같은 창은 다시 묻지 않기' },
  { key: '3', choice: 'deny', label: '누르지 않고 다르게 하라고 말하기' },
];
