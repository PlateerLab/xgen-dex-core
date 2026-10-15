/**
 * 대화 이름 칸(사이드바 줄·채팅 기록 관리). Enter·칸 밖으로 나가면 저장, Esc 는 그만두기(null).
 * 빈 이름이면 main 이 첫 질문의 제목으로 되돌린다.
 */
import React, { useRef, useState } from 'react';

export const RenameInput: React.FC<{ initial: string; onDone: (title: string | null) => void; className?: string }> = ({
  initial,
  onDone,
  className = 'xd-conv-rename',
}) => {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      className={className}
      autoFocus
      value={value}
      maxLength={200}
      aria-label="대화 이름"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(value);
        else if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value)}
    />
  );
};
