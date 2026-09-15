/**
 * 작업 과정 타임라인 — 답변이 도는 동안 "무엇을 하려는지(진행 문장)"와 "실제로 한 일(도구 호출)"을
 * 도착한 순서 그대로 쌓아 보여준다.
 *
 * 칩 한 칸(ToolActivity)만으로는 긴 실행에서 화면이 멈춘 것처럼 보였다 — 9/15 실측 227초 실행 중 188초
 * 동안 화면에 새로 보이는 것이 없었다(모델이 긴 스크립트를 쓰는 시간 + 셸 대기). 서버는 이미 도구마다
 * 입력·결과·소요 시간을 보내 주므로 서버 변경 없이 이 화면만으로 채운다.
 *
 * - 실행 중에는 펼쳐서 단계(번호)와 도구(종류별 색 배지)를 실시간으로, 끝나면 한 줄 요약으로 접는다
 * - 짧게 끝나는 도구는 실행 중 표시를 건너뛴다(번쩍였다 사라지면 고장처럼 보인다 — 9/16 사용자 지적)
 * - 무엇을 어떻게 부를지·그릴지는 전부 process-timeline-model 의 범용 규칙이다(도구 이름으로 특수 처리하지 않음)
 * - 스트림으로 받은 턴만 순서(flow)를 안다. 이력에서 복원한 턴은 flow 가 없어 기존 화면으로 그린다
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { shortToolName, toolValueText } from '@dex/protocol/tool-activity';
import type { ChatMsg } from '../session-store';
import { Markdown } from './Markdown';
import {
  buildSteps,
  describeTool,
  resultView,
  splitFirstParagraph,
  trimAnswer,
  type ResultView,
  type TimelineRow,
  type ToolIcon,
} from './process-timeline-model';

/** 이벤트가 이 시간 넘게 없으면 "다음 단계를 준비하고 있어요" 줄을 띄운다. */
const IDLE_HINT_MS = 2500;
/** 도구가 이만큼 넘게 돌 때만 "실행 중" 으로 보여 준다 — 0.1~0.3초 도구가 번쩍이지 않게. */
const RUNNING_VISIBLE_MS = 700;
/** 이보다 오래 걸린 도구는 소요 시간을 눈에 띄게. */
const SLOW_TOOL_MS = 10_000;

const visiblyRunning = (row: TimelineRow, now: number): boolean =>
  row.phase === 'run' && now - row.startedAt >= RUNNING_VISIBLE_MS;

const fmtSec = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const fmtDuration = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;

const ICON_PATHS: Record<ToolIcon, React.ReactNode> = {
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M4.5 6l2.2 2-2.2 2M8.5 10.5h3" />
    </>
  ),
  package: (
    <>
      <path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z" />
      <path d="M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.4 10.4l3.6 3.6" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.8h5l3.2 3.2v9.2H4z" />
      <path d="M9 1.8V5h3.2" />
    </>
  ),
  edit: (
    <>
      <path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z" />
      <path d="M9.5 4l2.5 2.5" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </>
  ),
  list: (
    <>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M2 4l1 1 1.5-2M2 8l1 1 1.5-2M2.2 12h1.6" />
    </>
  ),
  external: (
    <>
      <path d="M6 1.8v3M10 1.8v3" />
      <path d="M4 4.8h8v2.7a4 4 0 0 1-8 0z" />
      <path d="M8 11.5v2.7" />
    </>
  ),
};

const Svg: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const Icon: React.FC<{ kind: ToolIcon }> = ({ kind }) => <Svg>{ICON_PATHS[kind]}</Svg>;
const Check: React.FC = () => (
  <Svg>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);

/** 스트리밍 중에만 1초마다 다시 그려 경과 초를 올린다. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** 도구 결과 — JSON 모양대로(카드·표·키값), 아니면 첫 줄. */
const ResultBlock: React.FC<{ view: ResultView }> = ({ view }) => {
  if (view.line !== undefined && !view.title && !view.table) {
    return <div className="ptl-preview">{view.line}</div>;
  }
  return (
    <div className={`ptl-result${view.title ? ' entity' : ''}`}>
      {view.title && <div className="ptl-result-title">{view.title}</div>}
      {(view.fields.length > 0 || view.flags.length > 0) && (
        <div className="ptl-result-meta">
          {view.fields.map(([k, v]) => (
            <span key={`f-${k}`} className="ptl-field">
              <em>{k}</em> {v}
            </span>
          ))}
          {view.flags.map(([k, on]) => (
            <span key={`b-${k}`} className={`ptl-flag ${on ? 'on' : 'off'}`}>
              {k} {on ? '✓' : '✗'}
            </span>
          ))}
        </div>
      )}
      {view.table && (
        <div className="ptl-table-wrap">
          <table className="ptl-table">
            <thead>
              <tr>
                {view.table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {view.table.more > 0 && <div className="ptl-table-more">외 {view.table.more}건</div>}
        </div>
      )}
    </div>
  );
};

const ToolRow: React.FC<{
  row: TimelineRow;
  now: number;
  open: boolean;
  onToggle: () => void;
  description?: string;
}> = ({ row, now, open, onToggle, description }) => {
  const d = describeTool(row.name, row.input, description);
  const external = d.icon === 'external';
  const view = row.phase === 'run' ? null : resultView(row.error ?? row.result);
  // 기본 도구가 돌려준 키·값뿐인 JSON(환경 id 같은 것)은 잡음이다 — 표·카드·글 첫 줄만 보인다.
  const shown = view && (external || view.line !== undefined || view.title || view.table) ? view : null;
  const showRunning = visiblyRunning(row, now);
  const state = row.phase === 'run' ? (showRunning ? 'run' : 'pending') : row.phase;
  const dur = row.durationMs;
  const status =
    row.phase === 'run' ? (
      showRunning ? (
        <span className="ptl-live">
          <span className="ptl-spin" />
          {fmtSec(now - row.startedAt)}
        </span>
      ) : null
    ) : row.phase === 'err' ? (
      <span className="ptl-dur err">실패{dur !== undefined ? ` · ${fmtDuration(dur)}` : ''}</span>
    ) : dur !== undefined ? (
      <span className={`ptl-dur${dur >= SLOW_TOOL_MS ? ' slow' : ''}`}>{fmtDuration(dur)}</span>
    ) : null;
  return (
    <div className={`ptl-tool ${state} ptl-kind-${d.icon}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="ptl-tool-head"
        onClick={onToggle}
        title={`${shortToolName(row.name)} — 눌러서 입력과 결과 보기`}
        aria-expanded={open}
      >
        <span className="ptl-ico">
          <Icon kind={d.icon} />
        </span>
        <span className="ptl-sum">{d.text}</span>
        {status}
      </button>
      {shown && <ResultBlock view={shown} />}
      {open && (
        <div className="ptl-detail">
          <label>{shortToolName(row.name)} 입력</label>
          <pre>{toolValueText(row.input)}</pre>
          {(row.error ?? row.result) !== undefined && (
            <>
              <label>{row.error ? '오류' : '결과'}</label>
              <pre>{row.error ?? row.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const ProcessTimeline: React.FC<{
  msg: ChatMsg;
  /** 에이전트에 등록된 도구 설명(도구 이름 → 설명). 있으면 도구 행 이름표에 쓴다. */
  toolDescriptions?: Readonly<Record<string, string>>;
}> = ({ msg, toolDescriptions }) => {
  const streaming = !!msg.streaming;
  const now = useNow(streaming);
  // 펼침: 사용자가 누르기 전에는 실행 중이면 펼치고, 끝나면 접는다.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const expanded = manualOpen ?? streaming;
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  const steps = useMemo(() => buildSteps(msg.flow ?? []), [msg.flow]);

  const allRows = steps.flatMap((s) => s.rows);
  const running = allRows.find((r) => visiblyRunning(r, now));
  const anyRunning = allRows.some((r) => r.phase === 'run');
  const failed = allRows.filter((r) => r.phase === 'err').length;
  const startedAt = msg.startedAt ?? msg.flow?.[0]?.at ?? now;
  const lastAt = msg.lastEventAt ?? startedAt;
  const describe = (name: string) => toolDescriptions?.[name] ?? toolDescriptions?.[shortToolName(name)];

  // 마지막 단계에 도구가 없으면 그 뒤 본문은 최종 답이다.
  let answer = '';
  let stepNo = 0;
  const visibleSteps = steps.length;
  const rendered = steps.map((step, i) => {
    const last = i === visibleSteps - 1;
    let { title, body } = splitFirstParagraph(step.text);
    if (last && step.rows.length === 0) {
      if (body) {
        answer = trimAnswer(body);
      } else if (!streaming) {
        answer = trimAnswer(title);
        title = '';
      }
    } else if (body) {
      title = `${title} ${body.replace(/\s+/g, ' ').trim()}`;
    }
    if (!title && step.rows.length === 0) return null;
    stepNo += 1;
    const typing = last && streaming && step.rows.length === 0 && !answer;
    const phase =
      step.rows.some((r) => visiblyRunning(r, now)) || typing
        ? 'run'
        : step.rows.some((r) => r.phase === 'err')
          ? 'err'
          : step.rows.some((r) => r.phase === 'run')
            ? 'pending'
            : 'ok';
    const current = streaming && last;
    return (
      <div key={i} className={`ptl-step ${phase}${current ? ' current' : ''}`}>
        <span className="ptl-node">{phase === 'ok' ? <Check /> : phase === 'err' ? '!' : stepNo}</span>
        {title && (
          <div className="ptl-title">
            {title}
            {typing && <span className="cursor" />}
          </div>
        )}
        {step.rows.length > 0 && (
          <div className="ptl-tools">
            {step.rows.map((row) => (
              <ToolRow
                key={row.key}
                row={row}
                now={now}
                description={describe(row.name)}
                open={openRows.has(row.key)}
                onToggle={() =>
                  setOpenRows((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.key)) next.delete(row.key);
                    else next.add(row.key);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
    );
  });

  const idle = streaming && !anyRunning && !answer && now - lastAt >= IDLE_HINT_MS;
  const summary = streaming
    ? `${fmtSec(now - startedAt)} · 도구 ${allRows.length}회${running ? ` · ${shortToolName(running.name)} 실행 중` : ''}`
    : `${stepNo}단계 · 도구 ${allRows.length}회${failed ? ` · 실패 ${failed}` : ''} · ${fmtSec(lastAt - startedAt)}`;

  return (
    <div className={`ptl${expanded ? ' expanded' : ' collapsed'}${streaming ? ' live' : ' done'}`}>
      <div className="ptl-head">
        <button type="button" className="ptl-head-toggle" onClick={() => setManualOpen(!expanded)} aria-expanded={expanded}>
          <span className="ptl-pulse">{!streaming && <Check />}</span>
          <span className="ptl-head-label">{streaming ? '작업 중' : '작업 과정'}</span>
          <span className="ptl-head-sub">{summary}</span>
          <span className="ptl-chevron" aria-hidden>
            {expanded ? '▾' : '▸'}
          </span>
        </button>
      </div>
      {streaming && <div className="ptl-progress" aria-hidden />}
      {expanded && (
        <div className="ptl-steps">
          {rendered}
          {idle && (
            <div className="ptl-step wait">
              <span className="ptl-node">
                <span className="ptl-dots">
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <div className="ptl-title">
                <span className="ptl-shimmer">다음 단계를 준비하고 있어요</span>
                <span className="ptl-wait-sec">{fmtSec(now - lastAt)}</span>
              </div>
            </div>
          )}
        </div>
      )}
      {answer && (
        <div className="ptl-answer">
          <Markdown text={answer} />
          {streaming && <span className="cursor" />}
        </div>
      )}
    </div>
  );
};

/** 이 메시지를 타임라인으로 그릴 수 있는가 — 스트림 순서를 알고, 도구를 한 번이라도 불렀을 때. */
export const hasProcessFlow = (m: ChatMsg): boolean =>
  m.role === 'assistant' && !!m.flow && m.flow.some((item) => item.kind === 'tool');

const PROCESS_VIEW_KEY = 'dex.chat.processTimeline';
const PROCESS_VIEW_EVENT = 'dex-process-view';

const readProcessView = (): boolean => {
  try {
    return window.localStorage.getItem(PROCESS_VIEW_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * 타임라인 켜기/끄기 — 이 PC 에만 기억한다(기본 켜짐). 끄면 예전처럼 도구 칩 한 칸으로 돌아간다.
 * 여러 채팅 탭이 같은 값을 보도록 창 이벤트로 알린다.
 */
export function useProcessView(): [boolean, () => void, (next: boolean) => void] {
  const [on, setOn] = useState(readProcessView);
  useEffect(() => {
    const sync = () => setOn(readProcessView());
    window.addEventListener(PROCESS_VIEW_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PROCESS_VIEW_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(PROCESS_VIEW_KEY, next ? 'on' : 'off');
    } catch {
      // 기억만 못 할 뿐 화면은 바뀐다
    }
    setOn(next);
    window.dispatchEvent(new Event(PROCESS_VIEW_EVENT));
  }, []);
  const toggle = useCallback(() => set(!readProcessView()), [set]);
  return [on, toggle, set];
}
