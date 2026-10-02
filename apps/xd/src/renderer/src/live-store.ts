/**
 * 도는 턴 — 대화별로 지금 흐르는 답. 턴 사건을 **앱에 한 번만** 구독하므로, 다른 화면으로 옮겼다 와도 스트림이
 * 끊기지 않는다. 턴이 끝나면(finished) 그 대화의 판(version)을 올려 화면이 저장된 턴을 다시 읽게 한다.
 */
import { useSyncExternalStore } from 'react';
import type { XdTurnEvent } from '../../main/turn-runner';
import { applyChatEvent, startLive, type ChatMsg } from './chat-model';

export interface LiveTurn {
  turnId: string;
  conversationId: string;
  question: string;
  answer: ChatMsg;
  /** 위험 명령 확인을 기다리는 중이면 그 명령(여럿이면 마지막). */
  approval: string | null;
  /** 대답을 기다리는 확인 — 요청 id 별로. 하나에 대답해도 다른 확인 창은 열려 있을 수 있다. */
  approvals: Array<{ request: string; command: string }>;
}

type Listener = () => void;

export class LiveStore {
  private turns = new Map<string, LiveTurn>(); // conversationId →
  private versions = new Map<string, number>(); // conversationId → 저장된 턴이 바뀐 횟수
  /**
   * 이미 끝난 턴 — 보내기 대답보다 끝이 먼저 올 수 있다(엔진에 가기 전 실패는 main 이 그 자리에서 끝낸다). 그 턴을
   * 나중에 begin 하면 영원히 "도는 중" 으로 남는다.
   */
  private finished = new Set<string>();
  private listeners = new Set<Listener>();
  private snapshot = 0;

  constructor(private readonly now: () => number = Date.now) {}

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private bump(): void {
    this.snapshot += 1;
    for (const fn of this.listeners) fn();
  }

  version = (): number => this.snapshot;

  get(conversationId: string): LiveTurn | null {
    return this.turns.get(conversationId) ?? null;
  }

  conversationVersion(conversationId: string): number {
    return this.versions.get(conversationId) ?? 0;
  }

  running(): string[] {
    return [...this.turns.keys()];
  }

  /** 보냈다 — 첫 사건 전에도 질문과 빈 답이 보이게. */
  begin(turnId: string, conversationId: string, question: string): void {
    if (this.finished.has(turnId)) return;
    this.turns.set(conversationId, { turnId, conversationId, question, answer: startLive(this.now()), approval: null, approvals: [] });
    this.bump();
  }

  apply(event: XdTurnEvent): void {
    const live = this.turns.get(event.conversationId);
    if (event.type === 'finished') {
      this.finished.add(event.turnId);
      if (this.finished.size > 500) this.finished.delete(this.finished.values().next().value as string);
      if (live?.turnId === event.turnId) this.turns.delete(event.conversationId);
      this.versions.set(event.conversationId, this.conversationVersion(event.conversationId) + 1);
      this.bump();
      return;
    }
    if (!live || live.turnId !== event.turnId) return;
    if (event.type === 'chat') {
      this.turns.set(event.conversationId, { ...live, answer: applyChatEvent(live.answer, event.event, this.now()) });
    } else if (event.type === 'approval' || event.type === 'approval_done') {
      const approvals =
        event.type === 'approval'
          ? [...live.approvals, { request: event.request, command: event.command }]
          : live.approvals.filter((a) => a.request !== event.request);
      this.turns.set(event.conversationId, { ...live, approvals, approval: approvals.at(-1)?.command ?? null });
    } else {
      return;
    }
    this.bump();
  }
}

export const liveStore = new LiveStore();

/** 화면 훅 — 이 대화에서 도는 턴과, 저장된 턴이 바뀐 횟수. */
export function useLive(conversationId: string | null): { live: LiveTurn | null; version: number } {
  useSyncExternalStore(liveStore.subscribe, liveStore.version);
  return {
    live: conversationId ? liveStore.get(conversationId) : null,
    version: conversationId ? liveStore.conversationVersion(conversationId) : 0,
  };
}

/** 지금 도는 대화들(사이드바의 표시). */
export function useRunning(): string[] {
  useSyncExternalStore(liveStore.subscribe, liveStore.version);
  return liveStore.running();
}
