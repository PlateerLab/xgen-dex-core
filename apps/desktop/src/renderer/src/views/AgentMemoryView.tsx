import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MemoryDetail } from '@dex/protocol';
import { xgen, copyText } from '../bridge';
import { CopyIcon, DocIcon, RefreshIcon } from '../brand/icons';
import { Selector } from './Selector';
import { fmtWhen, StateNote, useLoader, ViewerEmpty } from './agent-viewer-shared';
import { useViewerScroll, useViewerState } from './agent-viewer-state';
import {
  categoryLabel,
  clampMemoryWidth,
  cleanMemoryText,
  filterMemoryFiles,
  memoryPreview,
  memoryTitle,
  type MemorySort,
} from './agent-memory-model';

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
    text = text
      .replace(/\n---\s*$/m, '')
      .replace(/^---\s*$/gm, '')
      .trim();
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
            <div className="viewer-convo-text">{cleanMemoryText(t.text)}</div>
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
    () => preprocessWikilinks(stripArchiveMarkup(cleanMemoryText(detail.body || ''))),
    [detail.body],
  );
  if (conversationTurns) return <ConversationBody turns={conversationTurns} />;
  return (
    <div className="viewer-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('wikilink://') ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('wikilink://')) {
              const target = decodeURIComponent(href.slice('wikilink://'.length));
              return (
                <button
                  type="button"
                  className="viewer-wikilink"
                  onClick={() => onNavigate(target)}
                >
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

function shortDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const AgentMemoryView: React.FC<{ workflowId: string }> = ({ workflowId }) => {
  const list = useLoader(() => xgen.agentData.memoryList(workflowId), [workflowId]);
  const [selected, setSelected] = useViewerState<string | null>('memory.selected', null);
  const [query, setQuery] = useViewerState('memory.query', '');
  const [category, setCategory] = useViewerState('memory.category', '');
  const [tag, setTag] = useViewerState('memory.tag', '');
  const [sort, setSort] = useViewerState<MemorySort>('memory.sort', 'recent');
  const [width, setWidth] = useViewerState('memory.width', 340);
  const [raw, setRaw] = useViewerState('memory.raw', false);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const files = useMemo(() => list.data?.files ?? [], [list.data]);
  const filtered = useMemo(
    () => filterMemoryFiles(files, { query, category, tag, sort }),
    [files, query, category, tag, sort],
  );
  const detailLoader = useLoader(
    () => (selected ? xgen.agentData.memoryRead(workflowId, selected) : Promise.resolve(null)),
    [workflowId, selected],
  );
  const detail = detailLoader.data?.filename === selected ? detailLoader.data : null;
  const listScroll = useViewerScroll(
    `memory.list:${query}:${category}:${tag}:${sort}`,
    !!list.data,
  );
  const detailScroll = useViewerScroll(`memory.detail:${selected}:${raw}`, !!detail);
  const counts = useMemo(() => {
    const categories = new Map<string, number>();
    const tags = new Map<string, number>();
    let chars = 0;
    for (const file of files) {
      const name = file.category || 'root';
      categories.set(name, (categories.get(name) ?? 0) + 1);
      for (const value of new Set(file.tags ?? [])) tags.set(value, (tags.get(value) ?? 0) + 1);
      chars += file.char_count ?? 0;
    }
    return { categories: [...categories], tags: [...tags].sort((a, b) => b[1] - a[1]), chars };
  }, [files]);

  // Restore the selected note if it still matches; otherwise show the first result immediately.
  useEffect(() => {
    if (!list.data) return;
    if (!filtered.some((file) => file.filename === selected))
      setSelected(filtered[0]?.filename ?? null);
  }, [list.data, filtered, selected, setSelected]);

  const navigate = useCallback(
    (target: string) => {
      const match =
        files.find((file) => file.filename === target) ||
        files.find(
          (file) => file.filename.endsWith(`/${target}`) || file.filename === `${target}.md`,
        ) ||
        files.find((file) => file.title === target) ||
        files.find((file) => file.filename.toLowerCase().includes(target.toLowerCase()));
      if (match) {
        setQuery('');
        setCategory('');
        setTag('');
        setSelected(match.filename);
      }
    },
    [files, setQuery, setCategory, setTag, setSelected],
  );
  const refresh = () => {
    list.reload();
    detailLoader.reload();
  };
  const clearFilters = () => {
    setQuery('');
    setCategory('');
    setTag('');
  };
  const filtering = !!(query || category || tag);

  return (
    <div className="viewer-pane memory-pane">
      <div className="viewer-toolbar memory-toolbar">
        <div>
          <strong>메모리</strong>
          <span>
            {list.loading
              ? '불러오는 중…'
              : `${files.length}개의 노트 · ${counts.chars.toLocaleString()}자`}
          </span>
        </div>
        <button
          className="viewer-btn"
          onClick={refresh}
          disabled={list.loading}
          aria-label="메모리 새로고침"
        >
          <RefreshIcon size={13} /> 새로고침
        </button>
      </div>
      {list.error ? (
        <ViewerEmpty
          title="메모리를 불러오지 못했습니다"
          description={list.error}
          error
          onRetry={list.reload}
        />
      ) : !list.loading && files.length === 0 ? (
        <ViewerEmpty
          title="아직 저장된 메모리가 없습니다"
          description="에이전트와 대화하며 쌓인 기억을 이곳에서 확인할 수 있습니다."
          onRetry={list.reload}
        />
      ) : (
        <div
          className="memory-split"
          style={{ '--memory-list-width': `${width}px` } as React.CSSProperties}
        >
          <div className="memory-sidebar">
            <div className="memory-controls">
              <div className="memory-search-wrap">
                <input
                  className="viewer-search"
                  aria-label="메모리 검색"
                  placeholder="제목·미리보기 검색"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    className="memory-clear"
                    aria-label="검색어 지우기"
                    onClick={() => setQuery('')}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="memory-selectors">
                <Selector
                  size="sm"
                  ariaLabel="메모리 분류"
                  value={category}
                  onChange={setCategory}
                  options={[
                    { value: '', label: '전체 분류', count: files.length },
                    ...counts.categories.map(([value, count]) => ({
                      value,
                      label: categoryLabel(value),
                      count,
                    })),
                  ]}
                />
                <Selector
                  size="sm"
                  ariaLabel="메모리 정렬"
                  value={sort}
                  onChange={(value) => setSort(value as MemorySort)}
                  options={[
                    { value: 'recent', label: '최신순' },
                    { value: 'oldest', label: '오래된순' },
                    { value: 'title', label: '제목순' },
                  ]}
                />
              </div>
              <div className="memory-filter-summary">
                <Selector
                  size="sm"
                  ariaLabel="메모리 태그"
                  value={tag}
                  onChange={setTag}
                  searchable
                  searchPlaceholder="태그 검색"
                  options={[
                    { value: '', label: '전체 태그' },
                    ...counts.tags.map(([value, count]) => ({ value, label: `#${value}`, count })),
                  ]}
                />
                <span role="status">
                  {list.loading
                    ? '불러오는 중…'
                    : `${filtered.length}개${filtering ? ` / ${files.length}개` : '의 노트'}`}
                </span>
                {filtering && (
                  <button className="memory-reset" onClick={clearFilters}>
                    초기화
                  </button>
                )}
              </div>
            </div>
            <div
              className="memory-list"
              {...listScroll}
              aria-label="메모리 노트 목록"
              aria-busy={list.loading}
            >
              {list.loading && <StateNote loading error={null} />}
              {filtered.map((file) => {
                const title = memoryTitle(file);
                const preview = memoryPreview(file.first_paragraph);
                return (
                  <button
                    key={file.filename}
                    className={`memory-item${selected === file.filename ? ' active' : ''}`}
                    aria-current={selected === file.filename ? 'true' : undefined}
                    onClick={() => setSelected(file.filename)}
                  >
                    <span className="memory-item-heading">
                      <DocIcon size={14} />
                      <span title={title}>{title}</span>
                    </span>
                    {preview && preview !== title && (
                      <span className="memory-item-preview">{preview}</span>
                    )}
                    <span className="memory-item-meta">
                      <span
                        className="memory-category-dot"
                        style={{ background: categoryColor(file.category || 'root') }}
                      />
                      <span>{categoryLabel(file.category || 'root')}</span>
                      {file.importance === 'high' && <span className="memory-important">중요</span>}
                      <time title={fmtWhen(file.modified)}>{shortDate(file.modified)}</time>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div
            className="memory-resize"
            role="separator"
            aria-label="메모리 목록 너비"
            aria-orientation="vertical"
            aria-valuemin={260}
            aria-valuemax={520}
            aria-valuenow={Math.round(width)}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                x: event.clientX,
                width:
                  event.currentTarget.previousElementSibling?.getBoundingClientRect().width ??
                  width,
              };
            }}
            onPointerMove={(event) => {
              if (drag.current)
                setWidth(clampMemoryWidth(drag.current.width + event.clientX - drag.current.x));
            }}
            onPointerUp={(event) => {
              drag.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onDoubleClick={() => setWidth(340)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              setWidth(
                event.key === 'Home'
                  ? 260
                  : event.key === 'End'
                    ? 520
                    : clampMemoryWidth(width + (event.key === 'ArrowLeft' ? -20 : 20)),
              );
            }}
          />
          <div
            className="memory-reader"
            {...detailScroll}
            aria-busy={!!selected && detailLoader.loading}
          >
            {!list.loading && filtered.length === 0 ? (
              <ViewerEmpty
                title="검색 결과가 없습니다"
                description="검색어나 분류, 태그를 바꿔 보세요."
              />
            ) : detailLoader.error ? (
              <ViewerEmpty
                title="노트를 불러오지 못했습니다"
                description={detailLoader.error}
                error
                onRetry={detailLoader.reload}
              />
            ) : detail ? (
              <article className="memory-document">
                <header className="memory-document-header">
                  <div className="memory-document-topline">
                    <span className="memory-document-category">
                      <span
                        className="memory-category-dot"
                        style={{ background: categoryColor(detail.category || 'root') }}
                      />
                      {categoryLabel(detail.category || 'root')}
                    </span>
                    <div className="memory-document-actions">
                      <button
                        className="viewer-btn sm"
                        aria-pressed={raw}
                        onClick={() => setRaw((value) => !value)}
                      >
                        {raw ? '읽기 보기' : '원문 보기'}
                      </button>
                      <button
                        className="viewer-btn sm"
                        onClick={() => void copyText(detail.body || '')}
                        title="노트 원문 복사"
                      >
                        <CopyIcon size={12} /> 복사
                      </button>
                    </div>
                  </div>
                  <h1>{memoryTitle(detail)}</h1>
                  <div className="memory-document-meta">
                    {detail.modified && <time>{fmtWhen(detail.modified)} 수정</time>}
                    {detail.importance === 'high' && (
                      <span className="memory-important">중요한 기억</span>
                    )}
                  </div>
                  {!!detail.tags?.length && (
                    <div className="viewer-tags">
                      {detail.tags.map((value) => (
                        <button
                          key={value}
                          className="viewer-tag viewer-tag-btn"
                          onClick={() => setTag(value)}
                        >
                          #{value}
                        </button>
                      ))}
                    </div>
                  )}
                </header>
                {raw ? (
                  <>
                    <div className="viewer-sub">{detail.title || detail.filename}</div>
                    <pre className="viewer-body">{detail.body}</pre>
                  </>
                ) : (
                  <MemoryNoteBody detail={detail} onNavigate={navigate} />
                )}
                {!!detail.linked_from?.length && (
                  <footer className="viewer-backlinks">
                    <div className="viewer-label">이 노트를 참조하는 기억</div>
                    <div className="viewer-tags">
                      {detail.linked_from.map((filename) => (
                        <button
                          key={filename}
                          className="viewer-tag viewer-tag-btn"
                          onClick={() => navigate(filename)}
                        >
                          {memoryTitle(
                            files.find((file) => file.filename === filename) ?? { filename },
                          )}
                        </button>
                      ))}
                    </div>
                  </footer>
                )}
              </article>
            ) : (
              <StateNote loading={list.loading || detailLoader.loading} error={null} />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
