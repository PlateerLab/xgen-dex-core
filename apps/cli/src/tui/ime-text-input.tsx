import { useEffect, useRef, useState } from 'react';
import { Text, useCursor, useInput, useStdout } from 'ink';
import stringWidth from 'string-width';

export interface CursorOrigin {
  x: number;
  y: number;
}

interface ImeTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  focus: boolean;
  cursorOrigin: CursorOrigin;
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

function TerminalCursor({ origin, offset }: { origin: CursorOrigin; offset: number }): null {
  const { setCursorPosition } = useCursor();
  setCursorPosition({ x: origin.x + offset, y: origin.y });
  return null;
}

/**
 * A controlled, single-line input that leaves the real terminal cursor visible.
 * The terminal IME draws its in-progress Hangul composition at that cursor.
 */
export function ImeTextInput(props: ImeTextInputProps): React.ReactNode {
  const { stdout } = useStdout();
  const initialSegments = graphemes(props.value);
  const [cursor, setCursor] = useState(initialSegments.length);
  const valueRef = useRef(props.value);
  const cursorRef = useRef(initialSegments.length);

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
        !input ||
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

      const inserted = graphemes(input);
      current.splice(currentCursor, 0, ...inserted);
      updateValue(current, currentCursor + inserted.length);
    },
    { isActive: props.focus },
  );

  const rawSegments = graphemes(props.value);
  const safeCursor = clamp(cursor, 0, rawSegments.length);
  const displayedSegments = props.mask ? rawSegments.map(() => props.mask ?? '') : rawSegments;
  // Keep one cell free for the IME's composing character and one for the surrounding UI.
  const maximumWidth = Math.max(1, (stdout.columns || 100) - props.cursorOrigin.x - 3);
  const visible = visibleInput(displayedSegments, safeCursor, maximumWidth);

  return (
    <>
      {rawSegments.length === 0 ? (
        <Text dimColor>{props.placeholder ?? ''}</Text>
      ) : (
        <Text>{visible.text}</Text>
      )}
      {props.focus ? <TerminalCursor origin={props.cursorOrigin} offset={visible.cursorWidth} /> : null}
    </>
  );
}
