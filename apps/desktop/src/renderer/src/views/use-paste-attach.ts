/**
 * 작성기에 포커스가 없을 때 붙여 넣어도 첨부로 받는다 (2026-10-22, 웹 채팅 입력창과 같은 동작).
 *
 * 대화를 읽다가, 보내기 단추를 누른 직후 화면 캡처를 붙여 넣으면 아무 일도 없었다(입력창의 onPaste 만 받았다).
 * 어느 대화가 받을지는 :func:`ownsDocumentPaste` 가 정한다. 입력창 안의 붙여넣기는 그 입력창의 onPaste 가 받고
 * preventDefault 하므로 여기서는 지나간다.
 */
import { useEffect, type RefObject } from 'react';
import { PASTE_ROOT_ATTR, ownsDocumentPaste, pastedFiles } from './chat-attach';

let lastPointer: Element | null = null;
let lastInput: HTMLElement | null = null;
let tracking = false;

/** 마지막으로 누른 곳과 마지막으로 쓴 작성기(창 하나에 한 번만 건다). */
function track(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = e.target instanceof Element ? e.target : null;
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement && t.closest(`[${PASTE_ROOT_ATTR}]`)) lastInput = t;
    },
    true,
  );
}

export function useDocumentPasteAttach(
  enabled: boolean,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  onFiles: (files: File[]) => void,
): void {
  useEffect(() => {
    track();
    if (!enabled) return undefined;
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const input = inputRef.current;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!input || !ownsDocumentPaste(target, input, { pointer: lastPointer, input: lastInput })) return;
      const files = pastedFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      onFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [enabled, inputRef, onFiles]);
}
