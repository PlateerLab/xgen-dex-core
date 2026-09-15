/**
 * ToolLogModal — 한 답변에서 쓴 도구의 **전체** 기록.
 *
 * 채팅 흐름에는 도구 활동을 한 번에 하나만, 스르륵 지나가게 보여준다 — 그게
 * 대화를 읽는 데 방해가 되지 않는 유일한 방식이다. 하지만 무언가 잘못됐을
 * 때는 정반대가 필요하다: **전부, 순서대로, 인자와 결과까지.**
 *
 * 그래서 흐름에서는 지나가게 두고, 필요할 때 여기서 펼친다.
 *
 * 복사를 1급으로 둔다. 이 화면을 여는 사람은 대개 그 내용을 다른 곳(이슈,
 * 동료, 다른 대화)으로 옮기려는 참이다. 스크롤해서 드래그하게 만들면 그
 * 순간 이 기능이 없는 것과 같아진다.
 *
 * 이름 줄이기 · 상태 · 복사용 텍스트 규칙은 `@dex/protocol/tool-activity` 가
 * 정본이다 — 웹도 같은 규칙으로 그린다. 여기에는 화면만 있다.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../bridge';
import type { ToolEvent } from '@dex/protocol/types';
import {
  formatToolLog,
  shortToolName,
  toolPhase,
  toolValueText,
} from '@dex/protocol/tool-activity';
import { CloseIcon, CopyIcon, DocIcon } from '../brand/icons';

interface Props {
  events: ToolEvent[];
  onClose: () => void;
  /** 이 인덱스의 항목을 펼친 채 연다 — 흐름의 도구 칩을 눌러 "그 시점"으로
   *  바로 들어오는 경로 (칩은 하나씩 빠르게 지나가므로). */
  initialOpen?: number;
}

export const ToolLogModal: React.FC<Props> = ({ events, onClose, initialOpen }) => {
  const [copied, setCopied] = useState('');
  const [open, setOpen] = useState<Set<number>>(() =>
    initialOpen !== undefined && initialOpen >= 0 && initialOpen < events.length
      ? new Set([initialOpen])
      : new Set(),
  );
  const [copyError, setCopyError] = useState('');
  const focusRef = useRef<HTMLDivElement | null>(null);

  // 지목된 항목이 보이는 위치로 — 펼쳐놓고 스크롤 밖이면 연 의미가 없다.
  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = useMemo(() => formatToolLog(events), [events]);

  // Esc 로 닫는다 — 모달을 열고 빠져나올 길이 마우스뿐이면 답답하다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = useCallback(async (value: string, key: string) => {
    const ok = await copyText(value);
    if (ok) {
      setCopied(key);
      setCopyError('');
      setTimeout(() => setCopied(''), 1600);
    } else {
      // 클립보드가 막힌 환경 — 조용히 넘기면 사용자는 복사됐다고 믿고
      // 엉뚱한 것을 붙여넣는다.
      setCopyError('클립보드를 쓸 수 없습니다');
    }
  }, []);

  const toggle = (i: number): void =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="toollog-backdrop" onMouseDown={onClose}>
      <div
        className="toollog"
        role="dialog"
        aria-label="도구 실행 기록"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="toollog-head">
          <div className="toollog-title">
            <DocIcon size={14} />
            <span>도구 실행 기록</span>
            <span className="toollog-count">{events.length}건</span>
          </div>
          <div className="toollog-actions">
            <button className="toollog-btn" onClick={() => void copy(text, 'all')}>
              <CopyIcon size={13} />
              {copied === 'all' ? '복사됨' : '전체 복사'}
            </button>
            <button className="toollog-btn icon" onClick={onClose} aria-label="닫기">
              <CloseIcon size={14} />
            </button>
          </div>
        </div>

        {copyError && <div className="toollog-copyerr">복사하지 못했습니다: {copyError}</div>}

        <div className="toollog-body">
          {events.length === 0 ? (
            <div className="toollog-empty">이 답변에서는 도구를 쓰지 않았습니다.</div>
          ) : (
            events.map((e, i) => {
              const { label, tone } = toolPhase(e);
              const isOpen = open.has(i);
              const input = toolValueText(e.toolInput);
              const result = toolValueText(e.result);
              return (
                <div
                  className={`toollog-item ${tone}${i === initialOpen ? ' focused' : ''}`}
                  key={i}
                  ref={i === initialOpen ? focusRef : undefined}
                >
                  <button className="toollog-row" onClick={() => toggle(i)}>
                    <span className="toollog-idx">{i + 1}</span>
                    <span className="toollog-name" title={e.toolName}>
                      {shortToolName(e.toolName)}
                    </span>
                    <span className={`toollog-phase ${tone}`}>{label}</span>
                    {typeof e.durationMs === 'number' && (
                      <span className="toollog-ms">{e.durationMs}ms</span>
                    )}
                    <span className="toollog-caret">{isOpen ? '−' : '+'}</span>
                  </button>
                  {isOpen && (
                    <div className="toollog-detail">
                      {e.toolName && shortToolName(e.toolName) !== e.toolName && (
                        <div className="toollog-full" title={e.toolName}>
                          {e.toolName}
                        </div>
                      )}
                      {input && (
                        <>
                          <div className="toollog-label">입력</div>
                          <pre>{input}</pre>
                        </>
                      )}
                      {e.error && (
                        <>
                          <div className="toollog-label err">오류</div>
                          <pre className="err">{String(e.error)}</pre>
                        </>
                      )}
                      {result && (
                        <>
                          <div className="toollog-label">결과</div>
                          <pre>{result}</pre>
                        </>
                      )}
                      <button
                        className="toollog-btn small"
                        onClick={() => void copy(formatToolLog([e]), `i${i}`)}
                      >
                        <CopyIcon size={12} />
                        {copied === `i${i}` ? '복사됨' : '이 항목 복사'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
