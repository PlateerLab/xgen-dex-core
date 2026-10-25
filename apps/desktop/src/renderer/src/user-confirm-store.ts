/**
 * 에이전트가 일을 이어 가기 전에 묻는 카드 — main 이 보낸, 답을 기다리는 카드 목록(main user-confirm).
 *
 * 사이트 확인창 카드(browser-confirm-store)와 같은 방식이다: main 이 목록을 통째로 보내고(onUserConfirm), 처음 구독할 때 한 번
 * 읽는다(userConfirmList). 대화는 interactionId 로 가린다 — 없으면 workflowId.
 */
import { useMemo, useSyncExternalStore } from 'react';
import type { UserConfirmChoice, UserConfirmRequest } from '@dex/protocol/user-confirm';
import { xgen } from './bridge';
import { confirmsFor } from './browser-confirm-store';

const EMPTY: UserConfirmRequest[] = [];

class UserConfirmStore {
  private requests: UserConfirmRequest[] = EMPTY;
  private listeners = new Set<() => void>();
  private wired = false;

  subscribe = (listener: () => void): (() => void) => {
    this.wire();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get = (): UserConfirmRequest[] => this.requests;

  set(requests: UserConfirmRequest[]): void {
    this.requests = requests.length ? requests : EMPTY;
    for (const listener of this.listeners) listener();
  }

  private wire(): void {
    if (this.wired || !xgen?.chat?.onUserConfirm) return;
    this.wired = true;
    xgen.chat.onUserConfirm((requests) => this.set(requests));
    void xgen.chat.userConfirmList().then((requests) => this.set(requests)).catch(() => {});
  }
}

export const userConfirmStore = new UserConfirmStore();

export function useUserConfirms(interactionId: string, workflowId?: string): UserConfirmRequest[] {
  const all = useSyncExternalStore(userConfirmStore.subscribe, userConfirmStore.get, () => EMPTY);
  return useMemo(() => confirmsFor(all, interactionId, workflowId), [all, interactionId, workflowId]);
}

/** 카드의 고르기 — 2 는 고칠 점을 받는다. */
export const USER_CONFIRM_OPTIONS: { key: '1' | '2'; choice: UserConfirmChoice; label: string }[] = [
  { key: '1', choice: 'proceed', label: '진행' },
  { key: '2', choice: 'revise', label: '고칠 점 말하기' },
];

/** 남은 시간 — 1분 넘으면 분·초로. */
export function leftText(seconds: number): string {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}
