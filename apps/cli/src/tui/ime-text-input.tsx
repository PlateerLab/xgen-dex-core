import { useEffect, useRef, useState } from 'react';
import { Box, Text, useCursor, useInput } from 'ink';
import stringWidth from 'string-width';
import { useMeasured } from './measure';
import { classifyInput } from './terminal-input';
import * as hangul from './hangul';

interface ImeTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus: boolean;
  placeholder?: string;
  mask?: string;
  /** 한글 조합 중인가. 모드 표시를 옆에 붙이는 쪽에서 쓴다. */
  hangulMode?: boolean;
  onHangulModeChange?: (enabled: boolean) => void;
}

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function graphemes(value: string): string[] {
  return [...segmenter.segment(value)].map(({ segment }) => segment);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function visibleInput(
  segments: string[],
  cursor: number,
  maximumWidth: number,
): { text: string; cursorWidth: number } {
  let start = cursor;
  let widthBeforeCursor = 0;
  const followingWidth = cursor < segments.length ? stringWidth(segments[cursor] ?? '') : 0;
  const beforeLimit = Math.max(0, maximumWidth - Math.min(followingWidth, maximumWidth));

  while (start > 0) {
    const width = stringWidth(segments[start - 1] ?? '');
    if (widthBeforeCursor + width > beforeLimit) break;
    widthBeforeCursor += width;
    start -= 1;
  }

  let end = cursor;
  let totalWidth = widthBeforeCursor;
  while (end < segments.length) {
    const width = stringWidth(segments[end] ?? '');
    if (totalWidth + width > maximumWidth) break;
    totalWidth += width;
    end += 1;
  }

  return {
    text: segments.slice(start, end).join(''),
    cursorWidth: widthBeforeCursor,
  };
}

function TerminalCursor({ x, y }: { x: number; y: number }): null {
  const { setCursorPosition } = useCursor();
  setCursorPosition({ x, y });
  return null;
}

/**
 * 진짜 터미널 커서를 글자 자리에 두는 한 줄 입력 칸.
 *
 * 터미널 IME 는 조합 중인 한글을 커서 자리에 그린다. 그래서 커서가 어디에 서는지가
 * 곧 한글이 어디에 보이는지다.
 */
export function ImeTextInput(props: ImeTextInputProps): React.ReactNode {
  const [ref, placement] = useMeasured();
  const initialSegments = graphemes(props.value);
  const [cursor, setCursor] = useState(initialSegments.length);
  const valueRef = useRef(props.value);
  const cursorRef = useRef(initialSegments.length);
  const pastingRef = useRef(false);
  /** 아직 완성되지 않은 한글 한 글자. 값에는 이미 보이지만 다음 키로 바뀔 수 있다. */
  const composingRef = useRef<hangul.Composition>(hangul.EMPTY);

  const moveCursor = (next: number, length: number): void => {
    const resolved = clamp(next, 0, length);
    cursorRef.current = resolved;
    setCursor(resolved);
  };

  const updateValue = (segments: string[], nextCursor: number): void => {
    const nextValue = segments.join('');
    valueRef.current = nextValue;
    moveCursor(nextCursor, segments.length);
    props.onChange(nextValue);
  };

  // 포커스를 잃거나 한글 모드를 끄면 조합을 끝낸다. 남겨 두면 다음에 돌아왔을 때
  // 엉뚱한 글자에 이어 붙는다.
  useEffect(() => {
    if (!props.focus || !props.hangulMode) composingRef.current = hangul.EMPTY;
  }, [props.focus, props.hangulMode]);

  useEffect(() => {
    if (props.value === valueRef.current) return;
    const previousLength = graphemes(valueRef.current).length;
    const nextLength = graphemes(props.value).length;
    const wasAtEnd = cursorRef.current >= previousLength;
    valueRef.current = props.value;
    moveCursor(wasAtEnd ? nextLength : cursorRef.current, nextLength);
  }, [props.value]);

  /**
   * 조합 중인 글자를 값에 **그대로 반영**한다.
   *
   * 조합 중인 글자는 값의 커서 바로 앞 한 글자를 차지한다. 키가 올 때마다 그 자리를
   * 새 모습으로 갈아 끼우므로, 사용자는 `ㄱ → 가 → 간` 이 자라나는 것을 그대로 본다.
   * 값이 곧 화면이라 따로 그릴 것이 없고, 전송하면 보이던 그대로 나간다.
   */
  const applyComposition = (
    segments: string[],
    cursor: number,
    previous: string,
    commit: string,
    next: string,
  ): void => {
    const removed = previous ? 1 : 0;
    const inserted = graphemes(commit + next);
    segments.splice(cursor - removed, removed, ...inserted);
    updateValue(segments, cursor - removed + inserted.length);
  };

  useInput(
    (input, key) => {
      const current = graphemes(valueRef.current);
      const currentCursor = clamp(cursorRef.current, 0, current.length);
      const event = classifyInput(input, pastingRef.current);
      const composing = composingRef.current;
      const shown = hangul.display(composing);

      /** 조합을 끝내고 값에 확정한다. 커서를 옮기거나 전송하기 전에 부른다. */
      const settle = (): void => {
        composingRef.current = hangul.EMPTY;
      };

      if (event.kind === 'paste-start') {
        settle();
        pastingRef.current = true;
        return;
      }
      if (event.kind === 'paste-end') {
        pastingRef.current = false;
        return;
      }

      // 붙여넣는 동안은 키로 읽지 않는다. 붙인 내용 안의 줄바꿈이 "전송" 으로
      // 읽히면 반쪽짜리 메시지가 나가 버린다.
      if (pastingRef.current) {
        if (event.kind === 'text') {
          const inserted = graphemes(event.text);
          current.splice(currentCursor, 0, ...inserted);
          updateValue(current, currentCursor + inserted.length);
        }
        return;
      }

      // Ctrl+Space 로 한/영을 바꾼다 — ibus·fcitx 를 쓰던 손이 이미 아는 자리다.
      // (ink 은 Ctrl+Space 를 ctrl + '`' 로 준다.) Ctrl+L 도 받는다: 터미널이나
      // tmux 가 Ctrl+Space 를 먼저 채가는 경우가 있다.
      if (key.ctrl && (input === '`' || input === 'l')) {
        settle();
        props.onHangulModeChange?.(!props.hangulMode);
        return;
      }

      if (key.return) {
        settle();
        props.onSubmit?.(valueRef.current);
        return;
      }
      if (key.leftArrow) {
        settle();
        moveCursor(currentCursor - 1, current.length);
        return;
      }
      if (key.rightArrow) {
        settle();
        moveCursor(currentCursor + 1, current.length);
        return;
      }
      if (key.home) {
        settle();
        moveCursor(0, current.length);
        return;
      }
      if (key.end) {
        settle();
        moveCursor(current.length, current.length);
        return;
      }
      if (key.backspace || key.delete) {
        // 조합 중이면 글자를 되짚는다: `한` → `하` → `ㅎ`. 통째로 지우면 오타
        // 하나에 처음부터 다시 쳐야 한다.
        const stepped = hangul.back(composing);
        if (stepped.handled) {
          composingRef.current = stepped.state;
          applyComposition(current, currentCursor, shown, '', hangul.display(stepped.state));
          return;
        }
        if (currentCursor === 0) return;
        current.splice(currentCursor - 1, 1);
        updateValue(current, currentCursor - 1);
        return;
      }
      if (
        key.ctrl ||
        key.meta ||
        key.tab ||
        key.escape ||
        key.upArrow ||
        key.downArrow ||
        key.pageUp ||
        key.pageDown
      ) {
        settle();
        return;
      }
      if (event.kind !== 'text') return;

      if (props.hangulMode) {
        // 한 번에 여러 글자가 오는 것(붙여넣기 아닌 빠른 입력)도 순서대로 먹인다.
        let state = composing;
        let previous = shown;
        let segments = current;
        let cursor = currentCursor;
        for (const character of event.text) {
          const jamo = hangul.jamoOf(character);
          if (!jamo) {
            const flushed = hangul.flush(state);
            state = flushed.state;
            applyComposition(segments, cursor, previous, flushed.commit + character, '');
            segments = graphemes(valueRef.current);
            cursor = cursorRef.current;
            previous = '';
            continue;
          }
          const result = hangul.feed(state, jamo);
          state = result.state;
          const next = hangul.display(state);
          applyComposition(segments, cursor, previous, result.commit, next);
          segments = graphemes(valueRef.current);
          cursor = cursorRef.current;
          previous = next;
        }
        composingRef.current = state;
        return;
      }

      settle();
      const inserted = graphemes(event.text);
      current.splice(currentCursor, 0, ...inserted);
      updateValue(current, currentCursor + inserted.length);
    },
    { isActive: props.focus },
  );

  const rawSegments = graphemes(props.value);
  const safeCursor = clamp(cursor, 0, rawSegments.length);
  const displayedSegments = props.mask ? rawSegments.map(() => props.mask ?? '') : rawSegments;
  // 조합 중인 글자가 설 자리 한 칸을 남긴다.
  const maximumWidth = Math.max(1, (placement?.width ?? 40) - 1);
  const visible = visibleInput(displayedSegments, safeCursor, maximumWidth);

  return (
    <Box ref={ref} flexGrow={1}>
      {rawSegments.length === 0 ? (
        <Text dimColor>{props.placeholder ?? ''}</Text>
      ) : (
        <Text>{visible.text}</Text>
      )}
      {props.focus && placement ? (
        <TerminalCursor x={placement.x + visible.cursorWidth} y={placement.y} />
      ) : null}
    </Box>
  );
}
