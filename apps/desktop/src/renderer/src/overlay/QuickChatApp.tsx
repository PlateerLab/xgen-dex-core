/**
 * QuickChatApp — the floating, Spotlight-style input bar summoned by the global
 * hotkey (default Cmd/Ctrl+Shift+Enter). Type a message, hit Enter, and it's
 * relayed into the active agent's chat in the main window. Faithful port of
 * geny-connector's QuickChatApp.
 *
 * The WINDOW is permanent (main keeps a transparent, top-most, on-screen window
 * alive so it layers above full-screen apps). What appears/disappears is the
 * CARD — this component only paints it while `visible`, toggled by main's
 * opened/dismissed events. Dismiss on Esc or focus-loss.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { XgenMark } from '../brand/Logo';
import { SendIcon } from '../brand/icons';

type Phase = 'idle' | 'sending' | 'sent' | 'error';

export function QuickChatApp(): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  useEffect(() => {
    const offOpen = xgen.quickChat.onOpened(() => {
      if (sentTimer.current) clearTimeout(sentTimer.current);
      setText('');
      setPhase('idle');
      setError('');
      setVisible(true);
      setTimeout(focusInput, 20);
    });
    const offDismiss = xgen.quickChat.onDismissed(() => setVisible(false));
    return () => {
      offOpen();
      offDismiss();
    };
  }, [focusInput]);

  // When the window gains OS focus (main grabs it a tick after summon), refocus.
  useEffect(() => {
    const onWinFocus = () => {
      if (visible) focusInput();
    };
    window.addEventListener('focus', onWinFocus);
    return () => window.removeEventListener('focus', onWinFocus);
  }, [visible, focusInput]);

  // Auto-grow the textarea up to a few lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 84)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const body = text.trim();
    if (!body || phase === 'sending') return;
    setPhase('sending');
    setError('');
    const r = await xgen.quickChat.submit(body);
    if (r?.ok) {
      setPhase('sent');
      setText('');
      if (sentTimer.current) clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => setPhase('idle'), 1400);
    } else {
      setPhase('error');
      setError(r?.error || '전송에 실패했습니다.');
      setTimeout(focusInput, 0);
    }
  }, [text, phase, focusInput]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setVisible(false);
      xgen.quickChat.close();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const canSend = !!text.trim() && phase !== 'sending';

  if (!visible) return <div className="qc-root" />;

  return (
    <div className="qc-root">
      <div className="qc-card">
        <div className="qc-head">
          <XgenMark height={14} variant="color" />
          <span className="qc-name">빠른 채팅</span>
        </div>
        <div className="qc-bar">
          <textarea
            ref={inputRef}
            className="qc-input"
            value={text}
            rows={1}
            placeholder="메시지를 입력하고 Enter…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoFocus
          />
          <button className="qc-send" onClick={() => void submit()} disabled={!canSend} aria-label="전송">
            <SendIcon size={17} />
          </button>
        </div>
        <div className="qc-foot">
          {phase === 'error' ? (
            <span className="qc-hint err">⚠ {error}</span>
          ) : phase === 'sent' ? (
            <span className="qc-hint ok">전송됨</span>
          ) : phase === 'sending' ? (
            <span className="qc-hint">전송 중…</span>
          ) : (
            <span className="qc-hint">
              <kbd>Enter</kbd> 전송 · <kbd>Shift + Enter</kbd> 줄바꿈 · <kbd>Esc</kbd> 닫기
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
