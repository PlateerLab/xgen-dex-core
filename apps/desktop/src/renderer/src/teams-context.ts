/**
 * teams-context — [Agent] 탭이 지금 **어느 Teams 방을 보고 있었는지** 기억하고,
 * 그 방의 대화를 프롬프트 봉투로 만들어 넘기는 곳.
 *
 * 왜 자동 추적을 쓰지 않는가
 * ─────────────────────────
 * 처음에는 Slack 의 `app_context_changed` 를 본떠 **마지막으로 본 방**이 저절로
 * 따라붙게 했다. 쓰다 보니 그 편의보다 문제가 컸다:
 *   · 방을 잠깐 들여다본 것만으로 그 방이 문맥이 된다. 사용자는 고른 적이 없다.
 *   · 여러 방을 오가면 칩이 계속 바뀌어, 정작 보낼 때 어느 방이 붙어 있는지
 *     매번 확인해야 한다.
 *   · 남이 쓴 글이 나가는 기능이 **기본 켜짐**이 된다.
 *
 * 그래서 지금은 **사용자가 방을 명시적으로 고를 때만** 붙는다. 고르기 전에는
 * 칩이 없고, 아무것도 나가지 않는다. 고른 뒤에는 그 방이 그대로 유지된다 —
 * 다른 방을 봐도 바뀌지 않는다.
 *
 * 붙어 있는 동안의 규칙은 그대로다:
 *   · 칩으로 항상 보인다 — 화면 캡처 토글과 같은 원칙이다. 켜 둔 것을 잊고
 *     남의 대화를 흘려보내는 것이 이 기능의 유일한 위험이다.
 *   · 처음 보낼 때 몇 건이 나가는지 확인을 받는다. 같은 (세션·방·범위) 조합은
 *     다시 묻지 않는다 — 매 메시지마다 묻는 확인창은 아무도 읽지 않게 된다.
 *
 * 봉투를 실제로 붙이는 지점은 `session.ts` 의 전송 배선이다 (브라우저 컨텍스트와
 * 같은 자리). 여기서는 **한 번 쓰고 버리는** 봉투를 만들어 둘 뿐이다.
 */
import { useSyncExternalStore } from 'react';
import {
  buildTeamsContext,
  prependTeamsContext,
  toContextEntries,
  type ChatRequest,
  type TeamsRoom,
} from '../../core/index';
import { isPending } from './views/teams-store';
import { teamsStore } from './teams';

/** 기본으로 실어 보내는 메시지 수. 사용자가 칩에서 바꿀 수 있다. */
export const DEFAULT_CONTEXT_LIMIT = 30;

/** 고를 수 있는 범위. 서버 한 번 호출의 상한(200)을 넘지 않는다. */
export const CONTEXT_LIMIT_CHOICES = [10, 30, 50, 100, 200] as const;

/** 칩이 가리키는 방. 목록이 사라져도 칩이 남을 수 있어 이름까지 들고 있는다. */
interface ContextRoom {
  id: string;
  name: string;
  isDirect: boolean;
}

/** 한 Agent 세션의 컨텍스트 상태. */
interface SessionContext {
  room: ContextRoom | null;
  limit: number;
  /** 사용자가 껐다 — 다시 켜기 전에는 자동으로 붙지 않는다. */
  dismissed: boolean;
  /** 승인한 조합 (`roomId:limit`). 방이나 범위가 바뀌면 다시 묻는다. */
  approvedFor: string;
}

/** 화면이 그리는 칩 한 개. */
export interface ContextChip {
  roomId: string;
  roomName: string;
  isDirect: boolean;
  limit: number;
  /** 이 방에서 실제로 실을 수 있는 메시지 수 (캐시 기준, limit 이하). */
  available: number;
  /** 사용자가 이 조합을 이미 승인했는가 — false 면 보낼 때 확인창을 띄운다. */
  approved: boolean;
}

function approvalKey(roomId: string, limit: number): string {
  return `${roomId}:${limit}`;
}

class TeamsContextStore {
  private bySession = new Map<string, SessionContext>();
  /** 전송 직전에 만들어 두는 일회용 봉투. 붙이면 즉시 버린다. */
  private pending = new Map<string, string>();
  private listeners = new Set<() => void>();
  /** useSyncExternalStore 는 참조가 같으면 리렌더하지 않는다 — 버전으로 깨운다. */
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** 로그아웃 / 계정 전환 — 남의 방이 다음 계정의 프롬프트에 실리면 안 된다. */
  reset(): void {
    this.bySession.clear();
    this.pending.clear();
    this.emit();
  }

  /** 세션이 끝나면 그 세션의 상태도 정리한다. */
  forgetSession(sessionKey: string): void {
    const had = this.bySession.delete(sessionKey);
    const pending = this.pending.delete(sessionKey);
    if (had || pending) this.emit();
  }

  /**
   * 이 세션에 지금 붙어 있는 칩. **사용자가 방을 고른 적이 없으면 null** 이다.
   * 저절로 붙는 경로는 없다.
   */
  chipFor(sessionKey: string): ContextChip | null {
    const ctx = this.bySession.get(sessionKey);
    if (!ctx || ctx.dismissed) return null;
    const room = ctx.room;
    if (!room) return null;
    const limit = ctx?.limit ?? DEFAULT_CONTEXT_LIMIT;
    return {
      roomId: room.id,
      roomName: room.name,
      isDirect: room.isDirect,
      limit,
      available: Math.min(limit, this.sendableCount(room.id)),
      approved: ctx?.approvedFor === approvalKey(room.id, limit),
    };
  }

  /** 이 세션이 마지막으로 고른 방 (칩을 껐어도 기억한다 — 다시 켤 때 그 방으로). */
  lastPicked(sessionKey: string): ContextRoom | null {
    return this.bySession.get(sessionKey)?.room ?? null;
  }

  /** 지금 캐시에 있는, 봉투에 실을 수 있는 메시지 수. */
  private sendableCount(roomId: string): number {
    return this.sendable(roomId).length;
  }

  /**
   * 봉투에 실을 후보 메시지. 아직 서버가 모르는 낙관적 메시지는 제외한다 —
   * 전송이 실패하면 사라질 줄인데 모델에게는 사실처럼 보인다.
   */
  private sendable(roomId: string) {
    const room = teamsStore.getSnapshot().byRoom[roomId];
    return (room?.messages ?? []).filter((m) => !isPending(m));
  }

  private patch(sessionKey: string, change: Partial<SessionContext>): void {
    const current = this.bySession.get(sessionKey) ?? {
      room: null,
      limit: DEFAULT_CONTEXT_LIMIT,
      dismissed: false,
      approvedFor: '',
    };
    this.bySession.set(sessionKey, { ...current, ...change });
    this.emit();
  }

  /**
   * 칩 끄기 — 이 세션에서는 다시 켜기 전까지 붙지 않는다.
   * 준비해 둔 봉투도 함께 버린다. 끈 순간부터는 나갈 것이 없어야 한다.
   */
  dismiss(sessionKey: string): void {
    this.pending.delete(sessionKey);
    this.patch(sessionKey, { dismissed: true, approvedFor: '' });
  }

  /** 껐던 칩을 마지막에 고른 방으로 되살린다. 고른 적이 없으면 아무 일도 없다. */
  restore(sessionKey: string): void {
    if (!this.bySession.get(sessionKey)?.room) return;
    this.patch(sessionKey, { dismissed: false, approvedFor: '' });
  }

  /** 사용자가 방을 골랐다 — 칩이 붙는 **유일한** 경로다. */
  pickRoom(sessionKey: string, room: TeamsRoom): void {
    this.patch(sessionKey, {
      room: { id: room.id, name: room.name, isDirect: room.isDirect },
      dismissed: false,
      approvedFor: '',
    });
  }

  /** 범위 변경. 범위가 달라지면 승인도 무효다 — 30건 승인이 200건 승인은 아니다. */
  setLimit(sessionKey: string, limit: number): void {
    this.patch(sessionKey, { limit, approvedFor: '' });
  }

  /** 확인창에서 "보내기" 를 눌렀다. */
  approve(sessionKey: string): void {
    const chip = this.chipFor(sessionKey);
    if (!chip) return;
    this.patch(sessionKey, { approvedFor: approvalKey(chip.roomId, chip.limit) });
  }

  /**
   * 캐시가 부족하면 서버에서 더 받아 온다. 확인창에 보여 줄 **정확한 건수**가
   * 필요하고, 그 수는 사용자에게 고지한 수와 같아야 한다.
   */
  async ensureLoaded(sessionKey: string): Promise<number> {
    const chip = this.chipFor(sessionKey);
    if (!chip) return 0;
    await teamsStore.ensureMessages(chip.roomId, chip.limit);
    this.emit();
    return Math.min(chip.limit, this.sendableCount(chip.roomId));
  }

  /**
   * 전송 직전 — 봉투를 만들어 둔다. 반환값은 실제로 실린 건수(0 이면 안 붙는다).
   *
   * **매 턴 새로 만든다.** 붙여 두고 재사용하면 대화가 진행된 뒤에도 옛 스냅샷을
   * 계속 보내게 되어, 모델이 방금 오간 말을 못 본 채 답한다.
   */
  async prepare(sessionKey: string): Promise<number> {
    // ⚠ **먼저 버린다.** 앞선 턴이 준비만 하고 실제 전송에 이르지 못하면
    // (스토어가 조기 반환하는 경우) 봉투가 남는다. 그 뒤 사용자가 칩을 끄고
    // 다시 보내면, 껐다고 믿은 문맥이 그대로 실려 나간다 — 좁지만 진짜 유출이다.
    this.pending.delete(sessionKey);
    const chip = this.chipFor(sessionKey);
    if (!chip) return 0;
    await teamsStore.ensureMessages(chip.roomId, chip.limit);
    const all = this.sendable(chip.roomId);
    const slice = all.slice(Math.max(0, all.length - chip.limit));
    const entries = toContextEntries(slice);
    if (entries.length === 0) return 0;
    this.pending.set(
      sessionKey,
      buildTeamsContext({ id: chip.roomId, name: chip.roomName, isDirect: chip.isDirect }, entries),
    );
    return entries.length;
  }

  /**
   * 전송 배선이 부르는 지점 (`session.ts`). 준비된 봉투가 있으면 붙이고 버린다.
   * 준비되지 않았으면 요청을 그대로 통과시킨다 — 칩이 꺼져 있는 평범한 대화다.
   *
   * `interactionId` 가 곧 세션 키다 (`SessionState.key === interactionId`).
   */
  contextualize(request: ChatRequest): ChatRequest {
    const envelope = this.pending.get(request.interactionId);
    if (!envelope) return request;
    this.pending.delete(request.interactionId);
    const decorate = (text: string): string => prependTeamsContext(text, envelope);
    if (typeof request.input === 'string') return { ...request, input: decorate(request.input) };
    if (Array.isArray(request.input)) {
      // 화면 캡처가 함께 가는 턴은 input 이 블록 배열이다. 첫 텍스트 블록에만 붙인다.
      let applied = false;
      const input = request.input.map((block) => {
        if (
          !applied &&
          block &&
          typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          applied = true;
          return {
            ...(block as Record<string, unknown>),
            text: decorate(String((block as Record<string, unknown>).text)),
          };
        }
        return block;
      });
      return applied ? { ...request, input } : request;
    }
    if (
      request.input &&
      typeof request.input === 'object' &&
      typeof (request.input as Record<string, unknown>).input_str === 'string'
    ) {
      return {
        ...request,
        input: {
          ...(request.input as Record<string, unknown>),
          input_str: decorate(String((request.input as Record<string, unknown>).input_str)),
        },
      };
    }
    return request;
  }
}

export const teamsContextStore = new TeamsContextStore();

/** 이 세션의 칩을 구독한다. 칩이 없으면 null. */
export function useContextChip(sessionKey: string): ContextChip | null {
  // 방 메시지가 늘면 available 도 변해야 하므로 Teams 스토어에도 함께 구독한다.
  useSyncExternalStore(teamsStore.subscribe, teamsStore.getSnapshot, teamsStore.getSnapshot);
  useSyncExternalStore(
    teamsContextStore.subscribe,
    teamsContextStore.getVersion,
    teamsContextStore.getVersion,
  );
  return teamsContextStore.chipFor(sessionKey);
}
