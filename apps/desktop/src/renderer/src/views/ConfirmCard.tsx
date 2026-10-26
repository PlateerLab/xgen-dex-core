/**
 * 에이전트가 사이트 확인창의 확정 버튼을 누르기 전에 채팅 입력창 위에 뜨는 카드(main browser-confirm).
 *
 * 1·2·3 으로 고른다 — 1 이번만 누르기, 2 이 대화에서 같은 창은 다시 묻지 않기, 3 누르지 않고 할 말 적기(Enter 로 보냄).
 * Esc 는 입력 중이면 작성 내용을 유지하고 입력창만 닫고, 아니면 누르지 않기. 카드가 뜨면 첫 고르기에 초점을 준다(앱 안 초점만 — 창을 앞으로 꺼내지 않는다).
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BrowserConfirmChoice, BrowserConfirmRequest } from '@dex/protocol/browser';
import { xgen } from '../bridge';
import { CONFIRM_OPTIONS } from '../browser-confirm-store';

export function ConfirmCard({ request, more = 0 }: { request: BrowserConfirmRequest; more?: number }) {
  const [saying, setSaying] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLDivElement>(null);
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

  const answer = async (choice: BrowserConfirmChoice, text?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await xgen.browser.resolveConfirm({ requestId: request.requestId, choice, ...(text?.trim() ? { message: text.trim() } : {}) });
    } catch {
      setBusy(false);
    }
  };

  const pick = (choice: BrowserConfirmChoice) => (choice === 'deny' ? setSaying(true) : void answer(choice));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (saying) {
        setSaying(false);
        first.current?.focus({ preventScroll: true });
      } else void answer('deny');
      return;
    }
    if (saying) return;
    const option = CONFIRM_OPTIONS.find((o) => o.key === event.key);
    if (option) {
      event.preventDefault();
      pick(option.choice);
    }
  };

  const left = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  return (
    <div ref={card} className="confirm-card" role="alertdialog" aria-label="확인창 버튼을 눌러도 될지 묻는 카드" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="confirm-card-head" onClick={() => card.current?.focus({ preventScroll: true })}>
        <strong>에이전트가 확인창의 [{request.press}] 을(를) 누르려고 합니다</strong>
        <span className="confirm-card-left">{left}초 뒤 누르지 않음{more ? ` · 대기 ${more}개 더` : ''}</span>
      </div>
      <blockquote className="confirm-card-dialog" onClick={() => card.current?.focus({ preventScroll: true })}>
        {request.dialogText || '(문구 없음)'}
        {request.buttons.length > 0 && <span className="confirm-card-buttons"> 버튼: {request.buttons.join(' · ')}</span>}
      </blockquote>
      {(request.pageTitle || request.pageOrigin) && (
        <div className="confirm-card-page small">{[request.pageTitle, request.pageOrigin].filter(Boolean).join(' — ')}</div>
      )}
      <div className="confirm-card-options">
        {CONFIRM_OPTIONS.map((option, index) => (
          <button
            key={option.key}
            ref={index === 0 ? first : undefined}
            type="button"
            disabled={busy}
            className={saying && option.choice === 'deny' ? 'selected' : undefined}
            onClick={() => pick(option.choice)}
          >
            <span className="confirm-card-key">{option.key}</span>
            {option.label}
          </button>
        ))}
      </div>
      <div className="confirm-card-left">Esc · {saying ? '입력 닫기 (작성 내용 유지)' : '누르지 않기'}</div>
      {saying && (
        <form
          className="confirm-card-say"
          onSubmit={(event) => {
            event.preventDefault();
            void answer('deny', message);
          }}
        >
          <textarea
            ref={say}
            rows={2}
            value={message}
            disabled={busy}
            placeholder="에이전트에게 할 말 (예: 임시저장까지만 하고 멈춰). 비워 두면 누르지 않기만 합니다."
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void answer('deny', message);
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
