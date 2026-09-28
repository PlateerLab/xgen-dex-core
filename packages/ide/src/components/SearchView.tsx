/**
 * 찾기 — 에이전트 샌드박스 안에서 찾는다(저장하지 않은 편집기 내용은 저장해야 찾힌다).
 *
 * 편집기와 같은 모양: 대소문자·단어 단위·정규식 토글, 바꾸기(펼침), 포함·제외할 파일.
 * 치는 대로 찾고(0.35초 쉼), 결과를 누르면 그 자리를 골라 연다.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FileIcon, Icon } from './icons';
import { useIde, useStore } from './hooks';
import { IconButton, showMenu } from './primitives';
import { basename, dirname } from '../paths';
import type { IdeSearchMatch } from '../types';

export function SearchView() {
  const store = useStore();
  const s = useIde((st) => st.search);
  const readonly = useIde((st) => st.readonly);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const schedule = (delay = 350) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDismissed(new Set());
      void store.runSearch();
    }, delay);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const set = (patch: Parameters<typeof store.setSearch>[0], rerun = true) => {
    store.setSearch(patch);
    if (rerun) schedule();
  };

  const files = useMemo(
    () => (s.result?.files ?? []).filter((f) => !dismissed.has(f.path)),
    [s.result, dismissed],
  );
  const total = files.reduce((n, f) => n + f.matches.length, 0);

  const toggle = (path: string) => {
    const next = new Set(s.collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    store.setSearch({ collapsed: next });
  };

  const openMatch = (path: string, m: IdeSearchMatch, preview = true) =>
    void store.openFile(path, { preview, line: m.line, col: m.col, length: m.len });

  return (
    <div className="xide-side-view xide-search">
      <div className="xide-side-header">
        <span className="xide-side-title">찾기</span>
        <span className="xide-section-actions">
          <IconButton icon="refresh" label="다시 찾기" onClick={() => schedule(0)} disabled={!s.query} />
          <IconButton
            icon="close"
            label="결과 지우기"
            onClick={() => {
              store.setSearch({ query: '', result: null, error: null });
              setDismissed(new Set());
            }}
          />
          <IconButton
            icon="collapse"
            label="모두 접기"
            onClick={() => store.setSearch({ collapsed: new Set(files.map((f) => f.path)) })}
          />
        </span>
      </div>
      <div className="xide-search-form">
        <div className="xide-search-row">
          {!readonly ? (
            <button
              type="button"
              className="xide-search-toggle-replace"
              aria-label={s.showReplace ? '바꾸기 닫기' : '바꾸기 열기'}
              aria-expanded={s.showReplace}
              title="바꾸기"
              onClick={() => store.setSearch({ showReplace: !s.showReplace })}
            >
              <Icon name={s.showReplace ? 'chevron-down' : 'chevron-right'} />
            </button>
          ) : null}
          <div className="xide-search-fields">
            <div className="xide-search-box">
              <textarea
                ref={inputRef}
                className="xide-input"
                rows={1}
                value={s.query}
                placeholder="찾기"
                aria-label="찾기"
                spellCheck={false}
                onChange={(e) => set({ query: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    schedule(0);
                  }
                }}
              />
              <span className="xide-search-flags">
                <FlagButton icon="case" label="대소문자 구분" on={s.caseSensitive} onClick={() => set({ caseSensitive: !s.caseSensitive })} />
                <FlagButton icon="word" label="단어 단위로" on={s.word} onClick={() => set({ word: !s.word })} />
                <FlagButton icon="regex" label="정규식 사용" on={s.regex} onClick={() => set({ regex: !s.regex })} />
              </span>
            </div>
            {s.showReplace && !readonly ? (
              <div className="xide-search-box">
                <textarea
                  className="xide-input"
                  rows={1}
                  value={s.replace}
                  placeholder="바꾸기"
                  aria-label="바꾸기"
                  spellCheck={false}
                  onChange={(e) => store.setSearch({ replace: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
                      e.preventDefault();
                      void store.replaceInFiles(files.map((f) => f.path));
                    } else if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
                  }}
                />
                <span className="xide-search-flags">
                  <FlagButton
                    icon="replace-all"
                    label="모두 바꾸기"
                    on={false}
                    disabled={!files.length}
                    onClick={() => void store.replaceInFiles(files.map((f) => f.path))}
                  />
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="xide-search-details-toggle">
          <IconButton
            icon="more"
            label={s.showDetails ? '포함·제외 닫기' : '포함·제외할 파일'}
            active={s.showDetails}
            onClick={() => store.setSearch({ showDetails: !s.showDetails })}
          />
        </div>
        {s.showDetails ? (
          <div className="xide-search-details">
            <label>
              <span>포함할 파일</span>
              <input
                className="xide-input"
                value={s.include}
                placeholder="예: src, *.ts"
                spellCheck={false}
                onChange={(e) => set({ include: e.target.value })}
              />
            </label>
            <label>
              <span>제외할 파일</span>
              <input
                className="xide-input"
                value={s.exclude}
                placeholder="예: dist, *.min.js"
                spellCheck={false}
                onChange={(e) => set({ exclude: e.target.value })}
              />
            </label>
          </div>
        ) : null}
      </div>
      <div className="xide-search-summary" aria-live="polite">
        {s.running ? '찾는 중' : null}
        {!s.running && s.error ? <span className="xide--error">{s.error}</span> : null}
        {!s.running && !s.error && s.result ? (
          total ? (
            <>
              {files.length}개 파일에서 {total}개 결과
              {s.result.truncated ? <span className="xide--warn"> · 결과가 많아 일부만 보입니다. 조건을 좁혀 보세요.</span> : null}
            </>
          ) : (
            '결과가 없습니다'
          )
        ) : null}
      </div>
      <div className="xide-search-results" role="tree" aria-label="찾기 결과">
        {files.map((f) => {
          const open = !s.collapsed.has(f.path);
          return (
            <div key={f.path} className="xide-search-file" role="treeitem" aria-expanded={open}>
              <div
                className="xide-search-file-row"
                title={f.path}
                onClick={() => toggle(f.path)}
                onContextMenu={(e) =>
                  showMenu(e, [
                    { id: 'open', label: '파일 열기', run: () => void store.openFile(f.path, { preview: false }) },
                    ...(s.showReplace && !readonly
                      ? [{ id: 'replace', label: '이 파일에서 모두 바꾸기', run: () => void store.replaceInFiles([f.path]) }]
                      : []),
                    { id: 'dismiss', label: '결과에서 빼기', run: () => setDismissed((d) => new Set([...d, f.path])) },
                  ])
                }
              >
                <Icon name={open ? 'chevron-down' : 'chevron-right'} />
                <FileIcon name={basename(f.path)} />
                <span className="xide-search-file-name">{basename(f.path)}</span>
                <span className="xide-search-file-dir">{dirname(f.path)}</span>
                <span className="xide-search-count">{f.matches.length}</span>
                <span className="xide-row-actions">
                  {s.showReplace && !readonly ? (
                    <IconButton
                      icon="replace-all"
                      label="이 파일에서 모두 바꾸기"
                      onClick={(e) => {
                        e.stopPropagation();
                        void store.replaceInFiles([f.path]);
                      }}
                    />
                  ) : null}
                  <IconButton
                    icon="close"
                    label="결과에서 빼기"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDismissed((d) => new Set([...d, f.path]));
                    }}
                  />
                </span>
              </div>
              {open
                ? f.matches.map((m, i) => (
                    <div
                      key={`${m.line}:${m.col}:${i}`}
                      className="xide-search-match"
                      role="treeitem"
                      tabIndex={-1}
                      title={`${m.line}번째 줄`}
                      onClick={() => openMatch(f.path, m)}
                      onDoubleClick={() => openMatch(f.path, m, false)}
                    >
                      <MatchPreview m={m} replace={s.showReplace && !readonly ? s.replace : null} />
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlagButton({
  icon,
  label,
  on,
  disabled,
  onClick,
}: {
  icon: 'case' | 'word' | 'regex' | 'replace-all';
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`xide-flag${on ? ' xide--on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

/** 미리보기 한 줄 — UTF-16 위치로 일치를 자른다(서버가 그 단위로 준다). */
function MatchPreview({ m, replace }: { m: IdeSearchMatch; replace: string | null }): ReactElement {
  const text = m.preview;
  const before = text.slice(0, m.at);
  const hit = text.slice(m.at, m.at + m.len);
  const after = text.slice(m.at + m.len);
  return (
    <span className="xide-search-preview">
      <span>{before.trimStart()}</span>
      {replace != null ? (
        <>
          <del className="xide-search-hit">{hit}</del>
          <ins className="xide-search-ins">{replace}</ins>
        </>
      ) : (
        <mark className="xide-search-hit">{hit}</mark>
      )}
      <span>{after}</span>
    </span>
  );
}
