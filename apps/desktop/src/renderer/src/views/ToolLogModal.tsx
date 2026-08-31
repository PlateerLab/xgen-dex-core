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
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { copyText } from '../bridge';
import type { ToolEvent } from '../../../core/types';
import { CloseIcon, CopyIcon, DocIcon } from '../brand/icons';

interface Props {
  events: ToolEvent[];
  onClose: () => void;
}

/**
 * 목록에 쓸 짧은 이름 — 브릿지 접두사를 걷어낸다.
 *
 * `mcp__connector__mcp_mcp-atlassian_jira_search` 를 그대로 두면 목록이
 * 접두사로만 채워져 무엇이 무엇인지 구분되지 않는다 (실제로 화면에서
 * `mcp__connector__mcp_mcp-atlassi…` 로 잘려 보였다). 원본은 상세에 남긴다.
 */
export function shortToolName(raw: string | undefined): string {
  const name = String(raw ?? '').trim();
  if (!name) return '(이름 없음)';
  return name.replace(/^mcp__connector__/, '').replace(/^mcp_(mcp-)?/, '');
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function phaseOf(e: ToolEvent): { label: string; tone: 'run' | 'ok' | 'err' } {
  if (e.eventType === 'tool_error' || e.error) return { label: '실패', tone: 'err' };
  if (e.eventType === 'tool_result') return { label: '완료', tone: 'ok' };
  return { label: '실행', tone: 'run' };
}

/**
 * 전체 기록을 사람이 읽을 수 있는 텍스트로.
 *
 * JSON 덩어리 하나로 주지 않는다 — 붙여넣는 곳이 이슈든 채팅이든 그대로
 * 읽혀야 하고, 그러려면 섹션이 있어야 한다.
 */
export function formatToolLog(events: ToolEvent[]): string {
  const lines: string[] = [`# 도구 실행 기록 (${events.length}건)`, ''];
  events.forEach((e, i) => {
    lines.push(`## ${i + 1}. ${shortToolName(e.toolName)} — ${phaseOf(e).label}`);
    if (e.toolName && shortToolName(e.toolName) !== e.toolName) {
      lines.push(`- 전체 이름: ${e.toolName}`);
    }
    if (typeof e.durationMs === 'number') lines.push(`- 소요: ${e.durationMs}ms`);
    if (e.timestamp) lines.push(`- 시각: ${e.timestamp}`);
    const input = pretty(e.toolInput);
    if (input) lines.push('', '### 입력', '```json', input, '```');
    if (e.error) lines.push('', '### 오류', '```', String(e.error), '```');
    const result = pretty(e.result);
    if (result) lines.push('', '### 결과', '```', result, '```');
    lines.push('');
  });
  return lines.join('\n');
}

export const ToolLogModal: React.FC<Props> = ({ events, onClose }) => {
  const [copied, setCopied] = useState('');
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [copyError, setCopyError] = useState('');

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
              const { label, tone } = phaseOf(e);
              const isOpen = open.has(i);
              const input = pretty(e.toolInput);
              const result = pretty(e.result);
              return (
                <div className={`toollog-item ${tone}`} key={i}>
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
