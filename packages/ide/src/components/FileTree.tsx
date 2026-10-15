/**
 * 읽기 전용 탐색기 — IDE 탐색기와 **같은 모양**을 다른 화면(에이전트 [스토리지] 등)에 그대로 쓴다.
 *
 * 같은 마크업·같은 클래스·같은 아이콘이다(Explorer 의 줄과 같다). 다른 점은 고치는 기능이 없다는 것뿐이다:
 * 새 파일·이름 바꾸기·끌어 옮기기·오른쪽 메뉴가 없고, 줄을 누르면 `onOpen` 으로 알린다.
 * IdeStore 없이 돈다 — 목록(`entries`)만 넘기면 된다.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { FileIcon, Icon } from './icons';
import { IconButton } from './primitives';
import { buildTree, visibleRows } from '../tree';
import { formatBytes } from '../text';
import type { IdeFileEntry, ThemeKind } from '../types';

export interface FileTreeProps {
  /** 맨 위 머리(IDE 와 같은 "탐색기"). */
  title?: string;
  /** 구역 이름 — 에이전트 이름. */
  rootName: string;
  entries: IdeFileEntry[];
  /** 지금 열려 있는 파일(강조). */
  activePath?: string | null;
  onOpen(path: string): void;
  loading?: boolean;
  error?: string | null;
  onRefresh?(): void;
  theme?: ThemeKind;
  className?: string;
  emptyText?: string;
  /** 처음 펼쳐 둘 깊이(0 = 모두 접음). */
  initialDepth?: number;
}

function indent(depth: number): number {
  return 8 + depth * 12;
}

export function FileTree({
  title = '탐색기',
  rootName,
  entries,
  activePath = null,
  onOpen,
  loading = false,
  error = null,
  onRefresh,
  theme = 'dark',
  className,
  emptyText = '아직 파일이 없습니다.',
  initialDepth = 0,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(activePath);

  // 처음 목록이 오면 정한 깊이까지 펼친다 — 그 뒤로는 사람이 연 대로 둔다.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || entries.length === 0) return;
    setSeeded(true);
    if (initialDepth <= 0) return;
    const open = new Set<string>();
    const walk = (nodes: typeof tree.children, depth: number) => {
      for (const n of nodes) {
        if (!n.isDir || depth >= initialDepth) continue;
        open.add(n.path);
        walk(n.children, depth + 1);
      }
    };
    walk(tree.children, 0);
    setExpanded(open);
  }, [entries.length, initialDepth, seeded, tree]);

  // 열린 파일이 바뀌면 그 위 폴더를 펼쳐 보이게 한다.
  useEffect(() => {
    if (!activePath) return;
    setFocused(activePath);
    const parts = activePath.split('/');
    if (parts.length < 2) return;
    setExpanded((cur) => {
      const next = new Set(cur);
      for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join('/'));
      return next.size === cur.size ? cur : next;
    });
  }, [activePath]);

  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activate = useCallback(
    (path: string, isDir: boolean) => {
      setFocused(path);
      if (isDir) toggle(path);
      else onOpen(path);
    },
    [onOpen, toggle],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const at = Math.max(0, rows.findIndex((r) => r.node.path === focused));
    const row = rows[at];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
      setFocused(next.node.path);
    } else if (e.key === 'ArrowRight' && row?.node.isDir && !expanded.has(row.node.path)) {
      e.preventDefault();
      toggle(row.node.path);
    } else if (e.key === 'ArrowLeft' && row?.node.isDir && expanded.has(row.node.path)) {
      e.preventDefault();
      toggle(row.node.path);
    } else if ((e.key === 'Enter' || e.key === ' ') && row) {
      e.preventDefault();
      activate(row.node.path, row.node.isDir);
    }
  };

  return (
    <div className={`xide-root xide-theme-${theme} xide-filetree${className ? ` ${className}` : ''}`} data-theme={theme}>
      <aside className="xide-sidebar" aria-label={title}>
        <div className="xide-side-view xide-explorer">
          <div className="xide-side-header">
            <span className="xide-side-title">{title}</span>
          </div>
          <div className="xide-section-header" title={rootName}>
            <span className="xide-section-title">{rootName || 'WORKSPACE'}</span>
            <span className="xide-section-actions">
              {onRefresh ? <IconButton icon="refresh" label="새로 고침" onClick={() => onRefresh()} /> : null}
              <IconButton icon="collapse" label="모두 접기" onClick={() => setExpanded(new Set())} />
            </span>
          </div>
          <div className="xide-tree" role="tree" aria-label="파일" tabIndex={0} onKeyDown={onKeyDown}>
            {loading ? (
              <div className="xide-tree-note">
                <span className="xide-spinner" aria-hidden /> 불러오는 중
              </div>
            ) : null}
            {error ? (
              <div className="xide-tree-note xide--error" role="alert">
                <span>{error}</span>
                {onRefresh ? (
                  <button type="button" className="xide-link" onClick={() => onRefresh()}>
                    지금 다시 시도
                  </button>
                ) : null}
              </div>
            ) : null}
            {!loading && !error && rows.length === 0 ? <div className="xide-tree-note">{emptyText}</div> : null}
            {rows.map(({ node, depth }) => {
              const open = expanded.has(node.path);
              const title = [node.path, !node.isDir && node.size != null ? formatBytes(node.size) : '', node.originName ? `마지막 변경: ${node.originName}` : '']
                .filter(Boolean)
                .join('\n');
              return (
                <div
                  key={node.path}
                  className={[
                    'xide-tree-row',
                    focused === node.path ? 'xide--focused' : '',
                    focused === node.path ? 'xide--selected' : '',
                    activePath === node.path ? 'xide--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={node.isDir ? open : undefined}
                  aria-selected={focused === node.path}
                  data-path={node.path}
                  title={title}
                  style={{ paddingLeft: indent(depth) }}
                  onClick={() => activate(node.path, node.isDir)}
                >
                  <span className="xide-tree-guides" style={{ width: indent(depth) - 8 }} />
                  <span className="xide-tree-chevron">{node.isDir ? <Icon name={open ? 'chevron-down' : 'chevron-right'} /> : null}</span>
                  <FileIcon name={node.name} isDir={node.isDir} open={open} />
                  <span className="xide-tree-name">{node.name}</span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}
