import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { IdeState, IdeStore } from '../store';

export const StoreContext = createContext<IdeStore | null>(null);

export function useStore(): IdeStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('IdeView 밖에서 IDE 부품을 썼습니다');
  return store;
}

/**
 * 상태의 한 조각을 구독한다. 고른 값이 얕게 같으면 다시 그리지 않는다 — 커서 이동 같은
 * 잦은 변경이 탐색기 전체를 다시 그리지 않게.
 */
export function useIde<T>(selector: (s: IdeState) => T): T {
  const store = useStore();
  const last = useRef<{ state: IdeState; value: T } | null>(null);
  const get = () => {
    const state = store.getState();
    const prev = last.current;
    if (prev && prev.state === state) return prev.value;
    const value = selector(state);
    if (prev && shallowEqual(prev.value, value)) {
      last.current = { state, value: prev.value };
      return prev.value;
    }
    last.current = { state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

function isPlain(v: object): boolean {
  if (Array.isArray(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 고른 값이 "같은가" — 배열·평범한 객체만 한 겹 비교한다. Set·Map 같은 것은 자기 키가 없어
 * 한 겹 비교로는 언제나 같아 보인다(펼친 폴더가 바뀌어도 탐색기가 다시 그려지지 않았다). 그런 것은
 * 저장소가 바꿀 때마다 새로 만들므로 같은 것인지로만 본다.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (!isPlain(a) || !isPlain(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

// ── 초점 돌려주기 ────────────────────────────────────────────────────
// 떠 있는 창(빠른 열기·대화 상자·메뉴)이 닫히면 초점은 원래 있던 곳(편집기·탐색기·터미널)으로
// 돌아가야 한다(VS Code 와 같다). 그러지 않으면 초점이 문서 밖으로 빠져 IDE 단축키가 듣지 않는다.

const OVERLAY = '.xide-qo-scrim, .xide-dialog-scrim, .xide-menu';

interface FocusHome {
  root: HTMLElement | null;
  last: HTMLElement | null;
}

const homes = new WeakMap<IdeStore, FocusHome>();

export function focusHome(store: IdeStore): FocusHome {
  let home = homes.get(store);
  if (!home) {
    home = { root: null, last: null };
    homes.set(store, home);
  }
  return home;
}

/** IDE 안에서 초점이 간 곳을 기억한다(떠 있는 창 안은 빼고). */
export function rememberFocus(store: IdeStore, target: EventTarget | null): void {
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && !target.closest(OVERLAY)) {
    focusHome(store).last = target;
  }
}

/** 떠 있는 창이 닫힐 때 초점이 갈 곳을 잃었으면 기억해 둔 자리(없으면 IDE 전체)로 돌려준다. */
export function useFocusReturn(open: boolean): void {
  const store = useStore();
  useEffect(() => {
    if (!open) return;
    return () => {
      // 닫으며 고른 일이 초점을 옮길 틈(파일을 열어 편집기로 가는 것)을 준 뒤에 본다.
      setTimeout(() => {
        const now = document.activeElement;
        if (now && now !== document.body && now.isConnected) return;
        const home = focusHome(store);
        const back = home.last?.isConnected ? home.last : home.root;
        back?.focus({ preventScroll: true });
      }, 0);
    };
  }, [open, store]);
}
