/**
 * HotkeyCapture — click → press a combo → an Electron accelerator string.
 * Ported from geny-connector. While recording, global shortcuts are suspended
 * (hotkeys.pause) so the current combo isn't swallowed system-wide during capture.
 */
import React, { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { xgen } from '../bridge';

function keyName(e: KeyboardEvent): string | null {
  const code = e.code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Numpad')) {
    const n = code.slice(6);
    if (/^\d$/.test(n)) return 'num' + n;
    const m: Record<string, string> = { Enter: 'Enter', Add: 'numadd', Subtract: 'numsub', Multiply: 'nummult', Divide: 'numdiv', Decimal: 'numdec' };
    return m[n] ?? null;
  }
  const named: Record<string, string> = {
    Enter: 'Enter', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  if (code in named) return named[code];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return null;
}

function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = keyName(e);
  if (!key) return null; // modifier-only so far → keep waiting
  if (mods.length === 0) return null; // a global hotkey needs at least one modifier
  return [...mods, key].join('+');
}

export function prettyAccel(acc: string): string {
  if (!acc) return '';
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return acc
    .replace(/CommandOrControl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Command/g, '⌘')
    .replace(/Control/g, 'Ctrl')
    .replace(/Alt/g, mac ? '⌥' : 'Alt')
    .replace(/Shift/g, mac ? '⇧' : 'Shift')
    .split('+')
    .join(' + ');
}

export const HotkeyCapture: React.FC<{ value: string; onCapture: (acc: string) => void }> = ({
  value,
  onCapture,
}) => {
  const [recording, setRecording] = useState(false);
  const start = () => {
    if (recording) return;
    setRecording(true);
    xgen.hotkeys.pause();
  };
  const stop = () => {
    setRecording(false);
    xgen.hotkeys.resume();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        start();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      stop();
      return;
    }
    const acc = keyEventToAccelerator(e.nativeEvent);
    if (acc) {
      onCapture(acc);
      stop();
    }
  };
  return (
    <button
      type="button"
      className={`hotkey-capture ${recording ? 'recording' : ''}`}
      onClick={start}
      onKeyDown={onKeyDown}
      onBlur={stop}
    >
      {recording ? '키 입력…' : prettyAccel(value) || '설정 안 됨'}
    </button>
  );
};
