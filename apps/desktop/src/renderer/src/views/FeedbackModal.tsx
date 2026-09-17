/**
 * 답변 평가 — 별점과 문제 유형, 그리고 하고 싶은 말.
 *
 * 웹 채팅에만 있던 창이라 앱에서 답이 틀려도 남길 곳이 없었다. 값(문제 유형)은 서버가 아는 목록
 * 그대로여야 관리자 화면에서 한 벌로 세어지므로 `@dex/protocol` 의 목록을 쓴다.
 *
 * 이미 남긴 평가는 그대로 열리고, 고치거나 지울 수 있다 — 한 번 누르면 끝인 평가는 사용자가
 * 잘못 눌렀을 때 되돌릴 길이 없다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FEEDBACK_ISSUE_TYPES, type ChatFeedback, type FeedbackIssueType } from '@dex/protocol';
import { CloseIcon } from '../brand/icons';

const MAX_COMMENT = 2000;

export interface FeedbackDraft {
  starRating: number;
  issueType: FeedbackIssueType;
  comment?: string;
}

export const FeedbackModal: React.FC<{
  /** 이미 남긴 평가 — 있으면 그 값으로 열리고 [지우기] 가 보인다. */
  initial?: ChatFeedback | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (draft: FeedbackDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}> = ({ initial, busy = false, error, onSubmit, onDelete, onClose }) => {
  const [star, setStar] = useState(initial?.starRating ?? 5);
  const [issue, setIssue] = useState<FeedbackIssueType>(
    (initial?.issueType as FeedbackIssueType) ?? FEEDBACK_ISSUE_TYPES[0],
  );
  const [comment, setComment] = useState(initial?.comment ?? '');
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fb-backdrop" onMouseDown={onClose}>
      <div className="fb" role="dialog" aria-label="답변 평가" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fb-head">
          <strong>답변 평가</strong>
          <button className="fb-x" onClick={onClose} aria-label="닫기">
            <CloseIcon size={14} />
          </button>
        </div>

        <label className="fb-label">별점</label>
        <div className="fb-stars" role="radiogroup" aria-label="별점">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              ref={n === 1 ? firstRef : undefined}
              type="button"
              role="radio"
              aria-checked={star === n}
              aria-label={`${n}점`}
              className={`fb-star${n <= star ? ' on' : ''}`}
              onClick={() => setStar(n)}
            >
              ★
            </button>
          ))}
          <span className="fb-star-num">{star} / 5</span>
        </div>

        <label className="fb-label" htmlFor="fb-issue">
          문제 유형
        </label>
        <select
          id="fb-issue"
          className="fb-select"
          value={issue}
          onChange={(e) => setIssue(e.target.value as FeedbackIssueType)}
        >
          {FEEDBACK_ISSUE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label className="fb-label" htmlFor="fb-comment">
          하고 싶은 말 <span className="fb-optional">(선택)</span>
        </label>
        <textarea
          id="fb-comment"
          className="fb-comment"
          value={comment}
          maxLength={MAX_COMMENT}
          placeholder="무엇이 어떻게 잘못됐는지 적어 주시면 고치는 데 큰 도움이 됩니다."
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="fb-count">
          {comment.length} / {MAX_COMMENT}
        </div>

        {error && (
          <div className="fb-error" role="alert">
            {error}
          </div>
        )}

        <div className="fb-foot">
          {initial && onDelete && (
            <button className="fb-btn danger" onClick={onDelete} disabled={busy}>
              지우기
            </button>
          )}
          <span className="fb-spacer" />
          <button className="fb-btn" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            className="fb-btn primary"
            onClick={() => onSubmit({ starRating: star, issueType: issue, comment: comment.trim() || undefined })}
            disabled={busy}
          >
            {busy ? '저장 중…' : initial ? '고치기' : '보내기'}
          </button>
        </div>
      </div>
    </div>
  );
};
