/**
 * 연결된 폴더의 파일 주소 — 탐색기 아래 [연결된 폴더] 칸, 편집기 탭, 문서가 쓰는 경로.
 *
 * IDE 의 경로는 스토리지 기준이다(`a/b.txt`). 이 대화에 연결한 기기의 폴더는 스토리지가 아니라
 * 그 기기에 있으므로 같은 경로 공간에 두면 섞인다. 그래서 첫 조각이 파일 이름으로 쓸 수 없는
 * 글자(제어 문자)로 시작하는 뿌리 하나 아래에 둔다:
 *
 *     \u0001folders/<폴더 id>/<폴더 안 경로>
 *
 * `normalize`·`basename`·`dirname` 이 그대로 통하고, 스토리지 경로와는 겹칠 수 없다.
 * 화면에 이 주소를 그대로 보이지 않는다 — `displayPath` 가 `<폴더 이름>/<경로>` 로 바꾼다.
 */
import { normalize } from './paths';
import type { IdeFileEntry, IdeFolderRoot } from './types';

/** 탐색기 [연결된 폴더] 칸의 상태 가운데 줄을 그리는 데 쓰는 부분. */
export interface FolderRowsInput {
  roots: IdeFolderRoot[];
  expanded: ReadonlySet<string>;
  dirs: Readonly<Record<string, IdeFileEntry[] | null>>;
  errors: Readonly<Record<string, string>>;
}

export const FOLDER_ROOT = '\u0001folders';

export function folderPath(rootId: string, rel = ''): string {
  const r = normalize(rel);
  return r ? `${FOLDER_ROOT}/${rootId}/${r}` : `${FOLDER_ROOT}/${rootId}`;
}

export function parseFolderPath(path: string): { rootId: string; rel: string } | null {
  const p = normalize(path);
  if (!p.startsWith(`${FOLDER_ROOT}/`)) return null;
  const rest = p.slice(FOLDER_ROOT.length + 1);
  if (!rest) return null;
  const i = rest.indexOf('/');
  return i < 0 ? { rootId: rest, rel: '' } : { rootId: rest.slice(0, i), rel: rest.slice(i + 1) };
}

export function isFolderPath(path: string): boolean {
  return parseFolderPath(path) !== null;
}

/** 폴더 안의 한 단계 목록을 정렬한다 — 폴더 먼저, 이름 순(대소문자 무시). */
export function sortEntries<T extends { path: string; isDir: boolean }>(entries: readonly T[]): T[] {
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return [...entries].sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : name(a.path).localeCompare(name(b.path), undefined, { sensitivity: 'base', numeric: true }),
  );
}

export type FolderRow =
  | { kind: 'root'; key: string; path: string; root: IdeFolderRoot; depth: 0 }
  | { kind: 'entry'; key: string; path: string; entry: IdeFileEntry; depth: number }
  | { kind: 'note'; key: string; depth: number; text: string; error?: boolean };

/** 펼쳐 둔 대로 보이는 줄 — 뿌리, 그 아래 항목, 읽는 중·빈 폴더·오류 줄. */
export function folderRows(folders: FolderRowsInput): FolderRow[] {
  const rows: FolderRow[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = folders.dirs[dir];
    const error = folders.errors[dir];
    if (error) rows.push({ kind: 'note', key: `${dir}#error`, depth, text: error, error: true });
    else if (entries === null || entries === undefined) rows.push({ kind: 'note', key: `${dir}#loading`, depth, text: '불러오는 중' });
    else if (!entries.length) rows.push({ kind: 'note', key: `${dir}#empty`, depth, text: '비어 있습니다' });
    for (const entry of entries ?? []) {
      rows.push({ kind: 'entry', key: entry.path, path: entry.path, entry, depth });
      if (entry.isDir && folders.expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  for (const root of folders.roots) {
    const path = folderPath(root.id);
    rows.push({ kind: 'root', key: path, path, root, depth: 0 });
    if (folders.expanded.has(path) && !root.missing && !root.needsGrant) walk(path, 1);
  }
  return rows;
}
