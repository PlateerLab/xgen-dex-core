/**
 * 에이전트가 일을 이어 가기 전에 묻는 카드 — 채팅 입력창 위, 사이트 확인창 카드(ConfirmCard)와 같은 자리·모양(main user-confirm).
 *
 * 1·2 로 고른다 — 1 진행, 2 고칠 점 적기(Enter 로 보냄). Esc 는 적는 중이면 적기만 닫고(적던 말을 버리고 거절하지 않게),
 * 아니면 말 없이 진행하지 않기. 카드가 뜨면 첫 고르기에 초점을 준다
 * (앱 안 초점만 — 창을 앞으로 꺼내지 않는다).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { UserConfirmChoice, UserConfirmRequest } from '@dex/protocol/user-confirm';
import { xgen } from '../bridge';
import { USER_CONFIRM_OPTIONS, leftText } from '../user-confirm-store';

export function UserConfirmCard({ request, more = 0 }: { request: UserConfirmRequest; more?: number }) {
  const [saying, setSaying] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const first = useRef<HTMLButtonElement>(null);
  const say = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    first.current?.focus({ preventScroll: true });
  }, [request.requestId]);
  useEffect(() => {
    if (saying) say.current?.focus();
  }, [saying]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const answer = async (choice: UserConfirmChoice, text?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await xgen.chat.resolveUserConfirm({ requestId: request.requestId, choice, ...(text?.trim() ? { message: text.trim() } : {}) });
    } catch {
      setBusy(false);
    }
  };

  const pick = (choice: UserConfirmChoice) => (choice === 'revise' ? setSaying(true) : void answer(choice));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (saying) {
        setSaying(false);
        first.current?.focus({ preventScroll: true });
      } else void answer('revise');
      return;
    }
    if (saying) return;
    const option = USER_CONFIRM_OPTIONS.find((o) => o.key === event.key);
    if (option) {
      event.preventDefault();
      pick(option.choice);
    }
  };

  const left = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  return (
    <div className="confirm-card" role="alertdialog" aria-label="에이전트가 진행해도 될지 묻는 카드" onKeyDown={onKeyDown}>
      <div className="confirm-card-head">
        <strong>{request.question}</strong>
        <span className="confirm-card-left">{leftText(left)} 뒤 진행하지 않음{more ? ` · 대기 ${more}개 더` : ''}</span>
      </div>
      {request.details && <div className="confirm-card-details">{request.details}</div>}
      <div className="confirm-card-options">
        {USER_CONFIRM_OPTIONS.map((option, index) => (
          <button
            key={option.key}
            ref={index === 0 ? first : undefined}
            type="button"
            disabled={busy}
            className={saying && option.choice === 'revise' ? 'selected' : undefined}
            onClick={() => pick(option.choice)}
          >
            <span className="confirm-card-key">{option.key}</span>
            {option.label}
          </button>
        ))}
      </div>
      {saying && (
        <form
          className="confirm-card-say"
          onSubmit={(event) => {
            event.preventDefault();
            void answer('revise', message);
          }}
        >
          <textarea
            ref={say}
            rows={2}
            value={message}
            disabled={busy}
            placeholder="고칠 점 (예: 키워드에 '선물용' 추가해 줘). 비워 두면 진행하지 않기만 합니다."
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void answer('revise', message);
              }
            }}
          />
          <button type="submit" disabled={busy}>
            보내기
          </button>
        </form>
      )}
    </div>
  );
}
