/**
 * 탐색기 아래 [연결된 폴더] — 이 대화에 연결한 기기의 폴더.
 *
 * 에이전트의 스토리지와 다른 곳(이 PC·이 브라우저가 허용한 폴더)이라 구분선 아래 따로 둔다.
 * 펼칠 때 한 단계씩 읽고, 파일은 편집기로 열어 고친다. 이 대화의 폴더가 다른 기기에 있으면
 * 그 기기와 폴더 이름만 보인다 — 그 기기의 파일은 그 기기에서만 연다.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { FileIcon, Icon } from './icons';
import { useIde, useStore } from './hooks';
import { IconButton, showMenu, type MenuEntry } from './primitives';
import { basename, dirname, invalidName } from '../paths';
import { folderRows, parseFolderPath, type FolderRow } from '../folders';
import { formatBytes } from '../text';

function indent(depth: number): number {
  return 8 + depth * 12;
}

export function FolderSection() {
  const store = useStore();
  const folders = useIde((s) => s.folders);
  const readonly = useIde((s) => s.readonly);
  const selected = useIde((s) => s.selected);
  const activePath = useIde((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroup);
    const t = g?.tabs.find((x) => x.id === g.activeId);
    return t && t.kind !== 'diff' ? t.path : null;
  });
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => folderRows(folders), [folders]);
  const src = store.host.folders;

  // 활성 편집기가 연결된 폴더의 파일이면 이 칸에서도 그 줄을 드러낸다.
  useEffect(() => {
    if (!activePath || !parseFolderPath(activePath)) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-path="${cssEscape(activePath)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activePath, rows.length]);

  if (!folders.available || !src) return null;
  if (!folders.roots.length && !folders.elsewhere) return null;

  const isDir = (path: string) => {
    const f = parseFolderPath(path);
    if (!f) return false;
    if (!f.rel) return true;
    return !!folders.dirs[dirname(path)]?.find((e) => e.path === path)?.isDir;
  };

  const create = async (dir: string, kind: 'file' | 'dir') => {
    const name = await store.prompt(kind === 'file' ? '새 파일 이름' : '새 폴더 이름', {
      ok: '만들기',
      validate: (v) => invalidName(v),
    });
    if (name?.trim()) await store.createFolderEntry(dir, name, kind);
  };

  const rename = async (path: string) => {
    const name = basename(path);
    const dot = name.lastIndexOf('.');
    const next = await store.prompt('새 이름', {
      value: name,
      ok: '바꾸기',
      select: !isDir(path) && dot > 0 ? [0, dot] : undefined,
      validate: (v) => invalidName(v),
    });
    if (next?.trim() && next.trim() !== name) await store.renameFolderEntry(path, next);
  };

  const copyPath = async (path: string) => {
    const text = store.copyablePath(path);
    const ok = (await store.host.copyText?.(text)) ?? (await navigator.clipboard?.writeText(text).then(() => true, () => false));
    store.notify(ok ? 'success' : 'error', ok ? '경로를 복사했습니다' : '복사하지 못했습니다');
  };

  const menuFor = (row: FolderRow): MenuEntry[] => {
    if (row.kind === 'note') return [];
    const f = parseFolderPath(row.path)!;
    const dir = isDir(row.path);
    const items: MenuEntry[] = [];
    if (!dir) {
      items.push(
        { id: 'open', label: '열기', run: () => void store.openFile(row.path, { preview: false }) },
        { id: 'open-side', label: '옆에 열기', run: () => void store.openToSide(row.path) },
        'separator',
      );
    } else if (!readonly) {
      items.push(
        { id: 'new-file', label: '새 파일', run: () => void create(row.path, 'file') },
        { id: 'new-folder', label: '새 폴더', run: () => void create(row.path, 'dir') },
        'separator',
      );
    }
    if (row.kind === 'entry' && !readonly) {
      items.push(
        { id: 'rename', label: '이름 바꾸기', run: () => void rename(row.path) },
        { id: 'delete', label: '삭제', danger: true, run: () => void store.deleteFolderEntries([row.path], isDir) },
        'separator',
      );
    }
    items.push({ id: 'copy-path', label: '경로 복사', run: () => void copyPath(row.path) });
    if (src.reveal) items.push({ id: 'reveal', label: '파일 탐색기에서 보기', run: () => src.reveal?.(f.rootId, f.rel) });
    if (dir) items.push({ id: 'refresh', label: '새로 고침', run: () => void store.loadFolderDir(row.path) });
    if (row.kind === 'root' && src.manage) {
      items.push('separator', { id: 'manage', label: '폴더 연결 관리', run: () => src.manage?.() });
    }
    return items;
  };

  const onRowClick = (row: FolderRow) => {
    if (row.kind === 'note') return;
    store.select(row.path);
    if (row.kind === 'root') {
      if (row.root.needsGrant) void store.grantFolder(row.root.id);
      else if (!row.root.missing) store.toggleFolderDir(row.path);
      return;
    }
    if (row.entry.isDir) store.toggleFolderDir(row.path);
    else void store.openFile(row.path, { preview: true });
  };

  const elsewhere = !folders.roots.length ? folders.elsewhere : null;

  return (
    <div className={`xide-folders${open ? '' : ' xide--collapsed'}`} role="region" aria-label="연결된 폴더">
      <div className="xide-section-header xide-folders-header">
        <button
          type="button"
          className="xide-folders-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? '접기' : '펼치기'}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span className="xide-section-title">연결된 폴더</span>
        </button>
        <span className="xide-section-actions">
          {folders.roots.length ? (
            <>
              <IconButton icon="refresh" label="새로 고침" onClick={() => void store.refreshFolders()} />
              <IconButton icon="collapse" label="모두 접기" onClick={() => store.collapseFolders()} />
            </>
          ) : null}
          {src.manage ? <IconButton icon="settings" label="폴더 연결 관리" onClick={() => src.manage?.()} /> : null}
        </span>
      </div>
      {open ? (
        <div ref={listRef} className="xide-tree xide-folders-tree" role="tree" aria-label="연결된 폴더">
          {elsewhere ? (
            <div className="xide-tree-note xide-folders-elsewhere">
              <span>
                이 대화의 폴더는 <strong>{elsewhere.deviceName}</strong>에 있습니다{' '}
                <span className={`xide-chip${elsewhere.online ? ' xide--on' : ''}`}>{elsewhere.online ? '켜짐' : '꺼짐'}</span>
              </span>
              {elsewhere.folders.map((name) => (
                <span key={name} className="xide-folders-remote-name">
                  <Icon name="folder" /> {name}
                </span>
              ))}
              <span>그 기기의 파일은 그 기기에서 열 수 있습니다.</span>
            </div>
          ) : null}
          {rows.map((row) =>
            row.kind === 'note' ? (
              <div
                key={row.key}
                className={`xide-folders-note${row.error ? ' xide--error' : ''}`}
                style={{ paddingLeft: indent(row.depth) + 21 }}
              >
                {row.text}
              </div>
            ) : (
              <FolderRowItem
                key={row.key}
                row={row}
                open={folders.expanded.has(row.path)}
                selected={selected === row.path}
                active={activePath === row.path}
                onClick={() => onRowClick(row)}
                onDoubleClick={() => {
                  if (row.kind === 'entry' && !row.entry.isDir) void store.openFile(row.path, { preview: false });
                }}
                onContextMenu={(e) => {
                  store.select(row.path);
                  showMenu(e, menuFor(row));
                }}
                onGrant={row.kind === 'root' && row.root.needsGrant ? () => void store.grantFolder(row.root.id) : undefined}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function FolderRowItem(p: {
  row: Extract<FolderRow, { kind: 'root' | 'entry' }>;
  open: boolean;
  selected: boolean;
  active: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onGrant?: () => void;
}) {
  const { row } = p;
  const isRoot = row.kind === 'root';
  const name = isRoot ? row.root.name : basename(row.entry.path);
  const isDir = isRoot || row.entry.isDir;
  const blocked = isRoot && (row.root.missing || row.root.needsGrant);
  const title = isRoot
    ? [row.root.name, row.root.detail ?? '', row.root.missing ? '폴더를 찾을 수 없습니다' : '', row.root.needsGrant ? '이 창에서 접근을 허용해야 쓸 수 있습니다' : '']
        .filter(Boolean)
        .join('\n')
    : [name, !row.entry.isDir && row.entry.size != null ? formatBytes(row.entry.size) : ''].filter(Boolean).join('\n');
  return (
    <div
      className={[
        'xide-tree-row',
        isRoot ? 'xide-folders-root' : '',
        p.selected ? 'xide--selected' : '',
        p.active ? 'xide--active' : '',
        blocked ? 'xide--blocked' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir && !blocked ? p.open : undefined}
      aria-selected={p.selected}
      data-path={row.path}
      title={title}
      style={{ paddingLeft: indent(row.depth) }}
      onClick={p.onClick}
      onDoubleClick={p.onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        p.onContextMenu(e);
      }}
    >
      <span className="xide-tree-chevron">{isDir && !blocked ? <Icon name={p.open ? 'chevron-down' : 'chevron-right'} /> : null}</span>
      <FileIcon name={name} isDir={isDir} open={p.open && !blocked} />
      <span className="xide-tree-name">{name}</span>
      {isRoot && row.root.missing ? <span className="xide-chip xide--warn">찾을 수 없음</span> : null}
      {p.onGrant ? (
        <button
          type="button"
          className="xide-link xide-folders-grant"
          onClick={(e) => {
            e.stopPropagation();
            p.onGrant?.();
          }}
        >
          허용
        </button>
      ) : null}
    </div>
  );
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
