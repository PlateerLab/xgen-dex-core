import { useEffect, useRef, useState } from 'react';
import { Box, Text, useCursor, useInput } from 'ink';
import stringWidth from 'string-width';
import { useMeasured } from './measure';
import { classifyInput } from './terminal-input';

interface ImeTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus: boolean;
  placeholder?: string;
  mask?: string;
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

  useEffect(() => {
    if (props.value === valueRef.current) return;
    const previousLength = graphemes(valueRef.current).length;
    const nextLength = graphemes(props.value).length;
    const wasAtEnd = cursorRef.current >= previousLength;
    valueRef.current = props.value;
    moveCursor(wasAtEnd ? nextLength : cursorRef.current, nextLength);
  }, [props.value]);

  useInput(
    (input, key) => {
      const current = graphemes(valueRef.current);
      const currentCursor = clamp(cursorRef.current, 0, current.length);
      const event = classifyInput(input, pastingRef.current);

      if (event.kind === 'paste-start') {
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

      if (key.return) {
        props.onSubmit?.(valueRef.current);
        return;
      }
      if (key.leftArrow) {
        moveCursor(currentCursor - 1, current.length);
        return;
      }
      if (key.rightArrow) {
        moveCursor(currentCursor + 1, current.length);
        return;
      }
      if (key.home) {
        moveCursor(0, current.length);
        return;
      }
      if (key.end) {
        moveCursor(current.length, current.length);
        return;
      }
      if (key.backspace || key.delete) {
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
        return;
      }
      if (event.kind !== 'text') return;

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
