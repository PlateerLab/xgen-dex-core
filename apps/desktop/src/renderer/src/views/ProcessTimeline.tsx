/**
 * 작업 과정 타임라인 — 답변이 도는 동안 "무엇을 하려는지(진행 문장)"와 "실제로 한 일(도구 호출)"을
 * 도착한 순서 그대로 쌓아 보여준다.
 *
 * 칩 한 칸(ToolActivity)만으로는 긴 실행에서 화면이 멈춘 것처럼 보였다 — 9/15 위해상품 점검 227초 중
 * 188초 동안 화면에 새로 보이는 것이 없었다(모델이 긴 스크립트를 쓰는 시간 + Bash 대기). 서버는 이미
 * 도구마다 입력·결과·소요 시간을 보내 주므로 서버 변경 없이 이 화면만으로 채운다.
 *
 * - 진행 문장(도구 사이 텍스트의 첫 문단)이 단계 제목, 그 아래에 그 단계에서 부른 도구 카드
 * - 실행 중인 도구와 "다음 단계를 준비하는" 공백에 경과 초를 계속 보여 준다
 * - 마지막 단계 뒤의 본문(표·권고 등)은 평소 답변처럼 마크다운으로 그린다
 * - 스트림으로 받은 턴만 순서(flow)를 안다. 이력에서 복원한 턴은 flow 가 없어 기존 화면으로 그린다
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ToolEvent } from '@dex/protocol';
import { shortToolName, toolCallId, toolPhase, toolValueText, type ToolPhase } from '@dex/protocol/tool-activity';
import type { ChatMsg, FlowItem } from '../session-store';
import { Markdown } from './Markdown';

/** 이벤트가 이 시간 넘게 없으면 "다음 단계를 준비하고 있어요" 줄을 띄운다. */
const IDLE_HINT_MS = 2500;

interface Row {
  key: string;
  name: string;
  input: unknown;
  result?: string;
  error?: string;
  phase: ToolPhase;
  durationMs?: number;
  startedAt: number;
  events: ToolEvent[];
}

interface Step {
  text: string;
  rows: Row[];
}

/** flow → 단계들. 텍스트는 도구가 한 번이라도 끼어든 뒤에 오면 새 단계를 연다. */
export function buildSteps(flow: readonly FlowItem[]): Step[] {
  const steps: Step[] = [];
  const byId = new Map<string, Row>();
  const rows: Row[] = [];
  let cur: Step | null = null;
  let toolSinceText = true;
  for (const item of flow) {
    if (item.kind === 'text') {
      if (!cur || toolSinceText) {
        cur = { text: '', rows: [] };
        steps.push(cur);
        toolSinceText = false;
      }
      cur.text += item.text;
      continue;
    }
    const e = item.event;
    if (!cur) {
      cur = { text: '', rows: [] };
      steps.push(cur);
    }
    toolSinceText = true;
    const id = toolCallId(e);
    const name = typeof e.toolName === 'string' ? e.toolName : '';
    const tone = toolPhase(e).tone;
    let row = id !== undefined ? byId.get(id) : undefined;
    if (!row && (tone !== 'run' || e.eventType === 'tool_start')) {
      row = rows.find((r) => r.phase === 'run' && r.name === name);
    }
    if (!row) {
      row = { key: id ?? `#${rows.length + 1}`, name, input: undefined, phase: 'run', startedAt: item.at, events: [] };
      rows.push(row);
      cur.rows.push(row);
      if (id !== undefined) byId.set(id, row);
    }
    row.events.push(e);
    if (row.input === undefined && e.toolInput !== undefined) row.input = e.toolInput;
    if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) row.durationMs = e.durationMs;
    if (e.result !== undefined) row.result = String(e.result);
    if (e.error) row.error = String(e.error);
    if (tone !== 'run' && row.phase !== 'err') row.phase = tone;
  }
  return steps;
}

const splitFirstParagraph = (text: string): { title: string; body: string } => {
  const s = text.replace(/^\s+/, '');
  const at = s.indexOf('\n\n');
  return at < 0 ? { title: s.trim(), body: '' } : { title: s.slice(0, at).trim(), body: s.slice(at + 2) };
};

const fmtSec = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const fmtDuration = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;

function parseInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const v = JSON.parse(input);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

type IconKind = 'terminal' | 'package' | 'search' | 'file' | 'api' | 'web' | 'edit' | 'tool';

/** 카드 한 줄 요약 — 도구 입력에서 사람이 읽을 이름을 만든다. 모르는 도구는 이름 + 대표 인자. */
export function describeTool(name: string, rawInput: unknown): { icon: IconKind; text: string } {
  const input = parseInput(rawInput);
  const short = shortToolName(name);
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (short) {
    case 'Bash': {
      const cmd = str('command');
      const lines = cmd.split('\n').length;
      let what = '명령 실행';
      if (/openpyxl|xlsxwriter/.test(cmd)) what = '엑셀·결과 파일 생성';
      else if (/searchMain\.lotte/.test(cmd))
        what = /viewGoodsDetail/.test(cmd) ? '롯데아이몰 검색 API + 상세 페이지 일괄 조회' : '롯데아이몰 검색 API 일괄 호출';
      else if (/viewGoodsDetail/.test(cmd)) what = '상세 페이지 확인';
      else if (/pdfplumber|PyPDF|pypdf/.test(cmd)) what = 'PDF 텍스트 추출';
      else if (lines === 1) what = cmd.slice(0, 80);
      return { icon: 'terminal', text: lines > 1 ? `${what} · 스크립트 ${lines}줄` : what };
    }
    case 'PythonEnv': {
      const pkgs = Array.isArray(input.packages) ? (input.packages as unknown[]).join(', ') : '';
      return { icon: 'package', text: `파이썬 패키지 준비${pkgs ? ` · ${pkgs}` : ''}` };
    }
    case 'Glob':
      return { icon: 'search', text: `파일 찾기 · ${str('pattern')}` };
    case 'Grep':
      return { icon: 'search', text: `내용 찾기 · ${str('pattern')}` };
    case 'ToolSearch':
      return { icon: 'search', text: `사용할 도구 찾기 · ${str('query')}` };
    case 'Read':
      return { icon: 'file', text: `파일 읽기 · ${str('file_path').split('/workspace/').pop()}` };
    case 'Write':
    case 'Edit':
      return { icon: 'edit', text: `파일 ${short === 'Write' ? '쓰기' : '수정'} · ${str('file_path').split('/workspace/').pop()}` };
    case 'WebFetch':
    case 'WebSearch':
      return { icon: 'web', text: `${short === 'WebFetch' ? '웹 페이지 열기' : '웹 검색'} · ${str('url') || str('query')}` };
    case 'check_goods':
      return { icon: 'api', text: `롯데홈쇼핑 상품검색 API · 상품번호 ${str('goods_no')} 판매 확인` };
    case 'search_products':
      return { icon: 'api', text: `롯데홈쇼핑 상품검색 API · "${str('keyword')}"` };
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string' || typeof v === 'number');
      return { icon: 'tool', text: first !== undefined ? `${short} · ${String(first).slice(0, 80)}` : short };
    }
  }
}

function resultPreview(row: Row): string {
  const r = row.error ?? row.result ?? '';
  const short = shortToolName(row.name);
  if (short === 'PythonEnv') {
    try {
      const n = (JSON.parse(r).packages ?? []).length;
      return `설치 확인 · 패키지 ${n}개`;
    } catch {
      return '설치 확인';
    }
  }
  if (short === 'Read') return `${r.split('\n').length}줄 읽음`;
  return (r.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, 160);
}

interface Goods {
  goods_no?: string;
  name?: string;
  brand?: string;
  price?: string;
  sold_out?: boolean;
}

/** 상품검색 API 결과 → 상품 카드 데이터. JSON 이 아니면 카드를 그리지 않는다. */
function goodsFromResult(row: Row): { listed: boolean; goodsNo?: string; product?: Goods } | null {
  const short = shortToolName(row.name);
  if (short !== 'check_goods' || !row.result) return null;
  try {
    const v = JSON.parse(row.result);
    return { listed: !!v.listed, goodsNo: v.goods_no, product: v.product ?? undefined };
  } catch {
    return null;
  }
}

const ICON_PATHS: Record<IconKind, React.ReactNode> = {
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
  api: (
    <>
      <path d="M1.5 2.5h2l1.6 7.5h7l1.6-5.5H4.3" />
      <circle cx="6" cy="13" r="1" />
      <circle cx="11.5" cy="13" r="1" />
    </>
  ),
  tool: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4" />
    </>
  ),
};

const Icon: React.FC<{ kind: IconKind }> = ({ kind }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    {ICON_PATHS[kind]}
  </svg>
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

const ToolCard: React.FC<{ row: Row; now: number; open: boolean; onToggle: () => void }> = ({ row, now, open, onToggle }) => {
  const d = describeTool(row.name, row.input);
  const goods = goodsFromResult(row);
  const status =
    row.phase === 'run' ? (
      <>
        <span className="ptl-spin" />
        실행 중 · {fmtSec(now - row.startedAt)}
      </>
    ) : row.phase === 'err' ? (
      <>실패{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : ''}</>
    ) : (
      <>완료{row.durationMs !== undefined ? ` · ${fmtDuration(row.durationMs)}` : ''}</>
    );
  return (
    <div className={`ptl-tool ${row.phase}${d.icon === 'api' ? ' api' : ''}`}>
      <button type="button" className="ptl-tool-head" onClick={onToggle} title="눌러서 입력과 결과 보기">
        <span className="ptl-caret">{open ? '▾' : '▸'}</span>
        <span className="ptl-ico">
          <Icon kind={d.icon} />
        </span>
        <span className="ptl-sum">{d.text}</span>
        <span className="ptl-name">{shortToolName(row.name)}</span>
        <span className="ptl-stat">{status}</span>
      </button>
      {goods &&
        (goods.listed && goods.product ? (
          <div className="ptl-goods">
            <div className="ptl-goods-name">{goods.product.name}</div>
            <div className="ptl-goods-meta">
              {goods.product.brand} · {goods.product.price}원 · 상품번호 {goods.product.goods_no}
            </div>
            <span className={`ptl-goods-badge${goods.product.sold_out ? ' off' : ''}`}>
              {goods.product.sold_out ? '품절' : '판매 중'}
            </span>
          </div>
        ) : (
          <div className="ptl-goods">
            <div className="ptl-goods-name">상품번호 {goods.goodsNo} — 판매 목록에 없음</div>
            <span className="ptl-goods-badge off">없음</span>
          </div>
        ))}
      {row.phase !== 'run' && !goods && <div className="ptl-preview">↳ {resultPreview(row)}</div>}
      {open && (
        <div className="ptl-detail">
          <label>입력</label>
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

export const ProcessTimeline: React.FC<{ msg: ChatMsg }> = ({ msg }) => {
  const streaming = !!msg.streaming;
  const now = useNow(streaming);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const steps = useMemo(() => buildSteps(msg.flow ?? []), [msg.flow]);

  const allRows = steps.flatMap((s) => s.rows);
  const running = allRows.find((r) => r.phase === 'run');
  const startedAt = msg.startedAt ?? msg.flow?.[0]?.at ?? now;
  const lastAt = msg.lastEventAt ?? startedAt;

  // 마지막 단계에 도구가 없으면 그 뒤 본문은 최종 답이다.
  let answer = '';
  const rendered = steps.map((step, i) => {
    const last = i === steps.length - 1;
    let { title, body } = splitFirstParagraph(step.text);
    if (last && step.rows.length === 0) {
      if (body) {
        answer = body;
      } else if (!streaming) {
        answer = title;
        title = '';
      }
    } else if (body) {
      title = `${title} ${body.replace(/\s+/g, ' ').trim()}`;
    }
    const typing = last && streaming && step.rows.length === 0 && !answer;
    const phase = step.rows.some((r) => r.phase === 'run') || typing ? 'run' : step.rows.some((r) => r.phase === 'err') ? 'err' : 'ok';
    if (!title && step.rows.length === 0) return null;
    return (
      <div key={i} className={`ptl-step ${phase}`}>
        <span className="ptl-node" />
        {title && (
          <div className="ptl-title">
            {title}
            {typing && <span className="cursor" />}
          </div>
        )}
        {step.rows.map((row) => (
          <ToolCard
            key={row.key}
            row={row}
            now={now}
            open={open.has(row.key)}
            onToggle={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(row.key)) next.delete(row.key);
                else next.add(row.key);
                return next;
              })
            }
          />
        ))}
      </div>
    );
  });

  const idle = streaming && !running && !answer && now - lastAt >= IDLE_HINT_MS;
  return (
    <div className="ptl">
      <div className={`ptl-head${streaming ? '' : ' done'}`}>
        <span className="ptl-pulse" />
        <b>{streaming ? '작업 중' : '완료'}</b>
        <span>· {fmtSec((streaming ? now : lastAt) - startedAt)}</span>
        <span className="ptl-head-meta">
          도구 {allRows.length}회{running ? ` · ${shortToolName(running.name)} 실행 중` : ''}
        </span>
      </div>
      <div className="ptl-steps">
        {rendered}
        {idle && (
          <div className="ptl-step wait">
            <span className="ptl-node" />
            <div className="ptl-title">다음 단계를 준비하고 있어요 · {fmtSec(now - lastAt)}</div>
          </div>
        )}
      </div>
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
export function useProcessView(): [boolean, () => void] {
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
  const toggle = useCallback(() => {
    const next = !readProcessView();
    try {
      window.localStorage.setItem(PROCESS_VIEW_KEY, next ? 'on' : 'off');
    } catch {
      // 기억만 못 할 뿐 화면은 바뀐다
    }
    setOn(next);
    window.dispatchEvent(new Event(PROCESS_VIEW_EVENT));
  }, []);
  return [on, toggle];
}
