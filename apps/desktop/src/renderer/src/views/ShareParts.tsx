/**
 * 공유 창 부품: 앱 공유·채팅 공유 창이 함께 쓴다(웹의 @xgen/ui ShareAudienceChoice·ShareLinkField 와 같은 모양).
 *
 *   ShareAudiencePicker  공개 범위 두 갈래(XGEN 사용자에게 / 모두에게)
 *   ShareToggleRow       함께 공유할 것 한 줄(작업 과정·파일)
 *   ShareLinkRow         만든 링크(읽기 전용) + [링크 복사]
 */
import React, { useRef, useState } from 'react';
import type { ShareAudience } from '@dex/protocol';
import { copyText } from '../bridge';

const LockIcon: React.FC = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const GlobeIcon: React.FC = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
  </svg>
);

export const ShareAudiencePicker: React.FC<{
  value: ShareAudience;
  onChange: (next: ShareAudience) => void;
  disabled?: boolean;
  labels: Record<ShareAudience, { title: string; hint: string }>;
  ariaLabel: string;
}> = ({ value, onChange, disabled = false, labels, ariaLabel }) => (
  <div className="share-audience" role="radiogroup" aria-label={ariaLabel}>
    {(['users', 'public'] as const).map((key) => {
      const on = value === key;
      return (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={on}
          className={`share-audience-option${on ? ' on' : ''}`}
          disabled={disabled}
          onClick={() => onChange(key)}
        >
          <span className="share-audience-icon">{key === 'users' ? <LockIcon /> : <GlobeIcon />}</span>
          <span className="share-audience-text">
            <span className="share-audience-title">{labels[key].title}</span>
            <span className="share-audience-hint">{labels[key].hint}</span>
          </span>
          <span className="share-audience-dot" aria-hidden />
        </button>
      );
    })}
  </div>
);

export const ShareToggleRow: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  hint: string;
  disabled?: boolean;
}> = ({ checked, onChange, title, hint, disabled = false }) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    className={`share-toggle${checked ? ' on' : ''}`}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  >
    <span className="share-toggle-box" aria-hidden>
      {checked ? (
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 5 5 9-10" />
        </svg>
      ) : null}
    </span>
    <span className="share-audience-text">
      <span className="share-toggle-title">{title}</span>
      <span className="share-audience-hint">{hint}</span>
    </span>
  </button>
);

export const ShareLinkRow: React.FC<{ url: string; copyLabel: string; copiedLabel: string }> = ({
  url,
  copyLabel,
  copiedLabel,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      // 클립보드가 막혔다: 칸을 골라 두면 사람이 바로 복사한다
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };
  return (
    <div className="share-link-row">
      <input ref={inputRef} readOnly value={url} aria-label={copyLabel} onFocus={(e) => e.currentTarget.select()} />
      <button className="primary" onClick={() => void copy()}>
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
};
