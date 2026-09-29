/**
 * 탐색기 — 에이전트의 스토리지를 그대로 보여 준다.
 *
 * 한 번 누르면 미리보기(기울임 탭), 두 번 누르면 고정해서 연다. 여러 개는 Ctrl(맥 Cmd)·Shift
 * 로 고른다. 오른쪽 클릭 메뉴와 단축키(F2·Delete·복사·잘라내기·붙여넣기)는 편집기와 같다.
 * 운영체제의 파일을 끌어다 놓으면 그 폴더로 올리고, 안에서 끌면 옮긴다.
 *
 * 이 대화에 폴더를 연결했으면 구분선 아래 [연결된 폴더] 가 따로 보인다(FolderSection).
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { FileIcon, Icon } from './icons';
import { FolderSection } from './FolderSection';
import { useIde, useStore } from './hooks';
import { IconButton, InlineInput, showMenu, type MenuEntry } from './primitives';
import { visibleRows, type TreeNode } from '../tree';
import { basename, dirname, invalidName, isWithin, join } from '../paths';
import { decorations, type Decoration, type GitFileStatus } from '../git-model';
import { formatBytes } from '../text';
import { isMac } from '../keys';

const DRAG_TYPE = 'application/x-xide-paths';

export function Explorer() {
  const store = useStore();
  const tree = useIde((s) => s.tree);
  const expanded = useIde((s) => s.expanded);
  const selected = useIde((s) => s.selected);
  const creating = useIde((s) => s.creating);
  const renaming = useIde((s) => s.renaming);
  const clipboard = useIde((s) => s.clipboard);
  const filesLoaded = useIde((s) => s.filesLoaded);
  const filesError = useIde((s) => s.filesError);
  const readonly = useIde((s) => s.readonly);
  const statuses = useIde((s) => s.git.statuses);
  const activePath = useIde((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroup);
    const t = g?.tabs.find((x) => x.id === g.activeId);
    return t && t.kind !== 'diff' ? t.path : null;
  });
  const agentName = store.host.agentName;

  const [multi, setMulti] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const deco = useMemo(() => decorations(Object.values(statuses)), [statuses]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  // 활성 편집기를 따라 탐색기도 그 파일을 드러낸다(편집기의 기본 동작).
  useEffect(() => {
    if (activePath) {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-path="${cssEscape(activePath)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [activePath, rows.length]);

  const selection = useCallback(
    (path: string): string[] => (multi.has(path) && multi.size > 1 ? [...multi] : [path]),
    [multi],
  );

  const onRowClick = (node: TreeNode, e: MouseEvent) => {
    const toggle = isMac ? e.metaKey : e.ctrlKey;
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((r) => r.node.path === anchor.current);
      const b = rows.findIndex((r) => r.node.path === node.path);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setMulti(new Set(rows.slice(lo, hi + 1).map((r) => r.node.path)));
        store.select(node.path);
        return;
      }
    }
    if (toggle) {
      setMulti((cur) => {
        const next = new Set(cur.size ? cur : selected ? [selected] : []);
        if (next.has(node.path)) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      anchor.current = node.path;
      store.select(node.path);
      return;
    }
    setMulti(new Set([node.path]));
    anchor.current = node.path;
    store.select(node.path);
    if (node.isDir) store.setExpanded(node.path, !expanded.has(node.path));
    else void store.openFile(node.path, { preview: true });
  };

  const onRowDoubleClick = (node: TreeNode) => {
    if (node.isDir) return;
    void store.openFile(node.path, { preview: false });
  };

  const targetDirOf = (path: string | null): string => {
    if (!path) return '';
    return store.isDir(path) ? path : dirname(path);
  };

  const menuFor = (node: TreeNode | null): MenuEntry[] => {
    const paths = node ? selection(node.path) : [];
    const dir = node ? (node.isDir ? node.path : dirname(node.path)) : '';
    const one = paths.length <= 1;
    const items: MenuEntry[] = [];
    if (!readonly) {
      items.push(
        { id: 'new-file', label: '새 파일', run: () => store.startCreate(dir, 'file') },
        { id: 'new-folder', label: '새 폴더', run: () => store.startCreate(dir, 'dir') },
        'separator',
      );
    }
    if (node && !node.isDir) {
      items.push(
        { id: 'open', label: '열기', run: () => void store.openFile(node.path, { preview: false }) },
        { id: 'open-side', label: '옆에 열기', keybinding: 'Mod+Enter', run: () => openToSide(node.path) },
        'separator',
      );
    }
    if (node && !readonly) {
      items.push({ id: 'terminal', label: '터미널에서 열기', run: () => store.showTerminal(true, dir) });
    }
    if (node) {
      items.push({ id: 'find', label: '이 폴더에서 찾기', run: () => findInFolder(dir) }, 'separator');
    }
    if (node && !readonly) {
      items.push(
        { id: 'cut', label: '잘라내기', keybinding: 'Mod+X', run: () => store.setClipboard('cut', paths) },
        { id: 'copy', label: '복사', keybinding: 'Mod+C', run: () => store.setClipboard('copy', paths) },
      );
    }
    if (!readonly) {
      items.push({
        id: 'paste',
        label: '붙여넣기',
        keybinding: 'Mod+V',
        disabled: !clipboard,
        run: () => void store.duplicateOrPaste(dir),
      });
    }
    if (node) {
      items.push(
        'separator',
        { id: 'copy-path', label: '경로 복사', run: () => void copy(paths.join('\n')) },
        { id: 'copy-name', label: '이름 복사', run: () => void copy(paths.map(basename).join('\n')) },
      );
      if (one && !node.isDir && store.host.download) {
        items.push({ id: 'download', label: '내려받기', run: () => void store.host.download?.(node.path) });
      }
    }
    if (node && !readonly) {
      items.push(
        'separator',
        { id: 'rename', label: '이름 바꾸기', keybinding: 'F2', disabled: !one, run: () => store.startRename(node.path) },
        { id: 'delete', label: '삭제', keybinding: 'Delete', danger: true, run: () => void store.deleteEntries(paths) },
      );
    }
    while (items[items.length - 1] === 'separator') items.pop();
    return items;
  };

  const copy = async (text: string) => {
    const ok = (await store.host.copyText?.(text)) ?? (await navigator.clipboard?.writeText(text).then(() => true, () => false));
    store.notify(ok ? 'success' : 'error', ok ? '복사했습니다' : '복사하지 못했습니다');
  };

  const openToSide = (path: string) => void store.openToSide(path);

  const findInFolder = (dir: string) => {
    store.setSearch({ include: dir ? `${dir}/**` : '', showDetails: true });
    store.showSideView('search');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const idx = rows.findIndex((r) => r.node.path === selected);
    const cur = idx >= 0 ? rows[idx].node : null;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const go = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      store.select(r.node.path);
      setMulti(new Set([r.node.path]));
      anchor.current = r.node.path;
      listRef.current?.querySelector<HTMLElement>(`[data-path="${cssEscape(r.node.path)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(idx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(idx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(rows.length - 1);
    } else if (e.key === 'ArrowRight' && cur?.isDir) {
      e.preventDefault();
      if (!expanded.has(cur.path)) store.setExpanded(cur.path, true);
      else go(idx + 1);
    } else if (e.key === 'ArrowLeft' && cur) {
      e.preventDefault();
      if (cur.isDir && expanded.has(cur.path)) store.setExpanded(cur.path, false);
      else {
        const parent = dirname(cur.path);
        const pi = rows.findIndex((r) => r.node.path === parent);
        if (pi >= 0) go(pi);
      }
    } else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      if (mod && !cur.isDir) openToSide(cur.path);
      else if (cur.isDir) store.setExpanded(cur.path, !expanded.has(cur.path));
      else void store.openFile(cur.path, { preview: false });
    } else if (e.key === ' ' && cur && !cur.isDir) {
      e.preventDefault();
      void store.openFile(cur.path, { preview: true });
    } else if (e.key === 'F2' && cur && !readonly) {
      e.preventDefault();
      store.startRename(cur.path);
    } else if ((e.key === 'Delete' || (isMac && e.key === 'Backspace' && e.metaKey)) && cur && !readonly) {
      e.preventDefault();
      void store.deleteEntries(selection(cur.path));
    } else if (mod && (e.key === 'c' || e.code === 'KeyC') && cur && !readonly) {
      e.preventDefault();
      store.setClipboard('copy', selection(cur.path));
    } else if (mod && (e.key === 'x' || e.code === 'KeyX') && cur && !readonly) {
      e.preventDefault();
      store.setClipboard('cut', selection(cur.path));
    } else if (mod && (e.key === 'v' || e.code === 'KeyV') && !readonly) {
      e.preventDefault();
      void store.duplicateOrPaste(targetDirOf(selected));
    } else if (mod && (e.key === 'a' || e.code === 'KeyA')) {
      e.preventDefault();
      setMulti(new Set(rows.map((r) => r.node.path)));
    } else if (e.key === 'Escape') {
      setMulti(new Set());
      if (clipboard) store.setClipboard('copy', []);
    }
  };

  // ── 끌어 놓기 ────────────────────────────────────────────────────
  const onDragStart = (node: TreeNode, e: DragEvent) => {
    const paths = selection(node.path);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
  };
  const dropDirFor = (node: TreeNode | null) => (node ? (node.isDir ? node.path : dirname(node.path)) : '');
  const onDragOver = (node: TreeNode | null, e: DragEvent) => {
    if (readonly) return;
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(DRAG_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    setDropTarget(dropDirFor(node));
  };
  const onDrop = async (node: TreeNode | null, e: DragEvent) => {
    if (readonly) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = dropDirFor(node);
    setDropTarget(null);
    const internal = e.dataTransfer.getData(DRAG_TYPE);
    if (internal) {
      const paths = JSON.parse(internal) as string[];
      for (const p of paths) {
        if (dirname(p) === dir || isWithin(dir, p)) continue;
        await store.moveEntry(p, join(dir, basename(p)));
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const loaded = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    await store.upload(dir, loaded);
  };

  const createRow =
    creating && (creating.parent === '' || expanded.has(creating.parent)) ? (
      <div className="xide-tree-row creating" style={{ paddingLeft: indent(creating.parent ? creating.parent.split('/').length : 0) }}>
        <span className="xide-tree-chevron" />
        <FileIcon name="" isDir={creating.kind === 'dir'} />
        <InlineInput
          initial=""
          validate={(v) => {
            const bad = invalidName(v);
            if (bad) return bad;
            return store.exists(join(creating.parent, v.trim())) ? '같은 이름이 이미 있습니다' : null;
          }}
          onDone={(v) => void store.createEntry(creating.parent, v, creating.kind)}
          onCancel={() => store.cancelCreate()}
        />
      </div>
    ) : null;

  return (
    <div className="xide-side-view xide-explorer">
      <div className="xide-side-header">
        <span className="xide-side-title">탐색기</span>
        {readonly ? (
          <span className="xide-chip" title="고정된 에이전트는 보기만 합니다">
            <Icon name="lock" size={12} /> 읽기 전용
          </span>
        ) : null}
      </div>
      <div className="xide-section-header" title={agentName}>
        <span className="xide-section-title">{agentName || 'WORKSPACE'}</span>
        <span className="xide-section-actions">
          {!readonly ? (
            <>
              <IconButton icon="new-file" label="새 파일" onClick={() => store.startCreate(targetDirOf(selected), 'file')} />
              <IconButton icon="new-folder" label="새 폴더" onClick={() => store.startCreate(targetDirOf(selected), 'dir')} />
            </>
          ) : null}
          <IconButton icon="refresh" label="새로 고침" onClick={() => void store.refreshFiles()} />
          <IconButton icon="collapse" label="모두 접기" onClick={() => store.collapseAll()} />
        </span>
      </div>
      <div
        ref={listRef}
        className={`xide-tree${dropTarget === '' ? ' xide--drop-root' : ''}`}
        role="tree"
        aria-label="파일"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) showMenu(e, menuFor(null));
        }}
        onDragOver={(e) => onDragOver(null, e)}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDropTarget(null);
        }}
        onDrop={(e) => void onDrop(null, e)}
      >
        {!filesLoaded ? (
          <div className="xide-tree-note">
            <span className="xide-spinner" aria-hidden /> 불러오는 중
          </div>
        ) : null}
        {filesError ? (
          <div className="xide-tree-note xide--error" role="alert">
            <span>{filesError}</span>
            <button type="button" className="xide-link" onClick={() => store.reconnect()}>
              지금 다시 시도
            </button>
          </div>
        ) : null}
        {filesLoaded && !filesError && rows.length === 0 && !creating ? (
          <div className="xide-tree-note">
            아직 파일이 없습니다.
            {!readonly ? (
              <button type="button" className="xide-link" onClick={() => store.startCreate('', 'file')}>
                새 파일 만들기
              </button>
            ) : null}
          </div>
        ) : null}
        {creating && creating.parent === '' ? createRow : null}
        {rows.map(({ node, depth }) => (
          <TreeRowItem
            key={node.path}
            node={node}
            depth={depth}
            open={expanded.has(node.path)}
            focused={selected === node.path}
            selected={multi.has(node.path) || (multi.size === 0 && selected === node.path)}
            active={activePath === node.path}
            cut={clipboard?.mode === 'cut' && clipboard.paths.includes(node.path)}
            renaming={renaming === node.path}
            deco={node.isDir ? undefined : deco.files.get(node.path)}
            dirDeco={node.isDir ? deco.dirs.get(node.path) : undefined}
            dropping={dropTarget === node.path}
            onClick={onRowClick}
            onDoubleClick={onRowDoubleClick}
            onContextMenu={(n, e) => {
              if (!multi.has(n.path)) {
                setMulti(new Set([n.path]));
                store.select(n.path);
              }
              showMenu(e, menuFor(n));
            }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onRename={(n, v) => void store.renameEntry(n.path, v)}
            onRenameCancel={() => store.cancelRename()}
            validateRename={(n, v) => {
              const bad = invalidName(v);
              if (bad) return bad;
              const dst = join(dirname(n.path), v.trim());
              return dst !== n.path && store.exists(dst) ? '같은 이름이 이미 있습니다' : null;
            }}
            after={creating && creating.parent === node.path && node.isDir && expanded.has(node.path) ? createRow : null}
          />
        ))}
      </div>
      <FolderSection />
    </div>
  );
}

function indent(depth: number): number {
  return 8 + depth * 12;
}

const DECO_CLASS: Record<GitFileStatus, string> = {
  modified: 'xide--git-modified',
  type_changed: 'xide--git-modified',
  added: 'xide--git-added',
  untracked: 'xide--git-untracked',
  deleted: 'xide--git-deleted',
  renamed: 'xide--git-renamed',
  copied: 'xide--git-added',
  unmerged: 'xide--git-conflict',
};

interface RowProps {
  node: TreeNode;
  depth: number;
  open: boolean;
  focused: boolean;
  selected: boolean;
  active: boolean;
  cut: boolean;
  renaming: boolean;
  deco?: Decoration;
  dirDeco?: GitFileStatus;
  dropping: boolean;
  after: ReactElement | null;
  onClick: (n: TreeNode, e: MouseEvent) => void;
  onDoubleClick: (n: TreeNode) => void;
  onContextMenu: (n: TreeNode, e: MouseEvent) => void;
  onDragStart: (n: TreeNode, e: DragEvent) => void;
  onDragOver: (n: TreeNode, e: DragEvent) => void;
  onDrop: (n: TreeNode, e: DragEvent) => void;
  onRename: (n: TreeNode, v: string) => void;
  onRenameCancel: () => void;
  validateRename: (n: TreeNode, v: string) => string | null;
}

const TreeRowItem = memo(function TreeRowItem(p: RowProps) {
  const { node } = p;
  const status = p.deco?.status ?? p.dirDeco;
  const title = [
    node.path,
    !node.isDir && node.size != null ? formatBytes(node.size) : '',
    node.originName ? `마지막 변경: ${node.originName}` : '',
    p.deco ? p.deco.tooltip : '',
  ]
    .filter(Boolean)
    .join('\n');
  const dot = node.name.lastIndexOf('.');
  return (
    <>
      <div
        className={[
          'xide-tree-row',
          p.focused ? 'xide--focused' : '',
          p.selected ? 'xide--selected' : '',
          p.active ? 'xide--active' : '',
          p.cut ? 'xide--cut' : '',
          p.dropping ? 'xide--drop-target' : '',
          status ? DECO_CLASS[status] : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="treeitem"
        aria-level={p.depth + 1}
        aria-expanded={node.isDir ? p.open : undefined}
        aria-selected={p.selected}
        data-path={node.path}
        title={title}
        style={{ paddingLeft: indent(p.depth) }}
        draggable={!p.renaming}
        onClick={(e) => p.onClick(node, e)}
        onDoubleClick={() => p.onDoubleClick(node)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          p.onContextMenu(node, e);
        }}
        onDragStart={(e) => p.onDragStart(node, e)}
        onDragOver={(e) => p.onDragOver(node, e)}
        onDrop={(e) => p.onDrop(node, e)}
      >
        <span className="xide-tree-guides" style={{ width: indent(p.depth) - 8 }} />
        <span className="xide-tree-chevron">
          {node.isDir ? <Icon name={p.open ? 'chevron-down' : 'chevron-right'} /> : null}
        </span>
        <FileIcon name={node.name} isDir={node.isDir} open={p.open} />
        {p.renaming ? (
          <InlineInput
            initial={node.name}
            select={!node.isDir && dot > 0 ? [0, dot] : undefined}
            validate={(v) => p.validateRename(node, v)}
            onDone={(v) => p.onRename(node, v)}
            onCancel={p.onRenameCancel}
          />
        ) : (
          <span className="xide-tree-name">{node.name}</span>
        )}
        {p.deco ? <span className="xide-tree-deco">{p.deco.letter}</span> : null}
        {!p.deco && p.dirDeco ? (
          <span className="xide-tree-deco xide--dot" aria-hidden>
            <i />
          </span>
        ) : null}
      </div>
      {p.after}
    </>
  );
});

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
