/**
 * 계속 듣기를 맡은 화면 — 켜 둔 듣기가 새 채팅으로 이어진다(10/28).
 *
 * 예전에는 대화 화면마다 켜짐을 따로 들고 있어서, 말로 새 채팅을 열면(fast-act-dex "새 에이전트 만들어 줘") 시작 화면에서는
 * 듣지 않았고 그 뒤 열린 새 대화도 꺼진 채로 섰다 — 발표자가 다음 말을 하려면 마이크를 다시 눌러야 했다.
 *
 * 그래서 켜짐은 하나(on)이고, 듣는 화면도 하나(owner)다:
 *   · 마이크를 누른 화면이 맡는다. 다른 화면이 맡고 있었으면 끄지 않고 넘겨받는다.
 *   · 켜진 채 시작 화면이 열리면 시작 화면이 넘겨받고, 시작 화면이 대화를 열면 그 대화에 넘긴다.
 *   · 맡은 화면이 잠깐 가려져도(다른 탭) 켜짐은 남는다 — 돌아오면 다시 듣는다. 다른 대화 화면은 저절로 넘겨받지 않는다
 *     (닫은 대화의 듣기가 엉뚱한 대화에서 몰래 다시 켜지지 않게).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';

type State = { on: boolean; owner: string | null };

let state: State = { on: false, owner: null };
const subs = new Set<() => void>();

function set(next: State): void {
  if (next.on === state.on && next.owner === state.owner) return;
  state = next;
  for (const fn of subs) fn();
}

export const voiceLoopOwner = {
  get: (): State => state,
  /** key 화면이 듣고 있는가. */
  listening: (key: string): boolean => state.on && state.owner === key,
  /** 마이크 버튼 — 맡은 화면이면 끄고, 아니면 켜고 넘겨받는다. */
  toggle(key: string): void {
    set(this.listening(key) ? { on: false, owner: null } : { on: true, owner: key });
  },
  /** 켜져 있을 때만 넘겨받는다(시작 화면이 열릴 때). */
  claim(key: string): void {
    if (state.on) set({ on: true, owner: key });
  },
  /** from 이 맡고 있으면 to 에게 넘긴다(시작 화면 → 연 대화). */
  pass(from: string, to: string): void {
    if (state.on && state.owner === from) set({ on: true, owner: to });
  },
  /** key 가 맡고 있으면 끈다(오류). */
  stop(key: string): void {
    if (state.owner === key) set({ on: false, owner: null });
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  /** 시험용. */
  reset(): void {
    set({ on: false, owner: null });
  },
};

/**
 * key 화면의 계속 듣기 — [듣는 중, 마이크 버튼, 오류로 끄기]. claimOnMount = 켜진 채 이 화면이 열리면 넘겨받는다(시작 화면).
 */
export function useVoiceLoopOwner(key: string, claimOnMount = false): [boolean, () => void, () => void] {
  const listening = useSyncExternalStore(
    voiceLoopOwner.subscribe,
    () => voiceLoopOwner.listening(key),
    () => false,
  );
  useEffect(() => {
    if (claimOnMount) voiceLoopOwner.claim(key);
  }, [key, claimOnMount]);
  const toggle = useCallback(() => voiceLoopOwner.toggle(key), [key]);
  const stop = useCallback(() => voiceLoopOwner.stop(key), [key]);
  return [listening, toggle, stop];
}
