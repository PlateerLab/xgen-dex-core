/**
 * AgentViewer — 한 에이전트(workflow)의 **읽기 전용** 관측 뷰어.
 *
 * 채팅 헤더의 [...] 메뉴에서 새 탭으로 열린다. 여섯 하위 탭(기본정보/메모리/작업/
 * 도구/스토리지/전체로그)을 두고, 각 하위 뷰는 `window.xgen.agentData.*`(전부 GET)로
 * 서버 데이터를 읽어 상세 뷰처럼 보여 준다. 생성/삭제/변경은 없다.
 *
 * [기본정보] 는 **커넥터 표면만** 보여 준다 — 이 앱에서 도는 턴이 그 표면이기
 * 때문이다. 웹 화면은 반대로 web 표면만 보여 준다. 한 화면에서 둘을 토글하던
 * 예전 방식은 지금 보고 있는 게 어느 실행의 것인지 매번 확인해야 했다.
 *
 * 시각 언어는 커넥터 기존 것을 따른다(ToolLogModal 의 배지·펼침 행, --panel/
 * --border/--text-dim 토큰, --font-mono 코드 블록).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { xgen, copyText } from '../bridge';
import { BotIcon, CopyIcon, FolderIcon, FolderOpenIcon, DocIcon } from '../brand/icons';
import type { AgentViewerSub } from './workspace-layout';
import type {
  Span,
  Trace,
  MemoryFile,
  MemoryDetail,
  Task,
  Job,
  JobRun,
  ForgedTool,
  WsNode,
} from '@dex/protocol';

interface Props {
  workflowId: string;
  workflowName?: string;
  initialSub?: AgentViewerSub;
  /** 닫기 — 지금은 탭 X 가 담당하므로 미사용(호환용 optional). */
  onClose?: () => void;
}

const SUBS: [AgentViewerSub, string][] = [
  ['basic', '기본정보'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['storage', '스토리지'],
  ['fulllog', '전체로그'],
];

/** 임의 값 → 사람이 읽는 문자열(문자열은 그대로, 그 외엔 예쁜 JSON). */
function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function fmtWhen(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

/** 로딩/오류/빈 상태를 한 곳에서 다루는 작은 데이터 훅. */
function useLoader<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

const StateNote: React.FC<{ loading: boolean; error: string | null; empty?: boolean; emptyText?: string }> = ({
  loading,
  error,
  empty,
  emptyText,
}) => {
  if (loading) return <div className="viewer-note">불러오는 중…</div>;
  if (error) return <div className="viewer-note err">불러오지 못했습니다: {error}</div>;
  if (empty) return <div className="viewer-note">{emptyText ?? '내용이 없습니다.'}</div>;
  return null;
};

// ─────────────────────────────────────────────────────────────
// 전체로그 (fulllog)
// ─────────────────────────────────────────────────────────────
type Level = 'all' | 'tool' | 'llm' | 'rag' | 'error';
const LEVELS: [Level, string][] = [
  ['all', '전체'],
  ['tool', '도구'],
  ['llm', 'LLM'],
  ['rag', 'RAG'],
  ['error', '오류'],
];

/** span_type → 배지 톤(색). */
function spanTone(t: string): string {
  if (t === 'tool_call' || t === 'tool_output') return 'blue';
  if (t === 'error') return 'red';
  if (t === 'warning') return 'amber';
  if (t === 'llm_call') return 'slate';
  if (t === 'rag_search') return 'emerald';
  if (t === 'agent_input' || t === 'agent_output') return 'violet';
  return 'gray';
}

function spanInLevel(s: Span, level: Level): boolean {
  if (level === 'all') return true;
  const t = s.span_type;
  if (level === 'tool') return t === 'tool_call' || t === 'tool_output';
  if (level === 'llm') return t === 'llm_call';
  if (level === 'rag') return t === 'rag_search';
  if (level === 'error') return t === 'error' || t === 'warning' || !!s.error_message;
  return true;
}

/** duration_ms → 사람이 읽는 짧은 표기(1000ms 이상은 초 단위, 소수 둘째 자리). */
function fmtDuration(ms?: number): string {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// 인자/결과/메타가 길면 펼침 행 하나가 화면 전체를 삼킨다 — 접었다가
// [더보기]로 편다. 서버가 도구 결과를 통째로 pretty-print 해서 내려주므로
// (예: 큰 파일 읽기, RAG 검색 hits) 이 캡이 없으면 스크롤이 실질적으로
// 못 쓰는 길이가 되는 사례가 실제로 있었다.
const TEXT_LIMIT = 800;

const ExpandableText: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const [open, setOpen] = useState(false);
  const long = text.length > TEXT_LIMIT;
  const shown = open || !long ? text : text.slice(0, TEXT_LIMIT) + '…';
  return (
    <div>
      <pre className={`viewer-body${className ? ` ${className}` : ''}`}>{shown}</pre>
      {long && (
        <button className="viewer-btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? '접기' : `더보기 (${text.length.toLocaleString()}자)`}
        </button>
      )}
    </div>
  );
};

const SpanRow: React.FC<{ span: Span; idx: number }> = ({ span, idx }) => {
  const [open, setOpen] = useState(false);
  const input = pretty(span.input_data);
  const output = pretty(span.output_data);
  // 서버는 metadata 를 JSON **문자열**로 내려준다(컬럼이 text) — 한 번 파싱해
  // 보고, 아니면 원문 그대로 보여 준다.
  const meta = useMemo(() => {
    const raw = span.metadata;
    if (raw === undefined || raw === null || raw === '') return '';
    if (typeof raw === 'string') {
      try {
        return pretty(JSON.parse(raw));
      } catch {
        return raw;
      }
    }
    return pretty(raw);
  }, [span.metadata]);
  const hasDetail = !!(input || output || meta || span.error_message);
  return (
    <div className={`viewer-span ${span.error_message ? 'err' : ''}`}>
      <button className="viewer-span-row" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className="viewer-idx">{idx + 1}</span>
        <span className={`viewer-badge ${spanTone(span.span_type)}`}>{span.span_type}</span>
        {span.tool_name && (
          <span className="viewer-span-name" title={span.tool_name}>
            {span.tool_name}
          </span>
        )}
        <span className="viewer-spacer" />
        {typeof span.duration_ms === 'number' && (
          <span className="viewer-ms">{fmtDuration(span.duration_ms)}</span>
        )}
        {hasDetail && <span className="viewer-caret">{open ? '−' : '+'}</span>}
      </button>
      {open && hasDetail && (
        <div className="viewer-span-detail">
          {span.error_message && (
            <>
              <div className="viewer-label err">오류</div>
              <ExpandableText className="err" text={span.error_message} />
            </>
          )}
          {input && (
            <>
              <div className="viewer-label">입력 (args)</div>
              <ExpandableText text={input} />
            </>
          )}
          {output && (
            <>
              <div className="viewer-label">출력 (result)</div>
              <ExpandableText text={output} />
            </>
          )}
          {meta && (
            <>
              <div className="viewer-label">부가 정보</div>
              <ExpandableText text={meta} />
            </>
          )}
        </div>
      )}
    </div>
  );
};

/** trace.status → 배지 톤. completed=초록, failed/error=빨강, running=노랑, 그 외=회색. */
function statusTone(status?: string): string {
  if (status === 'error' || status === 'failed') return 'red';
  if (status === 'running') return 'amber';
  if (status === 'completed') return 'emerald';
  return 'gray';
}

const TraceCard: React.FC<{ trace: Trace; spans: Span[]; level: Level }> = ({
  trace,
  spans,
  level,
}) => {
  const [open, setOpen] = useState(true);
  const ordered = useMemo(
    () => [...spans].sort((a, b) => (a.span_order ?? 0) - (b.span_order ?? 0)),
    [spans],
  );
  const shown = ordered.filter((s) => spanInLevel(s, level));
  return (
    <div className={`viewer-trace ${trace.error_message ? 'err' : ''}`}>
      <button className="viewer-trace-head" onClick={() => setOpen((o) => !o)}>
        <span className={`viewer-badge ${statusTone(trace.status)}`}>{trace.status || '—'}</span>
        <span className="viewer-trace-model">{trace.model_name || trace.provider || '실행'}</span>
        <span className="viewer-trace-meta">
          {typeof trace.total_tool_calls === 'number' ? `도구 ${trace.total_tool_calls}` : ''}
          {typeof trace.total_llm_calls === 'number' ? ` · LLM ${trace.total_llm_calls}` : ''}
          {typeof trace.duration_ms === 'number' ? ` · ${fmtDuration(trace.duration_ms)}` : ''}
        </span>
        <span className="viewer-spacer" />
        <span className="viewer-when">{fmtWhen(trace.created_at)}</span>
        <span className="viewer-caret">{open ? '−' : '+'}</span>
      </button>
      {trace.error_message && <div className="viewer-trace-err">{trace.error_message}</div>}
      {open && (
        <div className="viewer-span-list">
          {shown.length === 0 ? (
            <div className="viewer-note sm">이 필터에 해당하는 단계가 없습니다.</div>
          ) : (
            shown.map((s, i) => <SpanRow key={i} span={s} idx={i} />)
          )}
        </div>
      )}
    </div>
  );
};

const FullLogView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const [level, setLevel] = useState<Level>('all');
  const loader = useLoader(async () => {
    const list = await xgen.agentData.traceList(workflowId);
    const traces = list.traces ?? [];
    const details = await Promise.all(
      traces.map((t) =>
        xgen.agentData.traceDetail(t.trace_id).catch(() => ({ trace: t, spans: [] as Span[] })),
      ),
    );
    return details.map((d, i) => ({ trace: d.trace ?? traces[i], spans: d.spans ?? [] }));
  }, [workflowId]);

  // 필터 칩 옆 개수 — 지금 이 실행 목록에 무엇이 얼마나 있는지 누르기 전에
  // 미리 보인다. 전체 스팬 대비 계산이라 트레이스가 아주 많지 않은 한 가볍다.
  const levelCounts = useMemo(() => {
    const counts: Record<Level, number> = { all: 0, tool: 0, llm: 0, rag: 0, error: 0 };
    for (const d of loader.data ?? []) {
      for (const s of d.spans) {
        counts.all += 1;
        for (const [lv] of LEVELS) {
          if (lv !== 'all' && spanInLevel(s, lv)) counts[lv] += 1;
        }
      }
    }
    return counts;
  }, [loader.data]);

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {LEVELS.map(([lv, label]) => (
            <button
              key={lv}
              className={`viewer-chip ${level === lv ? 'active' : ''}`}
              onClick={() => setLevel(lv)}
            >
              {label}
              {levelCounts[lv] > 0 && <span className="viewer-chip-count">{levelCounts[lv]}</span>}
            </button>
          ))}
        </div>
        <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
          새로고침
        </button>
      </div>
      <div className="viewer-scroll">
        <StateNote
          loading={loader.loading}
          error={loader.error}
          empty={!!loader.data && loader.data.length === 0}
          emptyText="실행 기록이 아직 없습니다 — 이 에이전트가 한 번이라도 실행되면 도구 호출·LLM 호출·오류를 여기서 실행 단위로 펼쳐 볼 수 있습니다."
        />
        {loader.data?.map((d) => (
          <TraceCard key={d.trace.trace_id} trace={d.trace} spans={d.spans} level={level} />
        ))}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 메모리
//
// 웹 [메모리] 브라우저(Opsidian풍)와 같은 낱말·색을 쓴다 — 카테고리는 제품
// 전체에서 하나의 어휘다. 이 뷰는 읽기 전용(memoryList/memoryRead 만 존재,
// 생성/편집/삭제/그래프/시맨틱 검색용 IPC 는 없다)이라 그 범위 안에서:
// 카테고리 트리 + 태그 필터 + 클라이언트 검색(이미 받아 온 목록 안에서만,
// 서버 왕복 없음) + 마크다운·위키링크·대화 노트 렌더로 개편한다.
// ─────────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  daily: '#f59e0b',
  topics: '#3b82f6',
  projects: '#8b5cf6',
  insights: '#ec4899',
  reference: '#06b6d4',
  critical: '#ef4444',
  conversations: '#10b981',
  executions: '#22c55e',
  compactions: '#94a3b8',
  root: '#64748b',
};
const FIXED_CATEGORIES = [
  'daily', 'topics', 'projects', 'insights', 'conversations', 'compactions', 'root', 'critical', 'executions',
];
function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? '#64748b';
}

/** `[[target|alias]]` / `[[target]]` → `[alias](wikilink://target)` 마크다운 링크. */
function preprocessWikilinks(body: string): string {
  return body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
    const label = (alias || target).trim();
    return `[🔗 ${label}](wikilink://${encodeURIComponent(target.trim())})`;
  });
}

// ── 대화(rollup) 노트 전용 렌더 ────────────────────────────────
// 백엔드 아카이버는 발화마다 `## turn-<id>` + `<!--meta …-->` + 원문을 쓴다.
// 원시 마크다운으로 보여주면 meta 주석이 그대로 노출되므로(웹에서 신고된 것과
// 같은 증상), 파싱해서 화자 라벨 + 시각이 붙은 채팅형 뷰로 렌더한다.
interface ConversationTurn {
  id: string;
  role: string;
  kind: string;
  ts: string;
  text: string;
}

function parseConversationTurns(body: string): ConversationTurn[] | null {
  if (!body.includes('<!--meta')) return null;
  const sections = body.split(/^## turn-/m).slice(1);
  if (sections.length === 0) return null;
  const turns: ConversationTurn[] = [];
  for (const section of sections) {
    const id = (section.match(/^([a-zA-Z0-9]+)/) || [])[1] || '';
    const metaMatch = section.match(/<!--meta\n([\s\S]*?)-->/);
    const meta: Record<string, string> = {};
    if (metaMatch) {
      for (const line of metaMatch[1].split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    let text = section;
    if (metaMatch) text = text.slice(text.indexOf('-->') + 3);
    text = text.replace(/\n---\s*$/m, '').replace(/^---\s*$/gm, '').trim();
    if (!text) continue;
    turns.push({ id, role: meta.role || 'user', kind: meta.kind || '', ts: meta.ts || '', text });
  }
  return turns.length > 0 ? turns : null;
}

/** meta 주석·턴 헤딩을 제거한 일반 마크다운 (턴 파싱 실패 시 폴백). */
function stripArchiveMarkup(body: string): string {
  return body
    .replace(/<!--meta[\s\S]*?-->/g, '')
    .replace(/^## turn-[a-zA-Z0-9]+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

const ConversationBody: React.FC<{ turns: ConversationTurn[] }> = ({ turns }) => (
  <div className="viewer-convo">
    {turns.map((t) => {
      const isUser = t.role === 'user' || t.kind === 'user_chat';
      return (
        <div key={t.id} className={`viewer-convo-turn ${isUser ? 'user' : 'agent'}`}>
          <div className="viewer-convo-bubble">
            <div className="viewer-convo-meta">
              <span className="viewer-convo-role">{isUser ? '사용자' : '에이전트'}</span>
              {t.ts && <span>{fmtWhen(t.ts)}</span>}
            </div>
            <div className="viewer-convo-text">{t.text}</div>
          </div>
        </div>
      );
    })}
  </div>
);

/** 노트 본문 — conversations 카테고리는 채팅형, 그 외는 마크다운(+위키링크). */
const MemoryNoteBody: React.FC<{ detail: MemoryDetail; onNavigate: (target: string) => void }> = ({
  detail,
  onNavigate,
}) => {
  const conversationTurns = useMemo(
    () => (detail.category === 'conversations' ? parseConversationTurns(detail.body || '') : null),
    [detail.category, detail.body],
  );
  const processedBody = useMemo(
    () => preprocessWikilinks(stripArchiveMarkup(detail.body || '')),
    [detail.body],
  );
  if (conversationTurns) return <ConversationBody turns={conversationTurns} />;
  return (
    <div className="viewer-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('wikilink://')) {
              const target = decodeURIComponent(href.slice('wikilink://'.length));
              return (
                <button type="button" className="viewer-wikilink" onClick={() => onNavigate(target)}>
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {processedBody}
      </ReactMarkdown>
    </div>
  );
};

const MemoryView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.memoryList(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const files = list.data?.files ?? [];

  const open = useCallback(
    async (file: MemoryFile) => {
      setSel(file.filename);
      setDetail(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        setDetail(await xgen.agentData.memoryRead(workflowId, file.filename));
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  // 위키링크/역링크 클릭 — 새 IPC 없이, 이미 받아 온 목록에서 퍼지 매칭
  // (웹 MemoryBrowserView.openFile 미러). 파일명/제목/부분 문자열 순으로 시도.
  const navigate = useCallback(
    (target: string) => {
      const match =
        files.find((f) => f.filename === target) ||
        files.find((f) => f.filename.endsWith(`/${target}`) || f.filename === `${target}.md`) ||
        files.find((f) => f.title === target) ||
        files.find((f) => f.filename.toLowerCase().includes(target.toLowerCase()));
      if (match) void open(match);
    },
    [files, open],
  );

  // 태그 카운트(많이 쓰인 순) — 검색창 바로 아래 필터 칩.
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of files) for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [files]);

  // 검색 + 태그 필터 — 전부 클라이언트 사이드다. 목록은 이미 통째로 받아
  // 왔으니(memoryList 가 files[] 전체를 반환) 서버 왕복 없이 걸러진다.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (activeTag && !(f.tags ?? []).includes(activeTag)) return false;
      if (!q) return true;
      return (
        (f.title ?? '').toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.first_paragraph ?? '').toLowerCase().includes(q) ||
        (f.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [files, query, activeTag]);

  // 카테고리 그룹 — 고정 카테고리는 항상(빈 것도) 먼저, 그 외는 알파벳순.
  const grouped = useMemo(() => {
    const byCat = new Map<string, MemoryFile[]>();
    for (const f of filtered) {
      const cat = f.category || 'root';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(f);
    }
    const known = FIXED_CATEGORIES.map((c) => [c, byCat.get(c) ?? []] as [string, MemoryFile[]]);
    const extras = Array.from(byCat.entries())
      .filter(([c]) => !FIXED_CATEGORIES.includes(c))
      .sort((a, b) => a[0].localeCompare(b[0]));
    return [...known, ...extras];
  }, [filtered]);

  const totalChars = useMemo(() => files.reduce((n, f) => n + (f.char_count ?? 0), 0), [files]);

  const toggleCollapse = useCallback((cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <span className="viewer-listitem-sub">
          기억 {files.length}개 · {(totalChars / 1000).toFixed(1)}k자
        </span>
        <button className="viewer-btn" onClick={list.reload} disabled={list.loading}>
          새로고침
        </button>
      </div>
      <div className="viewer-split">
        <div className="viewer-list">
          <input
            className="viewer-search"
            placeholder="기억 검색…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {tagCounts.length > 0 && (
            <div className="viewer-tag-filters">
              {tagCounts.slice(0, 12).map(([t, n]) => (
                <button
                  key={t}
                  className={`viewer-tag-filter ${activeTag === t ? 'active' : ''}`}
                  onClick={() => setActiveTag((cur) => (cur === t ? null : t))}
                >
                  #{t} <span>{n}</span>
                </button>
              ))}
            </div>
          )}
          <StateNote
            loading={list.loading}
            error={list.error}
            empty={!!list.data && files.length === 0}
            emptyText="메모리 노트가 없습니다 — 대화하면 스스로 채워 갑니다."
          />
          {!list.loading && files.length > 0 && filtered.length === 0 && (
            <div className="viewer-note sm">검색/필터에 해당하는 노트가 없습니다.</div>
          )}
          {grouped.map(([cat, items]) => {
            const isEmpty = items.length === 0;
            const isCollapsed = collapsed.has(cat);
            return (
              <div key={cat} className="viewer-memcat">
                <button
                  className={`viewer-memcat-head ${isEmpty ? 'empty' : ''}`}
                  onClick={() => !isEmpty && toggleCollapse(cat)}
                  disabled={isEmpty}
                >
                  {isCollapsed || isEmpty ? (
                    <FolderIcon size={13} className="viewer-memcat-icon" />
                  ) : (
                    <FolderOpenIcon size={13} className="viewer-memcat-icon" />
                  )}
                  <span className="viewer-memcat-dot" style={{ background: categoryColor(cat) }} />
                  <span className="viewer-memcat-name">{cat}</span>
                  <span className="viewer-chip-count">{items.length}</span>
                </button>
                {!isCollapsed &&
                  !isEmpty &&
                  items.map((f) => (
                    <button
                      key={f.filename}
                      className={`viewer-listitem ${sel === f.filename ? 'active' : ''}`}
                      onClick={() => void open(f)}
                    >
                      <div className="viewer-listitem-title">
                        <DocIcon size={11} />
                        {f.title || f.filename}
                      </div>
                      <div className="viewer-listitem-sub">
                        {f.importance && f.importance !== 'medium' ? `${f.importance} · ` : ''}
                        {typeof f.char_count === 'number' ? `${f.char_count}자` : ''}
                        {f.modified ? ` · ${fmtWhen(f.modified)}` : ''}
                      </div>
                      {f.tags && f.tags.length > 0 && (
                        <div className="viewer-tags">
                          {f.tags.map((t) => (
                            <span key={t} className="viewer-tag">
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
        <div className="viewer-detail">
          {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 노트를 고르세요.</div>}
          <StateNote loading={detailLoading} error={detailErr} />
          {detail && (
            <>
              <div className="viewer-detail-head">
                <strong title={detail.title || detail.filename}>{detail.title || detail.filename}</strong>
                <button
                  className="viewer-btn sm"
                  onClick={() => void copyText(detail.body || '')}
                  title="본문 복사"
                >
                  <CopyIcon size={12} /> 복사
                </button>
              </div>
              <div className="viewer-note-meta">
                <span
                  className="viewer-memcat-badge"
                  style={{ background: categoryColor(detail.category || 'root') }}
                >
                  {detail.category || 'root'}
                </span>
                {detail.importance && <span className="viewer-badge gray">{detail.importance}</span>}
                {detail.modified && (
                  <span className="viewer-listitem-sub" style={{ marginLeft: 'auto' }}>
                    {fmtWhen(detail.modified)}
                  </span>
                )}
              </div>
              {detail.tags && detail.tags.length > 0 && (
                <div className="viewer-tags">
                  {detail.tags.map((t) => (
                    <span key={t} className="viewer-tag">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              <div className="viewer-note-body">
                <MemoryNoteBody detail={detail} onNavigate={navigate} />
              </div>
              {detail.linked_from && detail.linked_from.length > 0 && (
                <div className="viewer-backlinks">
                  <div className="viewer-label" style={{ margin: '10px 0 4px' }}>
                    이 노트를 참조하는 기억
                  </div>
                  <div className="viewer-tags">
                    {detail.linked_from.map((f) => (
                      <button key={f} className="viewer-tag viewer-tag-btn" onClick={() => navigate(f)}>
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 작업 (tasks + jobs)
// ─────────────────────────────────────────────────────────────
const TasksView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.tasksList(workflowId), [workflowId]);
  const [selTask, setSelTask] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [selJob, setSelJob] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const openTask = useCallback(
    async (t: Task) => {
      setSelTask(t.task_id);
      setSelJob(null);
      setRuns(null);
      setOutput('');
      setDetailErr(null);
      setDetailLoading(true);
      try {
        const out = await xgen.agentData.taskOutput(workflowId, t.task_id);
        setOutput(out.output || out.result || '(출력 없음)');
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const openJob = useCallback(
    async (j: Job) => {
      setSelJob(j.session_id);
      setSelTask(null);
      setOutput('');
      setRuns(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        const res = await xgen.agentData.taskRuns(workflowId, j.session_id);
        setRuns(res.runs ?? []);
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tasks = list.data?.tasks ?? [];
  const jobs = list.data?.jobs ?? [];
  const nothing = !!list.data && tasks.length === 0 && jobs.length === 0;

  return (
    <div className="viewer-split">
      <div className="viewer-list">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={nothing}
          emptyText="작업이 없습니다."
        />
        {tasks.length > 0 && <div className="viewer-list-section">작업</div>}
        {tasks.map((t) => (
          <button
            key={t.task_id}
            className={`viewer-listitem ${selTask === t.task_id ? 'active' : ''}`}
            onClick={() => void openTask(t)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${t.status === 'failed' ? 'red' : 'slate'}`}>
                {t.status || '—'}
              </span>
              {t.title || t.task_id}
            </div>
            <div className="viewer-listitem-sub">
              {t.kind || ''}
              {t.duration_s != null ? ` · ${t.duration_s}s` : ''}
              {t.created_at ? ` · ${fmtWhen(t.created_at)}` : ''}
            </div>
          </button>
        ))}
        {jobs.length > 0 && <div className="viewer-list-section">예약 작업</div>}
        {jobs.map((j) => (
          <button
            key={j.session_id}
            className={`viewer-listitem ${selJob === j.session_id ? 'active' : ''}`}
            onClick={() => void openJob(j)}
          >
            <div className="viewer-listitem-title">
              <span className={`viewer-badge ${j.status === 'active' ? 'emerald' : 'gray'}`}>
                {j.status || '—'}
              </span>
              {j.name || j.session_id}
            </div>
            <div className="viewer-listitem-sub">
              {j.schedule_type || ''}
              {j.cron_expression ? ` · ${j.cron_expression}` : ''}
              {typeof j.total_executions === 'number' ? ` · ${j.total_executions}회` : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail">
        {!selTask && !selJob && !detailLoading && (
          <div className="viewer-note">왼쪽에서 작업을 고르세요.</div>
        )}
        <StateNote loading={detailLoading} error={detailErr} />
        {selTask && output && (
          <>
            <div className="viewer-detail-head">
              <strong>작업 출력</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(output)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body">{output}</pre>
          </>
        )}
        {selJob && runs && (
          <>
            <div className="viewer-detail-head">
              <strong>실행 기록 ({runs.length})</strong>
            </div>
            {runs.length === 0 ? (
              <div className="viewer-note sm">실행 기록이 없습니다.</div>
            ) : (
              runs.map((r, i) => (
                <div key={i} className={`viewer-run ${r.error_message ? 'err' : ''}`}>
                  <div className="viewer-run-head">
                    <span className={`viewer-badge ${r.status === 'failed' ? 'red' : 'slate'}`}>
                      {r.status || '—'}
                    </span>
                    <span className="viewer-sub">
                      #{r.execution_number ?? i + 1}
                      {r.scheduled_time ? ` · ${fmtWhen(r.scheduled_time)}` : ''}
                      {r.duration_s != null ? ` · ${r.duration_s}s` : ''}
                    </span>
                  </div>
                  {r.error_message && <pre className="err">{r.error_message}</pre>}
                  {r.output && <pre className="viewer-body">{r.output}</pre>}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 도구 (forged tools)
// ─────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// 기본정보 — 이 앱에서 도는 턴의 **실제** 프롬프트 + 도구 표면
//
// 서버는 두 표면(web/connector)을 다 돌려주지만 여기서는 **connector 만** 쓴다.
// 이 창에서 시작한 턴이 그 표면으로 돌기 때문이다. 웹 화면은 반대로 web 만
// 보여 준다 — 한 화면에서 토글하던 예전 방식은 지금 보는 게 어느 실행의 것인지
// 매번 확인해야 했다.

const BasicInfoView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const loader = useLoader(() => xgen.agentData.basicInfo(workflowId), [workflowId]);
  const [tab, setTab] = useState<'prompt' | 'tools'>('prompt');
  const [raw, setRaw] = useState(false);

  const info = loader.data;
  const view = info?.surfaces?.connector ?? null;
  const groups = useMemo(
    () => (view?.provision?.stages ?? []).flatMap((st) => st.groups),
    [view],
  );
  const toolCount = useMemo(
    () => groups.reduce((n, g) => n + (g.tools?.length ?? 0), 0),
    [groups],
  );

  return (
    <div className="viewer-pane">
      <div className="viewer-toolbar">
        <div className="viewer-filters">
          {([
            ['prompt', '프롬프트'],
            ['tools', `연결된 도구${toolCount ? ` ${toolCount}` : ''}`],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              className={`viewer-chip ${tab === k ? 'active' : ''}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {tab === 'prompt' && view && (
            <>
              <button className="viewer-btn" onClick={() => setRaw((v) => !v)}>
                {raw ? '섹션 보기' : '원문 전체 보기'}
              </button>
              <button
                className="viewer-btn"
                onClick={() => void copyText(view.prompt?.full_prompt ?? '')}
              >
                <CopyIcon /> 복사
              </button>
            </>
          )}
          <button className="viewer-btn" onClick={loader.reload} disabled={loader.loading}>
            새로고침
          </button>
        </div>
      </div>
      <div className="viewer-scroll">
        <StateNote loading={loader.loading} error={loader.error} />
        {!loader.loading && !loader.error && !view && (
          <div className="viewer-note">
            이 서버는 커넥터 표면 정보를 제공하지 않습니다 (서버 업데이트가 필요합니다).
          </div>
        )}
        {view && (
          <>
            <div className="viewer-kv">
              <span className="viewer-label">실행</span>
              <span>
                {info?.provider ?? '?'} · {info?.model || '모델 미지정'}
              </span>
            </div>
            {(info?.errors?.length ?? 0) > 0 && (
              <div className="viewer-note err">
                일부 항목을 재구성하지 못했습니다: {info?.errors.join(' · ')}
              </div>
            )}

            {tab === 'prompt' ? (
              raw ? (
                <pre className="viewer-body">{view.prompt?.full_prompt || '(비어 있음)'}</pre>
              ) : (
                (view.prompt?.sections ?? []).map((sec) => (
                  <div key={sec.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{sec.title}</span>
                      {sec.dynamic && <span className="viewer-badge">실행 시 주입</span>}
                      <span className="viewer-listitem-sub">{sec.source}</span>
                    </div>
                    <pre className="viewer-body">{sec.text || sec.template || '(비어 있음)'}</pre>
                  </div>
                ))
              )
            ) : (
              <>
                {/* 노출 방식 캡션 — 웹 [기본정보]의 provision.mode_note 와 같은 자리
                    (도구 탭 안, 배지 옆의 작은 설명). 예전엔 이게 탭과 무관하게
                    화면 맨 위에 항상 떠서, 프롬프트를 보러 온 사람도 매번 지나쳐야
                    했다 — 실제로 쓰이는 곳(도구 노출 방식) 옆으로만 옮긴다. */}
                {view.provision?.mode_note && (
                  <div className="viewer-mode-note">
                    <span className="viewer-badge gray">{view.provision.exposure}</span>
                    <span>{view.provision.mode_note}</span>
                  </div>
                )}
                {groups.length === 0 && (
                  <div className="viewer-note">이 턴에 노출되는 도구가 없습니다.</div>
                )}
                {groups.map((g) => (
                  <div key={g.key} className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">{g.title}</span>
                      <span className="viewer-badge">{g.tools?.length ?? 0}</span>
                    </div>
                    {g.note && <div className="viewer-note">{g.note}</div>}
                    {g.disclosure && <div className="viewer-note">{g.disclosure}</div>}
                    {(g.tools ?? []).map((t) => (
                      <div key={t.name} className="viewer-kv">
                        <span className="viewer-tool-name">
                          <span className="viewer-path">{t.name}</span>
                          {/* 이 군체의 입구. 표시가 없으면 게이트웨이가 멤버 도구와
                              똑같이 보여, 어디서 시작해야 하는지 화면이 말해 주지 않는다.
                              웹 [기본정보] 와 같은 낱말을 쓴다 — 두 화면이 다른 말을 하면
                              같은 것을 두 개로 배우게 된다. */}
                          {t.gateway && <span className="viewer-badge gray">시작점</span>}
                        </span>
                        <span className="viewer-listitem-sub">{t.description}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {view.native_tools && (
                  <div className="viewer-run">
                    <div className="viewer-run-head">
                      <span className="viewer-listitem-title">CLI 네이티브 도구</span>
                      <span className="viewer-badge">차단 {view.native_tools.removed.length}</span>
                    </div>
                    <div className="viewer-note">{view.native_tools.note}</div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const ToolsView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.toolsList(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ForgedTool | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const open = useCallback(
    async (t: ForgedTool) => {
      setSel(t.name);
      setDetail(null);
      setDetailErr(null);
      setDetailLoading(true);
      try {
        setDetail(await xgen.agentData.toolGet(workflowId, t.name));
      } catch (e) {
        setDetailErr(errText(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tools = list.data?.tools ?? [];
  return (
    <div className="viewer-split">
      <div className="viewer-list">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tools.length === 0}
          emptyText="제작된 도구가 없습니다."
        />
        {tools.map((t) => (
          <button
            key={t.name}
            className={`viewer-listitem ${sel === t.name ? 'active' : ''}`}
            onClick={() => void open(t)}
          >
            <div className="viewer-listitem-title">
              <span
                className={`viewer-badge ${
                  t.status === 'broken' ? 'red' : t.verified ? 'emerald' : 'amber'
                }`}
              >
                {t.status === 'broken' ? '고장' : t.verified ? '검증됨' : '미검증'}
              </span>
              {t.name}
            </div>
            <div className="viewer-listitem-sub">
              {t.runtime || ''}
              {typeof t.calls === 'number' ? ` · 호출 ${t.calls}` : ''}
              {!t.enabled ? ' · 비활성' : ''}
            </div>
          </button>
        ))}
      </div>
      <div className="viewer-detail">
        {!sel && !detailLoading && <div className="viewer-note">왼쪽에서 도구를 고르세요.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detail && (
          <>
            <div className="viewer-detail-head">
              <strong>{detail.name}</strong>
              {detail.source && (
                <button className="viewer-btn sm" onClick={() => void copyText(detail.source || '')}>
                  <CopyIcon size={12} /> 코드 복사
                </button>
              )}
            </div>
            {detail.description && <div className="viewer-sub">{detail.description}</div>}
            <div className="viewer-kv">
              {detail.entrypoint && (
                <span>
                  <b>엔트리</b> {detail.entrypoint}
                </span>
              )}
              {detail.runtime && (
                <span>
                  <b>런타임</b> {detail.runtime}
                </span>
              )}
              {detail.env_keys && detail.env_keys.length > 0 && (
                <span>
                  <b>ENV</b> {detail.env_keys.join(', ')}
                </span>
              )}
              {detail.dependencies && detail.dependencies.length > 0 && (
                <span>
                  <b>의존성</b> {detail.dependencies.join(', ')}
                </span>
              )}
            </div>
            {detail.last_test_error && (
              <>
                <div className="viewer-label err">마지막 테스트 오류</div>
                <pre className="err">{detail.last_test_error}</pre>
              </>
            )}
            <div className="viewer-label">소스 코드</div>
            {detail.source_error ? (
              <div className="viewer-note err">{detail.source_error}</div>
            ) : (
              <pre className="viewer-body code">{detail.source || '(소스 없음)'}</pre>
            )}
            {detail.source_truncated && <div className="viewer-sub">※ 소스가 잘렸습니다.</div>}
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// 스토리지 (workspace)
// ─────────────────────────────────────────────────────────────
interface TreeNode {
  node: WsNode;
  children: TreeNode[];
}

const WORKSPACE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
const WORKSPACE_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function isWorkspaceImage(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 && WORKSPACE_IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

function workspaceImageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return WORKSPACE_IMAGE_MIME[ext] ?? 'application/octet-stream';
}

function buildTree(files: WsNode[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  for (const n of files) byPath.set(n.path, { node: n, children: [] });
  const roots: TreeNode[] = [];
  for (const tn of byPath.values()) {
    const parent = tn.node.path.split('/').slice(0, -1).join('/');
    const p = parent && byPath.get(parent);
    if (p) p.children.push(tn);
    else roots.push(tn);
  }
  const sort = (arr: TreeNode[]): void => {
    arr.sort(
      (a, b) =>
        Number(b.node.is_dir) - Number(a.node.is_dir) ||
        a.node.name.localeCompare(b.node.name),
    );
    for (const t of arr) sort(t.children);
  };
  sort(roots);
  return roots;
}

const TreeRow: React.FC<{
  tn: TreeNode;
  depth: number;
  selected: string | null;
  onFile: (n: WsNode) => void;
}> = ({ tn, depth, selected, onFile }) => {
  const [open, setOpen] = useState(depth < 1);
  const isDir = tn.node.is_dir;
  return (
    <>
      <button
        className={`viewer-tree-row ${selected === tn.node.path ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onFile(tn.node))}
      >
        <span className="viewer-tree-icon">
          {isDir ? (
            open ? (
              <FolderOpenIcon size={14} />
            ) : (
              <FolderIcon size={14} />
            )
          ) : (
            <DocIcon size={12} />
          )}
        </span>
        <span className="viewer-tree-name">{tn.node.name}</span>
        {!isDir && typeof tn.node.size === 'number' && (
          <span className="viewer-tree-size">{tn.node.size}B</span>
        )}
      </button>
      {isDir &&
        open &&
        tn.children.map((c) => (
          <TreeRow key={c.node.path} tn={c} depth={depth + 1} selected={selected} onFile={onFile} />
        ))}
    </>
  );
};

const StorageView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.workspaceTree(workflowId), [workflowId]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [imageUrl, setImageUrl] = useState<string>('');
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailNote, setDetailNote] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadId = useRef(0);

  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
  useEffect(
    () => () => {
      // 언마운트 뒤 끝난 요청이 Blob URL을 만들거나 상태를 갱신하지 못하게 한다.
      loadId.current += 1;
    },
    [],
  );

  const openFile = useCallback(
    async (n: WsNode) => {
      const requestId = ++loadId.current;
      setSel(n.path);
      setContent('');
      setImageUrl('');
      setDetailErr(null);
      setDetailNote(null);
      setDetailLoading(true);
      try {
        if (isWorkspaceImage(n.path)) {
          const file = await xgen.agentData.workspaceBinary(workflowId, n.path);
          if (requestId !== loadId.current) return;
          // Uint8Array 가 더 큰 버퍼 위의 뷰일 수 있다(IPC) — 선택한 파일 바이트만 담는다.
          const bytes = file.bytes;
          const buffer = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          setImageUrl(
            URL.createObjectURL(
              new Blob([buffer], { type: file.contentType || workspaceImageMime(n.path) }),
            ),
          );
        } else {
          const file = await xgen.agentData.workspaceFile(workflowId, n.path);
          if (requestId !== loadId.current) return;
          setContent(file.content);
        }
      } catch (e) {
        if (requestId !== loadId.current) return;
        // 서버는 바이너리에 415, 과대 파일에 413 을 준다 — 오류가 아니라 안내로.
        const msg = errText(e);
        if (/→ 415/.test(msg)) setDetailNote('미리보기할 수 없는 파일입니다(바이너리).');
        else if (/→ 413/.test(msg)) setDetailNote('파일이 너무 커서 미리보기할 수 없습니다.');
        else setDetailErr(msg);
      } finally {
        if (requestId === loadId.current) setDetailLoading(false);
      }
    },
    [workflowId],
  );

  const tree = useMemo(() => buildTree(list.data?.files ?? []), [list.data]);
  return (
    <div className="viewer-split">
      <div className="viewer-list tree">
        <StateNote
          loading={list.loading}
          error={list.error}
          empty={!!list.data && tree.length === 0}
          emptyText="파일이 없습니다."
        />
        {tree.map((tn) => (
          <TreeRow key={tn.node.path} tn={tn} depth={0} selected={sel} onFile={(n) => void openFile(n)} />
        ))}
      </div>
      <div className="viewer-detail">
        {!sel && !detailLoading && <div className="viewer-note">파일을 고르면 미리보기합니다.</div>}
        <StateNote loading={detailLoading} error={detailErr} />
        {detailNote && <div className="viewer-note">{detailNote}</div>}
        {sel && imageUrl && (
          <>
            <div className="viewer-detail-head">
              <strong className="viewer-path">{sel}</strong>
            </div>
            <div className="viewer-image-preview">
              <img src={imageUrl} alt={sel.split('/').pop() ?? sel} />
            </div>
          </>
        )}
        {sel && content && (
          <>
            <div className="viewer-detail-head">
              <strong className="viewer-path">{sel}</strong>
              <button className="viewer-btn sm" onClick={() => void copyText(content)}>
                <CopyIcon size={12} /> 복사
              </button>
            </div>
            <pre className="viewer-body code">{content}</pre>
          </>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
export const AgentViewer: React.FC<Props> = ({ workflowId, workflowName, initialSub }) => {
  const [sub, setSub] = useState<AgentViewerSub>(initialSub ?? 'fulllog');
  return (
    <div className="agent-viewer">
      {/* 한 줄 헤더 — [아이콘 이름] ──────── [탭]. 닫기(X)는 탭에 이미 있으므로 생략. */}
      <div className="viewer-header">
        <div className="viewer-title">
          <BotIcon size={16} />
          <strong>{workflowName || '에이전트'}</strong>
        </div>
        <div className="viewer-subtabs" role="tablist">
          {SUBS.map(([s, label]) => (
            <button
              key={s}
              role="tab"
              aria-selected={sub === s}
              className={`viewer-subtab ${sub === s ? 'active' : ''}`}
              onClick={() => setSub(s)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="viewer-content">
        {sub === 'basic' && <BasicInfoView workflowId={workflowId} />}
        {sub === 'fulllog' && <FullLogView workflowId={workflowId} />}
        {sub === 'memory' && <MemoryView workflowId={workflowId} />}
        {sub === 'tasks' && <TasksView workflowId={workflowId} />}
        {sub === 'tools' && <ToolsView workflowId={workflowId} />}
        {sub === 'storage' && <StorageView workflowId={workflowId} />}
      </div>
    </div>
  );
};
