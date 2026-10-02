/** 실패를 구조로 — 무슨 일인지 한 줄, 이제 할 일 한 줄, 문의 코드. 원문은 접어 둔다(Dex 채팅과 같은 모양·같은 CSS). */
import React, { useState } from 'react';
import type { XgenErrorInfo } from '@dex/protocol';

export const ErrorBlock: React.FC<{ info: XgenErrorInfo }> = ({ info }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-error" role="alert">
      <div className="chat-error-head">
        <span className="chat-error-icon" aria-hidden>
          !
        </span>
        <span className="chat-error-title">{info.title}</span>
      </div>
      {info.hint && <p className="chat-error-hint">{info.hint}</p>}
      <div className="chat-error-foot">
        <span className="chat-error-code">{info.code}</span>
        {info.detail && info.detail !== info.title && (
          <button type="button" className="chat-error-toggle" onClick={() => setOpen((v) => !v)}>
            {open ? '자세히 접기' : '자세히'}
          </button>
        )}
      </div>
      {open && info.detail && <pre className="chat-error-detail">{info.detail}</pre>}
    </div>
  );
};
