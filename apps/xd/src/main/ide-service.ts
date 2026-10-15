/**
 * 작업 공간 IDE 의 파일 — 에이전트의 작업 공간과 연결 폴더를 IDE(@dex/ide)가 바라는 모양으로. Electron 을 모른다.
 *
 * 파일 하나하나(읽기·저장·목록·옮기기·지우기)는 Dex 의 folder-fs 를 그대로 쓴다 — 폴더 밖으로 나가지 않는지(심볼릭
 * 링크를 따라가도) 확인하고, 저장은 연 판(sha)을 조건으로 건다. 여기서 더하는 것:
 *
 *   tree     작업 공간 전체를 한 줄 목록으로(탐색기·빠른 열기). 무거운 폴더(node_modules 등)는 펼치지 않고, 링크가
 *            돌아 같은 폴더를 다시 만나면 멈춘다.
 *   search   글자 찾기 — 줄마다, 편집기와 같은 단위(UTF-16 열, 첫 줄의 BOM 은 뺀다). UTF-8 이 아닌 파일은 건너뛴다.
 *   replace  찾기가 보인 그대로(줄마다·빈 일치는 건드리지 않는다) 바꾸고, 읽은 판을 조건으로 저장한다.
 *   링크     지우기·옮기기는 링크 자체에(가리키는 것을 휴지통에 보내지 않는다), 끊어진 링크로는 저장하지 않는다.
 *
 * 연결 폴더는 그 경로의 열쇠(base64url)로 연다 — 저장된 연결 폴더 가운데 하나여야 하고, 열 때마다 연결 폴더 규칙
 * (.xd 를 품은 곳 금지 등)을 다시 본다. 경로로 만든 열쇠라 다른 폴더의 연결을 끊어도 밀리지 않는다.
 */
import { promises as fsp } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Store } from './store';
import { folderFsCall, FolderFsError, FOLDER_READ_MAX, listFolder, readFolderRaw, type FolderEntry, type FolderFsDeps } from './dex';
import { checkLinkedFolder, isWithin, type LinkedFolderStatus } from './linked-folders';
import { folderId, folderOfId } from '../shared/folder-id';

/** 작업 공간 목록의 상한 — 넘으면 거기까지만 보인다. */
export const TREE_MAX = 20_000;
/** 펼치지 않는 폴더(이름만 보인다) — 의존성·캐시는 한 줄 목록을 터뜨린다. */
export const TREE_SKIP = new Set([
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.cache',
]);
/** 찾기가 읽는 파일의 상한. */
export const SEARCH_FILE_MAX = 2 * 1024 * 1024;
/** 찾기 결과의 기본 상한. */
export const SEARCH_MAX = 2000;

/** `'workspace'` 또는 연결 폴더의 열쇠(`folderId(경로)` — src/shared/folder-id.ts). */
export type IdeRoot = string;

export interface IdeFolderRootView {
  /** IDE 의 rootId — 연결 폴더 경로의 열쇠. */
  id: string;
  name: string;
  detail: string;
  missing: boolean;
  status: LinkedFolderStatus;
}

export interface IdeSearchArgs {
  query: string;
  regex?: boolean;
  case?: boolean;
  word?: boolean;
  include?: string;
  exclude?: string;
  max?: number;
}

export interface IdeSearchMatchView {
  line: number;
  col: number;
  len: number;
  preview: string;
  at: number;
}

// ── 찾기 규칙 ──────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 찾을 말 → 정규식(g). 유니코드 모드(`u`)를 먼저 쓴다 — 그래야 `.` 가 이모지를 반으로 쪼개지 않고(바꾸기가 깨진 글을
 * 쓰지 않는다) `\p{L}` 이 듣는다. 낱말 단위는 글자(한글 포함)의 경계를 본다. 유니코드 모드가 받지 않는 정규식(`\-`
 * 처럼 흔히 쓰는 것)이면 그때만 보통 모드로(낱말 단위는 `\b`). 틀린 정규식은 bad_query.
 */
export function searchRegExp(q: IdeSearchArgs): RegExp {
  if (!q.query) throw new FolderFsError('bad_query', '찾을 말이 없습니다');
  const source = q.regex ? q.query : escapeRe(q.query);
  const flags = `g${q.case ? '' : 'i'}`;
  try {
    return new RegExp(q.word ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, `${flags}u`);
  } catch {
    /* 아래 보통 모드로 */
  }
  try {
    return new RegExp(q.word ? `\\b(?:${source})\\b` : source, flags);
  } catch {
    throw new FolderFsError('bad_query', '정규식이 올바르지 않습니다');
  }
}

/** 짝 없는 서로게이트 — 보통 모드 정규식이 이모지를 쪼갰다는 표시. 그런 글은 저장하지 않는다(깨진 글자가 된다). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * 파일 거르기(쉼표로 여럿) — VS Code 처럼 `*.ts`(어디서든 그 이름), `src/**`(그 아래 전부), `**\/test/*`.
 * `/` 가 없는 무늬는 이름이나 경로의 한 칸에 맞으면 된다.
 */
export function globMatcher(spec: string | undefined): ((path: string) => boolean) | null {
  const parts = String(spec ?? '')
    .split(',')
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);
  if (!parts.length) return null;
  const toRe = (glob: string) => {
    let re = '';
    for (let i = 0; i < glob.length; i += 1) {
      const c = glob[i];
      if (c === '*' && glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else re += escapeRe(c);
    }
    return new RegExp(`^${re}(?:/.*)?$`, 'i');
  };
  const tests = parts.map((p) => {
    const re = toRe(p.replace(/\/$/, ''));
    return p.includes('/') ? (path: string) => re.test(path) : (path: string) => path.split('/').some((_, i, segs) => re.test(segs.slice(i).join('/')));
  });
  return (path) => tests.some((t) => t(path));
}

/** 바이트 → 글. UTF-8 이 아니거나 이진이면 null — 깨진 글로 바꾸어 저장하면 원래 글(예: EUC-KR)이 망가진다. */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean } | null {
  if (bytes.subarray(0, 8000).includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const bom = text.charCodeAt(0) === 0xfeff;
    return { text: bom ? text.slice(1) : text, bom };
  } catch {
    return null;
  }
}

/** 줄과 줄 끝(그대로 되살린다). */
function splitLines(text: string): Array<{ line: string; eol: string }> {
  const out: Array<{ line: string; eol: string }> = [];
  const re = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ line: m[1], eol: m[2] });
    if (!m[2]) break;
  }
  return out;
}

/** 다음 찾기 자리 — 빈 일치에서 한 글자 넘어간다. 유니코드 모드에서는 서로게이트 쌍을 통째로(아니면 제자리를 돈다). */
function step(re: RegExp, line: string, at: number): number {
  return at + (re.unicode && (line.codePointAt(at) ?? 0) > 0xffff ? 2 : 1);
}

/** 한 파일 안에서 찾기 — 줄·열(1부터, UTF-16)과 보여 줄 한 줄. 빈 일치는 세지 않는다. */
export function searchText(text: string, re: RegExp, limit: number): IdeSearchMatchView[] {
  const out: IdeSearchMatchView[] = [];
  const lines = splitLines(text);
  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const { line } = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < limit && (m = re.exec(line))) {
      if (m[0].length === 0) {
        if (m.index >= line.length) break;
        re.lastIndex = step(re, line, m.index);
        continue;
      }
      // 긴 줄은 일치 앞뒤만 보여 준다.
      const start = Math.max(0, m.index - 60);
      const preview = line.slice(start, m.index + m[0].length + 140);
      out.push({ line: i + 1, col: m.index + 1, len: m[0].length, preview, at: m.index - start });
    }
  }
  return out;
}

/** 바꿀 말의 `$` 를 푼다 — 자바스크립트 바꾸기와 같은 규칙(`$$`·`$&`·`` $` ``·`$'`·`$1`~`$99`·`$<이름>`). */
export function expand(template: string, m: RegExpExecArray, line: string): string {
  let out = '';
  const groups = m.length - 1;
  for (let i = 0; i < template.length; ) {
    const c = template[i];
    const n = template[i + 1];
    if (c !== '$' || n === undefined) {
      out += c;
      i += 1;
    } else if (n === '$') {
      out += '$';
      i += 2;
    } else if (n === '&') {
      out += m[0];
      i += 2;
    } else if (n === '`') {
      out += line.slice(0, m.index);
      i += 2;
    } else if (n === "'") {
      out += line.slice(m.index + m[0].length);
      i += 2;
    } else if (n >= '0' && n <= '9') {
      const two = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= groups) {
        out += m[Number(two)] ?? '';
        i += 3;
      } else if (Number(n) >= 1 && Number(n) <= groups) {
        out += m[Number(n)] ?? '';
        i += 2;
      } else {
        out += '$';
        i += 1;
      }
    } else if (n === '<' && m.groups) {
      const close = template.indexOf('>', i + 2);
      if (close < 0) {
        out += '$<';
        i += 2;
      } else {
        out += m.groups[template.slice(i + 2, close)] ?? '';
        i = close + 1;
      }
    } else {
      out += '$';
      i += 1;
    }
  }
  return out;
}

/** 찾기가 보인 그대로 바꾼다 — 줄마다, 빈 일치는 건드리지 않고, 줄 끝은 그대로. */
export function replaceText(text: string, re: RegExp, replacement: string, literal: boolean): { text: string; count: number } {
  let count = 0;
  const out = splitLines(text).map(({ line, eol }) => {
    let result = '';
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[0].length === 0) {
        if (m.index >= line.length) break;
        re.lastIndex = step(re, line, m.index);
        continue;
      }
      result += line.slice(last, m.index) + (literal ? replacement : expand(replacement, m, line));
      last = m.index + m[0].length;
      count += 1;
    }
    return result + line.slice(last) + eol;
  });
  return { text: out.join(''), count };
}

// ── 서비스 ────────────────────────────────────────────────────────

export interface IdeServiceDeps {
  store: Pick<Store, 'getAgent'>;
  workspaceDir: string;
  stateDir: string;
  /** 지우기 — 휴지통으로(없으면 바로 지운다). */
  trash?: FolderFsDeps['trash'];
  /** 파일 관리자로 보기. */
  reveal?: FolderFsDeps['reveal'];
}

/** 폴더 안의 상대 경로 — `..` 는 받지 않는다(folder-fs 와 같은 규칙). */
function cleanRel(rel: unknown): string {
  const parts: string[] = [];
  for (const seg of String(rel ?? '').replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw new FolderFsError('forbidden', '폴더 밖의 경로입니다');
    parts.push(seg);
  }
  return parts.join('/');
}

export class IdeService {
  /** 에이전트마다 지금 도는 찾기 — 새 찾기가 오면 앞의 것은 그만둔다(글자를 칠 때마다 찾는다). */
  private searches = new Map<string, number>();
  private searchSeq = 0;

  constructor(private readonly deps: IdeServiceDeps) {}

  /** 이 에이전트의 그 뿌리(작업 공간·연결 폴더)의 절대 경로. */
  async rootPath(agentId: string, root: IdeRoot): Promise<string> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new FolderFsError('not_found', '에이전트가 없습니다');
    if (root === 'workspace') {
      const dir = join(this.deps.workspaceDir, agent.workspace);
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    const folder = typeof root === 'string' ? folderOfId(root) : null;
    if (!folder || !agent.folders.includes(folder)) throw new FolderFsError('not_found', '연결 폴더가 없습니다');
    const check = await checkLinkedFolder(folder, this.deps.stateDir);
    if (check.status === 'missing') throw new FolderFsError('not_found', '연결 폴더를 찾을 수 없습니다');
    if (check.status !== 'ok') throw new FolderFsError('forbidden', '연결할 수 없는 폴더입니다');
    return check.path;
  }

  /** 연결 폴더 목록 — 탐색기 [연결된 폴더] 칸의 뿌리들. */
  async folders(agentId: string): Promise<IdeFolderRootView[]> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) return [];
    return Promise.all(
      agent.folders.map(async (f) => {
        const { status } = await checkLinkedFolder(f, this.deps.stateDir);
        return { id: folderId(f), name: basename(f) || f, detail: f, missing: status !== 'ok', status };
      }),
    );
  }

  async call(agentId: string, root: IdeRoot, op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const dir = await this.rootPath(agentId, root);
    switch (op) {
      case 'tree':
        return tree(dir);
      case 'search': {
        const id = ++this.searchSeq;
        this.searches.set(agentId, id);
        try {
          return await search(dir, args as unknown as IdeSearchArgs, () => this.searches.get(agentId) !== id);
        } finally {
          if (this.searches.get(agentId) === id) this.searches.delete(agentId);
        }
      }
      case 'replace':
        return replace(dir, args as unknown as IdeSearchArgs & { replacement: string; files: string[] });
      case 'fs':
        if (await this.linkOp(dir, args.op as { op: string; src?: string; dst?: string; paths?: string[] })) return null;
        break;
      case 'save':
        await refuseDanglingLink(dir, String(args.path ?? ''));
        break;
    }
    return folderFsCall(dir, op, args, { trash: this.deps.trash, reveal: this.deps.reveal });
  }

  /**
   * 지우기·옮기기 — folder-fs 는 실제 경로로 풀어 다루므로 링크를 지우면 **가리키는 것**이 휴지통으로 간다. 링크는 링크
   * 자체를 지우고(휴지통으로) 옮긴다. 여럿을 지울 때는 **모두 이 뿌리 안인지 먼저 본 뒤에** 지운다(중간에 막혀 반만
   * 지워지지 않게). 다룬 것이 있으면 true(아니면 folder-fs 로).
   */
  private async linkOp(root: string, op: { op: string; src?: string; dst?: string; paths?: string[] }): Promise<boolean> {
    if (!op || typeof op !== 'object') return false;
    const realRoot = await fsp.realpath(root);
    const locate = async (rel: string) => {
      const r = cleanRel(rel);
      if (!r) throw new FolderFsError('forbidden', '폴더 자체는 여기서 다룰 수 없습니다');
      const abs = join(root, ...r.split('/'));
      let link = false;
      try {
        link = (await fsp.lstat(abs)).isSymbolicLink();
      } catch {
        return { abs, link: false, exists: false };
      }
      // 링크는 놓인 폴더가, 아니면 실제 경로가 이 뿌리 안이어야 한다.
      const where = link ? await fsp.realpath(dirname(abs)) : await fsp.realpath(abs);
      if (!isWithin(where, realRoot)) throw new FolderFsError('forbidden', '폴더 밖의 경로입니다');
      return { abs, link, exists: true };
    };
    if (op.op === 'delete' && Array.isArray(op.paths)) {
      const paths = [...new Set(op.paths.map(String))];
      const found = await Promise.all(paths.map(locate));
      if (!found.some((f) => f.link)) return false;
      for (let i = 0; i < paths.length; i += 1) {
        const f = found[i];
        if (!f.exists) continue;
        if (f.link) await (this.deps.trash ? this.deps.trash(f.abs) : fsp.unlink(f.abs));
        else await folderFsCall(root, 'fs', { op: { op: 'delete', paths: [paths[i]] } }, { trash: this.deps.trash });
      }
      return true;
    }
    if ((op.op === 'rename' || op.op === 'copy') && typeof op.src === 'string' && typeof op.dst === 'string') {
      const src = await locate(op.src);
      if (!src.link) return false;
      if (op.op === 'copy') throw new FolderFsError('forbidden', '링크는 복사할 수 없습니다');
      const dstRel = cleanRel(op.dst);
      if (!dstRel) throw new FolderFsError('forbidden', '폴더 자체로는 옮길 수 없습니다');
      const dst = join(root, ...dstRel.split('/'));
      const parent = await fsp.realpath(dirname(dst)).catch(() => null);
      if (!parent) throw new FolderFsError('not_found', '옮길 폴더가 없습니다');
      if (!isWithin(parent, realRoot)) throw new FolderFsError('forbidden', '폴더 밖의 경로입니다');
      if (await fsp.lstat(dst).then(() => true, () => false)) throw new FolderFsError('exists', '같은 이름이 이미 있습니다');
      await fsp.rename(src.abs, dst);
      return true;
    }
    return false;
  }
}

/** 끊어진 링크로는 저장하지 않는다 — 가리키는 곳이 폴더 밖이어도 folder-fs 의 경계 검사는 링크가 놓인 폴더만 본다. */
async function refuseDanglingLink(root: string, path: string): Promise<void> {
  const rel = cleanRel(path);
  if (!rel) return;
  const abs = join(root, ...rel.split('/'));
  let link = false;
  try {
    link = (await fsp.lstat(abs)).isSymbolicLink();
  } catch {
    return;
  }
  if (link && !(await fsp.realpath(abs).then(() => true, () => false))) {
    throw new FolderFsError('forbidden', '끊어진 링크에는 저장할 수 없습니다');
  }
}

/** 작업 공간 전체를 한 줄 목록으로 — 폴더 먼저 차례로 내려간다. 무거운 폴더는 이름만, 한 번 본 폴더는 다시 안 들어간다. */
export async function tree(root: string, max = TREE_MAX): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  const queue: string[] = [''];
  const seen = new Set<string>();
  while (queue.length && out.length < max) {
    const dir = queue.shift()!;
    try {
      const real = await fsp.realpath(dir ? join(root, ...dir.split('/')) : root);
      if (seen.has(real)) continue; // 링크가 돌아 같은 폴더
      seen.add(real);
    } catch {
      continue;
    }
    let entries: FolderEntry[];
    try {
      entries = await listFolder(root, dir);
    } catch {
      continue; // 밖으로 가는 링크·그사이 지워진 폴더 — 건너뛴다
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.path.localeCompare(b.path));
    for (const e of entries) {
      if (out.length >= max) break;
      out.push(e);
      const name = e.path.split('/').pop() ?? '';
      if (e.isDir && !TREE_SKIP.has(name)) queue.push(e.path);
    }
  }
  return out;
}

export async function search(root: string, q: IdeSearchArgs, stale: () => boolean = () => false) {
  const re = searchRegExp(q);
  const include = globMatcher(q.include);
  const exclude = globMatcher(q.exclude);
  const max = Math.min(Math.max(1, q.max ?? SEARCH_MAX), 10_000);
  const files: { path: string; matches: IdeSearchMatchView[] }[] = [];
  let total = 0;
  let truncated = false;
  for (const e of await tree(root)) {
    if (stale()) return { files, total, truncated: true };
    if (e.isDir || (e.size ?? 0) > SEARCH_FILE_MAX) continue;
    if (include && !include(e.path)) continue;
    if (exclude?.(e.path)) continue;
    if (total >= max) {
      truncated = true;
      break;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFolderRaw(root, e.path);
    } catch {
      continue;
    }
    const decoded = bytes.length <= SEARCH_FILE_MAX ? decodeText(bytes) : null;
    if (!decoded) continue;
    const matches = searchText(decoded.text, re, max - total);
    if (!matches.length) continue;
    files.push({ path: e.path, matches });
    total += matches.length;
  }
  return { files, total, truncated };
}

export async function replace(root: string, q: IdeSearchArgs & { replacement: string; files: string[] }) {
  const re = searchRegExp(q);
  const changed: { path: string; count: number }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const path of Array.isArray(q.files) ? q.files.map(String) : []) {
    let read: { bytes: Uint8Array; sha: string };
    try {
      read = (await folderFsCall(root, 'read', { path })) as { bytes: Uint8Array; sha: string };
    } catch {
      skipped.push({ path, reason: 'unreadable' });
      continue;
    }
    const decoded = decodeText(read.bytes);
    if (!decoded) {
      skipped.push({ path, reason: 'not_text' });
      continue;
    }
    const { text, count } = replaceText(decoded.text, re, String(q.replacement ?? ''), !q.regex);
    if (!count) continue;
    if (LONE_SURROGATE.test(text) && !LONE_SURROGATE.test(decoded.text)) {
      skipped.push({ path, reason: 'broken_text' });
      continue;
    }
    const bytes = new Uint8Array(Buffer.from((decoded.bom ? '﻿' : '') + text, 'utf8'));
    if (bytes.length > FOLDER_READ_MAX) {
      skipped.push({ path, reason: 'too_large' });
      continue;
    }
    try {
      // 읽은 판을 조건으로 — 그사이 에이전트가 고쳤으면 덮어쓰지 않는다.
      await folderFsCall(root, 'save', { path, bytes, baseSha: read.sha });
      changed.push({ path, count });
    } catch (err) {
      skipped.push({ path, reason: err instanceof FolderFsError ? err.code : 'error' });
    }
  }
  return { changed, skipped };
}
