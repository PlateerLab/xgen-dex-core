/**
 * 빠른 열기 — 편집기와 같은 한 칸 입력.
 *
 *   (그냥)  파일 이름으로 찾아 열기
 *   >       명령
 *   :       줄로 이동
 *   (브랜치) 브랜치 전환·만들기
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { FileIcon, Icon } from './icons';
import { useFocusReturn, useIde, useStore } from './hooks';
import { fuzzyFilter, fuzzyMatch } from '../fuzzy';
import { filePaths } from '../tree';
import { basename, dirname } from '../paths';
import { formatBinding } from '../keys';
import type { GitBranches } from '../git-model';
import type { QuickOpenMode } from '../store';
import { createBranch } from './ScmView';

interface Row {
  key: string;
  label: string;
  detail?: string;
  hint?: string;
  icon?: ReactElement;
  positions?: number[];
  run: (opts: { side: boolean }) => void;
}

export function QuickOpen() {
  const store = useStore();
  const q = useIde((s) => s.quickOpen);
  useFocusReturn(!!q);
  if (!q) return null;
  return <QuickOpenBox key={`${q.mode}:${q.initial}`} mode={q.mode} initial={q.initial} onClose={() => store.closeQuickOpen()} />;
}

const PREFIX: Record<string, QuickOpenMode> = { '>': 'commands', ':': 'line' };

function QuickOpenBox({ mode: startMode, initial, onClose }: { mode: QuickOpenMode; initial: string; onClose: () => void }) {
  const store = useStore();
  const tree = useIde((s) => s.tree);
  const groups = useIde((s) => s.groups);
  const [text, setText] = useState(
    startMode === 'commands' ? `>${initial}` : startMode === 'line' ? `:${initial}` : initial,
  );
  const [index, setIndex] = useState(0);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mode: QuickOpenMode = startMode === 'branches' ? 'branches' : PREFIX[text[0]] ?? 'files';
  const query = mode === 'commands' || mode === 'line' ? text.slice(1) : text;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (mode !== 'branches') return;
    const repos = store.getState().git.repos;
    const repo = repos.includes('') ? '' : repos[0];
    if (repo == null) return;
    void store.host.git<GitBranches>({ op: 'branches', repo }).then(setBranches, () => setBranches({ local: [], remote: [], tags: [] }));
  }, [mode, store]);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const g of groups) for (const t of g.tabs) if (t.kind !== 'diff' && !seen.has(t.path)) {
      seen.add(t.path);
      out.push(t.path);
    }
    return out;
  }, [groups]);

  const rows: Row[] = useMemo(() => {
    if (mode === 'files') {
      const all = filePaths(tree);
      const items = query.trim()
        ? fuzzyFilter(all, query, (p) => p, 100).map((m) => ({ path: m.item, positions: m.match.positions }))
        : [...recent, ...all.filter((p) => !recent.includes(p))].slice(0, 100).map((path) => ({ path, positions: [] as number[] }));
      return items.map(({ path, positions }) => ({
        key: path,
        label: basename(path),
        detail: dirname(path),
        icon: <FileIcon name={basename(path)} />,
        positions: positions.filter((p) => p >= path.length - basename(path).length).map((p) => p - (path.length - basename(path).length)),
        run: ({ side }) => (side ? void store.openToSide(path) : void store.openFile(path, { preview: false })),
      }));
    }
    if (mode === 'commands') {
      const s = store.getState();
      const cmds = store.commands.filter((c) => !c.when || c.when(s));
      const label = (c: (typeof cmds)[number]) => (c.category ? `${c.category}: ${c.title}` : c.title);
      const matched = query.trim() ? fuzzyFilter(cmds, query, label, 100) : cmds.map((c) => ({ item: c, match: { score: 0, positions: [] } }));
      return matched.map(({ item, match }) => ({
        key: item.id,
        label: label(item),
        hint: item.keybinding ? formatBinding(item.keybinding) : undefined,
        positions: match.positions,
        run: () => void item.run(),
      }));
    }
    if (mode === 'line') {
      const [lineRaw, colRaw] = query.split(/[:,]/);
      const line = Number.parseInt(lineRaw, 10);
      const col = Number.parseInt(colRaw ?? '', 10);
      const editor = store.editors.get(store.getState().activeGroup);
      const count = editor?.getModel()?.getLineCount() ?? 0;
      if (!editor || !count) return [{ key: 'none', label: '먼저 파일을 여세요', run: () => undefined }];
      if (!Number.isFinite(line)) {
        return [{ key: 'hint', label: `이동할 줄 번호를 입력하세요 (1 ~ ${count})`, run: () => undefined }];
      }
      const target = Math.max(1, Math.min(count, line));
      return [
        {
          key: 'go',
          label: `${target}번째 줄${Number.isFinite(col) ? `, ${col}번째 열` : ''}로 이동`,
          run: () => {
            const c = Number.isFinite(col) ? col : 1;
            editor.setPosition({ lineNumber: target, column: c });
            editor.revealLineInCenter(target);
            editor.focus();
          },
        },
      ];
    }
    // 브랜치
    const repos = store.getState().git.repos;
    const repo = repos.includes('') ? '' : repos[0] ?? '';
    const create: Row = {
      key: 'create',
      label: '새 브랜치 만들기',
      icon: <Icon name="plus" />,
      run: () => void createBranch(store, repo),
    };
    if (!branches) return [create, { key: 'loading', label: '브랜치를 불러오는 중', run: () => undefined }];
    const list = [
      ...branches.local.map((b) => ({ b, remote: false })),
      ...branches.remote.map((b) => ({ b, remote: true })),
    ].filter(({ b }) => !query.trim() || fuzzyMatch(query, b.name));
    return [
      create,
      ...list.map(({ b, remote }) => ({
        key: `${remote ? 'r' : 'l'}:${b.name}`,
        label: b.name,
        detail: `${b.current ? '지금 브랜치 · ' : ''}${remote ? '원격 · ' : ''}${b.oid} ${b.subject}`,
        icon: <Icon name={remote ? 'cloud' : 'branch'} />,
        run: () => {
          if (b.current) return;
          if (remote) {
            const local = b.name.split('/').slice(1).join('/');
            const exists = branches.local.some((x) => x.name === local);
            void store.gitRun(
              exists ? { op: 'checkout', repo, ref: local } : { op: 'checkout', repo, ref: b.name, track: true },
              '브랜치 전환',
            );
          } else void store.gitRun({ op: 'checkout', repo, ref: b.name }, '브랜치 전환');
        },
      })),
    ];
  }, [mode, query, tree, recent, branches, store]);

  useEffect(() => setIndex(0), [text]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.xide-qo-row.xide--active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const pick = (row: Row | undefined, side = false) => {
    if (!row) return;
    onClose();
    row.run({ side });
  };

  const placeholder =
    mode === 'branches'
      ? '브랜치 이름'
      : mode === 'commands'
        ? '명령 이름'
        : mode === 'line'
          ? '줄 번호(줄:열)'
          : `파일 이름으로 찾기 (명령은 > · 줄 이동은 :)`;

  return (
    <div className="xide-qo-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="xide-qo" role="dialog" aria-label="빠른 열기">
        <input
          ref={inputRef}
          className="xide-input"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          aria-label={placeholder}
          aria-activedescendant={rows[index] ? `xide-qo-${index}` : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'PageDown') {
              e.preventDefault();
              setIndex((i) => Math.min(rows.length - 1, i + 10));
            } else if (e.key === 'PageUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 10));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(rows[index], e.ctrlKey || e.metaKey);
            }
          }}
        />
        <div className="xide-qo-list" ref={listRef} role="listbox">
          {rows.length === 0 ? <div className="xide-qo-empty">맞는 것이 없습니다</div> : null}
          {rows.map((r, i) => (
            <div
              key={r.key}
              id={`xide-qo-${i}`}
              role="option"
              aria-selected={i === index}
              className={`xide-qo-row${i === index ? ' xide--active' : ''}`}
              onMouseMove={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r, e.ctrlKey || e.metaKey);
              }}
            >
              {r.icon ?? null}
              <span className="xide-qo-label">{highlight(r.label, r.positions)}</span>
              {r.detail ? <span className="xide-qo-detail">{r.detail}</span> : null}
              {r.hint ? <kbd className="xide-qo-hint">{r.hint}</kbd> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, positions?: number[]): ReactElement {
  if (!positions?.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {Array.from(text).map((ch, i) => (set.has(i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>))}
    </>
  );
}
