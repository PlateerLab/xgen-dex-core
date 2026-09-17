/**
 * 출처 근거 — 답변이 무엇을 읽고 그렇게 말했는지.
 *
 * 앱에서는 출처 이름표만 보이고 눌러도 아무 일이 없었다. 이름만으로는 "정말 그 문서에 그렇게
 * 적혀 있는가" 를 확인할 수 없고, 확인하려면 다른 화면으로 나가 문서를 찾아야 했다.
 *
 * 웹 채팅에는 문서 뷰어(PDF 하이라이트)가 있지만 여기서는 **서버가 이미 답과 함께 보내 준
 * 근거 글**을 보여 준다: 파일 이름과 쪽, 유사도, 그리고 실제로 읽은 대목. 문서 원본이 필요하면
 * 웹의 지식 컬렉션에서 이어서 본다 — 앱이 PDF 렌더러를 따로 갖는 것보다 정직하고 가볍다.
 */
import React, { useEffect } from 'react';
import type { Citation } from '@dex/protocol';
import { CloseIcon, DocIcon } from '../brand/icons';

/** 근거 글 — 서버가 청크 본문을 실어 줄 때만 있다(설정에 따라 없을 수 있다). */
function chunkTextOf(citation: Citation): string {
  const raw = citation.chunkText ?? (citation as { chunk_text?: unknown }).chunk_text;
  return typeof raw === 'string' ? raw.trim() : '';
}

export const CitationPanel: React.FC<{
  citation: Citation;
  onClose: () => void;
}> = ({ citation, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const text = chunkTextOf(citation);
  const score = typeof citation.score === 'number' ? citation.score : undefined;
  return (
    <div className="cite-backdrop" onMouseDown={onClose}>
      <div className="cite-panel" role="dialog" aria-label="출처" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cite-head">
          <DocIcon size={14} />
          <strong title={citation.fileName}>{citation.fileName ?? '문서'}</strong>
          {citation.pageNumber !== undefined && <span className="cite-page">p.{citation.pageNumber}</span>}
          {score !== undefined && <span className="cite-score">유사도 {score.toFixed(2)}</span>}
          <button className="fb-x" onClick={onClose} aria-label="닫기">
            <CloseIcon size={14} />
          </button>
        </div>
        {text ? (
          <pre className="cite-text">{text}</pre>
        ) : (
          <p className="cite-empty">
            이 출처에는 근거 글이 함께 오지 않았습니다. 원문은 지식 컬렉션에서 확인할 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
};
