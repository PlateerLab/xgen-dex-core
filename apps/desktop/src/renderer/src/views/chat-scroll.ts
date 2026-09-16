/**
 * 채팅 스크롤 — 답이 나오는 동안 화면을 어디에 붙잡아 둘지.
 *
 * 예전에는 메시지가 바뀔 때마다 무조건 맨 아래로 끌어내려서, 답이 나오는 중에는 위로 올려 읽을 수가
 * 없었다(2026-09-16 사용자 지적). 규칙은 흔한 채팅 앱과 같다.
 *   - 보낼 때는 맨 아래로 내려가 답을 따라간다.
 *   - 맨 아래에 붙어 있으면 새 글이 올 때마다 따라 내려간다.
 *   - 사용자가 위로 올리면 그 자리에 둔다. 다시 맨 아래까지 내리면 따라가기를 되켠다.
 *   - 많이 올라가 있으면 [맨 아래로] 버튼을 띄운다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 이 안쪽이면 "맨 아래에 붙어 있다"고 본다 — 관성 스크롤·소수점 오차를 넘길 만큼만. */
export const STICK_THRESHOLD_PX = 64;
/** 이만큼 떨어지면 [맨 아래로] 버튼을 보여 준다(살짝 올린 것까지 버튼이 뜨면 시끄럽다). */
export const JUMP_THRESHOLD_PX = 240;

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 맨 아래까지 남은 거리(px). */
export function distanceFromBottom(box: ScrollBox): number {
  return Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
}

/** 따라가기를 유지할 만큼 아래에 붙어 있는가. */
export function isNearBottom(box: ScrollBox, threshold = STICK_THRESHOLD_PX): boolean {
  return distanceFromBottom(box) <= threshold;
}

/** [맨 아래로] 버튼을 보여 줄 만큼 올라가 있는가. */
export function shouldShowJump(box: ScrollBox, threshold = JUMP_THRESHOLD_PX): boolean {
  return distanceFromBottom(box) > threshold;
}

/** 진단용 — 어디서 맨 아래로 내렸는지 콘솔에 남긴다. */
const DEBUG_SCROLL = false;

export interface StickToBottom {
  /** 지금 맨 아래를 따라가는 중인가. */
  stuck: boolean;
  /** [맨 아래로] 버튼을 그릴까. */
  showJump: boolean;
  /** 맨 아래로 내리고 따라가기를 켠다(보내기·버튼). */
  jumpToBottom: (smooth?: boolean) => void;
}

/**
 * `ref` 가 가리키는 스크롤 상자를 위 규칙대로 붙잡는다.
 * `content` 는 바뀔 때마다 따라 내려갈 값(메시지 배열 등), `resetKey` 는 대화가 바뀌면 바꿀 값이다.
 */
export function useStickToBottom(
  ref: { current: HTMLElement | null },
  content: unknown,
  resetKey: string,
): StickToBottom {
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const [showJump, setShowJump] = useState(false);
  // 직전 스크롤 위치 — "위로 움직였다"는 사실만으로 사용자의 의사를 읽는다.
  // (시간으로 우리 스크롤과 사용자 스크롤을 가르면, 답이 빠르게 나올 때 사용자의 스크롤이 묻힌다.)
  const lastTop = useRef(0);

  const scrollToBottom = useCallback(
    (smooth = false, reason = '?') => {
      const el = ref.current;
      if (!el) return;
      if (DEBUG_SCROLL) console.debug('[stick] scrollToBottom', reason, 'stuck=', stuckRef.current);
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      lastTop.current = el.scrollHeight;
    },
    [ref],
  );

  const jumpToBottom = useCallback(
    (smooth = true) => {
      stuckRef.current = true;
      setStuck(true);
      setShowJump(false);
      scrollToBottom(smooth, 'jump');
    },
    [scrollToBottom],
  );

  // 스크롤 방향으로 판단한다.
  //  - 위로 움직였으면 사용자가 읽으려는 것이다 → 따라가기를 끈다.
  //  - 맨 아래에 닿으면(우리가 내렸든 사용자가 내렸든) 다시 따라간다.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const movedUp = top < lastTop.current - 4;
      lastTop.current = top;
      const near = isNearBottom(el);
      const next = near ? true : movedUp ? false : stuckRef.current;
      if (DEBUG_SCROLL && next !== stuckRef.current) console.debug('[stick] scroll → stuck=', next, 'dist=', distanceFromBottom(el));
      stuckRef.current = next;
      setStuck(next);
      setShowJump(!next && shouldShowJump(el));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);

  // 새 글·도구 결과가 붙을 때 — 붙어 있을 때만 따라 내려간다.
  useEffect(() => {
    if (stuckRef.current) scrollToBottom(false, 'content');
  }, [content, scrollToBottom]);

  // 대화를 바꾸면 맨 아래에서 시작한다.
  useEffect(() => {
    stuckRef.current = true;
    setStuck(true);
    setShowJump(false);
    scrollToBottom(false, 'reset');
    // 이력·그림이 조금 늦게 들어와 높이가 커지는 경우까지 맨 아래에서 시작하게 한다.
    const timers = [80, 300, 900].map((ms) =>
      window.setTimeout(() => {
        if (stuckRef.current) scrollToBottom(false, 'reset-late');
      }, ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [resetKey, scrollToBottom]);

  // 그림·표가 늦게 커져도 붙어 있으면 그대로 맨 아래를 유지한다.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) scrollToBottom(false, 'resize');
    });
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, resetKey, scrollToBottom]);

  return { stuck, showJump, jumpToBottom };
}
