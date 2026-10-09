/**
 * 입력창. 채팅과 시작 화면이 같이 쓴다(Dex 채팅과 같은 `composer` 마크업·CSS).
 *
 * 잠기면(`locked` 에 까닭) 글을 쓸 수도 보낼 수도 없고, 덮개를 누르면 `onLocked` 가 불린다. 시작 화면이 그 까닭을
 * 보이고 고칠 칸으로 옮긴다.
 */
import React, { useLayoutEffect, useRef } from 'react';
import { SendIcon, StopIcon, Tooltip } from '../dex';

export const Composer: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 보내기 대답을 기다리는 중: 두 번 보내지 않게. */
  sending?: boolean;
  /** 답을 만드는 중: 보내기 대신 [정지]. */
  running?: boolean;
  onStop?: () => void;
  placeholder?: string;
  locked?: string | null;
  onLocked?: () => void;
}> = ({ value, onChange, onSend, sending = false, running = false, onStop, placeholder, locked, onLocked }) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 입력창은 쓰는 만큼 늘어난다(CSS 의 최대 높이까지).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <div className={`composer${locked ? ' xd-composer-locked' : ''}`}>
      <textarea
        ref={inputRef}
        className="composer-input"
        rows={1}
        value={value}
        disabled={!!locked}
        placeholder={placeholder ?? (running ? '답을 만드는 중입니다' : '메시지를 입력하세요')}
        aria-label="메시지"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      {running ? (
        <Tooltip label="정지">
          <button type="button" className="composer-send stop" aria-label="정지" onClick={onStop}>
            <StopIcon size={15} />
          </button>
        </Tooltip>
      ) : (
        <Tooltip label="보내기">
          <button type="button" className="composer-send" aria-label="보내기" disabled={!!locked || !value.trim() || sending} onClick={onSend}>
            <SendIcon size={16} />
          </button>
        </Tooltip>
      )}
      {locked && <button type="button" className="xd-composer-lock" aria-label={locked} onClick={onLocked} />}
    </div>
  );
};
