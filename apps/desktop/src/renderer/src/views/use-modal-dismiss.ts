/**
 * 모달을 닫는 두 가지 방법을 한 곳에 모은다.
 *
 * 바깥 클릭은 이미 각 모달이 `<div className="modal-backdrop" onClick={onClose}>`
 * 로 처리하고 있었다(실측 확인). 빠져 있던 것은 **Esc** 다 — 키보드로 열고
 * 마우스로만 닫아야 하는 상태였다.
 *
 * 왜 훅인가 (래퍼 컴포넌트가 아니라):
 *   모달이 12곳에 흩어져 있고 각자 다른 레이아웃·클래스를 쓴다. 래퍼로 감싸면
 *   전부 뜯어야 하고 회귀 위험이 커진다. 훅은 한 줄만 추가하면 되고 마크업을
 *   건드리지 않는다.
 *
 * 리스너는 **capture 단계**에 건다. 모달 안의 입력창들이 자기 Esc 를 먼저
 * 처리하고 `stopPropagation` 하는 경우가 있어(답장 배너 취소 등), bubble 로
 * 걸면 그런 모달만 조용히 안 닫힌다.
 *
 * 여러 모달이 겹쳐 열려 있으면 **가장 나중에 열린 것 하나만** 닫는다. 전부
 * 닫아 버리면 "확인창을 취소했더니 뒤에 있던 설정창까지 사라지는" 일이 된다.
 */
import { useEffect, useRef } from 'react';
import type React from 'react';

/** 열려 있는 모달들의 닫기 함수 — 마지막(맨 위)이 Esc 의 대상이다. */
const stack: Array<() => void> = [];

let wired = false;

function ensureListener(): void {
  if (wired) return;
  wired = true;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || stack.length === 0) return;
      // IME 조합 중의 Esc 는 조합 취소다 — 모달을 닫으면 안 된다.
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      stack[stack.length - 1]?.();
    },
    true,
  );
}

/**
 * Esc 로 이 모달을 닫는다.
 *
 * `enabled` 를 false 로 주면 등록하지 않는다 — 조건부로 열리는 모달이
 * 닫혀 있는 동안 스택을 차지하지 않게 한다.
 */
export function useModalDismiss(onClose: () => void, enabled = true): void {
  // 콜백은 ref 로 들고 다닌다. 부모가 매 렌더 새 함수를 만들어도 스택 등록은
  // 한 번뿐이고, 호출 시점에는 항상 최신 것이 불린다 (클로저로 잡으면 첫
  // onClose 에 굳어 버려 나중 상태를 못 본다).
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const entry = (): void => latest.current();
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}

/**
 * 바깥을 클릭하면 닫는다 — **backdrop 이 없는** 인라인 패널용.
 *
 * 모달은 전면을 덮는 `.modal-backdrop` 이 클릭을 받아 주지만, 사이드바 안에
 * 펼쳐지는 폼(새 대화 / 1:1 상대 찾기)은 그런 것이 없어 닫기 버튼에 의존했다.
 * 여기서 같은 감각을 만든다: 폼 밖을 누르면 닫힌다.
 *
 * `insideRefs` 에는 **폼을 여는 버튼도** 넣어야 한다. 안 넣으면 토글 버튼을
 * 누를 때 "바깥 클릭 → 닫기" 와 버튼의 "토글 → 열기" 가 같이 일어나 한 번
 * 눌러서는 절대 안 열리거나 깜빡인다.
 *
 * `mousedown` 을 듣는 이유: `click` 은 버튼을 누른 뒤 떼는 순간 오는데, 그 사이
 * 목록이 다시 그려지면 클릭 대상이 사라져 판정이 어긋난다. 누르는 시점이 곧
 * 사용자의 의도다.
 */
export function useOutsideDismiss(
  insideRefs: Array<React.RefObject<HTMLElement | null>>,
  onClose: () => void,
  enabled = true,
): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  const refs = useRef(insideRefs);
  refs.current = insideRefs;

  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      for (const ref of refs.current) {
        if (ref.current?.contains(target)) return;
      }
      latest.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [enabled]);
}
