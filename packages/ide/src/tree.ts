/**
 * 스토리지 목록(평면) → 탐색기 트리.
 *
 * 스토리지는 폴더를 따로 적어 두기도 하고(빈 폴더), 파일 경로로만 알게 하기도 한다(에이전트가
 * 만든 `src/a/b.py` 의 `src`·`src/a`). 둘 다 폴더로 보여야 하므로 파일 경로의 조상을 폴더로
 * 채운다. 정렬은 편집기와 같다: 폴더 먼저, 이름은 대소문자 없이 숫자를 숫자로.
 */
import type { IdeFileEntry } from './types';
import { basename, dirname } from './paths';

export interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size?: number | null;
  modifiedAt?: string | null;
  originName?: string | null;
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a: string, b: string): number {
  const c = collator.compare(a, b);
  return c !== 0 ? c : a < b ? -1 : a > b ? 1 : 0;
}

export function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : compareNames(a.name, b.name)));
}

export function buildTree(entries: IdeFileEntry[]): TreeNode {
  const root: TreeNode = { path: '', name: '', isDir: true, children: [] };
  const byPath = new Map<string, TreeNode>([['', root]]);

  const ensureDir = (path: string): TreeNode => {
    const hit = byPath.get(path);
    if (hit) {
      hit.isDir = true;
      return hit;
    }
    const parent = ensureDir(dirname(path));
    const node: TreeNode = { path, name: basename(path), isDir: true, children: [] };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const e of entries) {
    const path = String(e.path || '').replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    if (e.isDir) {
      const node = ensureDir(path);
      node.modifiedAt = e.modifiedAt ?? node.modifiedAt;
      node.originName = e.originName ?? node.originName;
      continue;
    }
    if (byPath.has(path)) continue;
    const parent = ensureDir(dirname(path));
    const node: TreeNode = {
      path,
      name: basename(path),
      isDir: false,
      size: e.size,
      modifiedAt: e.modifiedAt,
      originName: e.originName,
      children: [],
    };
    byPath.set(path, node);
    parent.children.push(node);
  }
  const sortAll = (n: TreeNode) => {
    sortNodes(n.children);
    n.children.forEach(sortAll);
  };
  sortAll(root);
  return root;
}

/** 펼친 폴더만 따라 내려가며 보이는 줄들 — 가상 스크롤 없이도 키보드 이동에 쓴다. */
export function visibleRows(
  root: TreeNode,
  expanded: ReadonlySet<string>,
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  const walk = (n: TreeNode, depth: number) => {
    for (const c of n.children) {
      out.push({ node: c, depth });
      if (c.isDir && expanded.has(c.path)) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 모든 파일 경로(빠른 열기용). */
export function filePaths(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children) {
      if (c.isDir) walk(c);
      else out.push(c.path);
    }
  };
  walk(root);
  return out;
}

export function findNode(root: TreeNode, path: string): TreeNode | null {
  if (!path) return root;
  let cur: TreeNode | undefined = root;
  const parts = path.split('/');
  for (let i = 0; i < parts.length && cur; i += 1) {
    const want = parts.slice(0, i + 1).join('/');
    cur = cur.children.find((c) => c.path === want);
  }
  return cur ?? null;
}

/** 경로의 조상 폴더들(자신 제외) — 파일을 드러낼 때 펼칠 것. */
export function ancestors(path: string): string[] {
  const out: string[] = [];
  let d = dirname(path);
  while (d) {
    out.unshift(d);
    d = dirname(d);
  }
  return out;
}
