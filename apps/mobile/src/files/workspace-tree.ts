/**
 * 에이전트 [스토리지] 를 폴더 한 단계씩 넘기는 규칙 — 폰은 나무를 다 펼치기보다 폴더로 들어가고 나오는 쪽이
 * 손에 맞는다. 서버 목록은 평평하다(파일·폴더 각각 한 줄, workspace 기준 경로).
 */
import type { WsNode } from '@dex/protocol';

export interface FolderEntry {
  path: string;
  name: string;
  isDir: boolean;
  size?: number | null;
  modifiedAt?: string;
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

function clean(path: string): string {
  return String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** `dir` 바로 아래 항목 — 폴더 먼저, 이름 순. 목록에 폴더 줄이 없어도 파일 경로로 폴더를 세운다. */
export function folderEntries(files: readonly WsNode[], dir: string): FolderEntry[] {
  const base = clean(dir);
  const prefix = base ? `${base}/` : '';
  const out = new Map<string, FolderEntry>();
  for (const f of files) {
    const path = clean(f.path);
    if (!path || (prefix && !path.startsWith(prefix))) continue;
    const rest = path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash >= 0) {
      const name = rest.slice(0, slash);
      const child = prefix + name;
      if (!out.has(child)) out.set(child, { path: child, name, isDir: true });
      continue;
    }
    const existing = out.get(path);
    if (existing && existing.isDir) continue;
    out.set(path, {
      path,
      name: rest,
      isDir: !!f.is_dir,
      size: f.is_dir ? undefined : f.size,
      modifiedAt: f.modified_at,
    });
  }
  return [...out.values()].sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name)));
}

/** 이 폴더까지의 길 — [스토리지] › uploads › users_130 */
export function folderTrail(dir: string): { name: string; path: string }[] {
  const parts = clean(dir).split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

export function parentOf(dir: string): string {
  const parts = clean(dir).split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}
