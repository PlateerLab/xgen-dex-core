/**
 * 연결 폴더 검사 — 엔진(`layout.linked_folders`)과 같은 규칙을 main 에서 먼저 본다. 고를 때·저장할 때 바로 알려 주고,
 * 엔진은 턴마다 한 번 더 본다(두 겹). 두 쪽 판정이 갈리면 그 에이전트의 모든 턴이 실패하므로, 시험이 같은 경로표를
 * 두 언어에 돌려 맞댄다(`test/linked-folders.test.ts`).
 *
 * - 절대 경로만(Windows 는 `C:\…` 와 `\\서버\공유\…` 만).
 * - XD 상태 폴더(`.xd` — 데이터베이스·암호문)는 안쪽도, 그것을 **품은** 폴더(루트·홈·`/` …)도 안 된다. 심볼릭
 *   링크는 실제 경로로 보고, 대소문자를 가리지 않는 파일 시스템을 위해 같은 폴더인지(dev·ino)로도 대조한다.
 * - 없어진 폴더는 막지 않는다(`missing`) — 엔진은 그 폴더를 빼고 턴을 돌린다. 화면은 그 사실을 보여 준다.
 *
 * 모두 비동기다 — 끊긴 네트워크 드라이브의 파일 호출이 오래 걸려도 앱(main 스레드)이 멈추지 않게. 너무 오래
 * 걸리면 닿지 않는 폴더(`missing`)로 본다.
 */
import { promises as fsp } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type LinkedFolderStatus = 'ok' | 'missing' | 'relative' | 'inside_xd' | 'contains_xd';

export interface LinkedFolderCheck {
  path: string;
  status: LinkedFolderStatus;
}

/** 저장을 막는 상태 — 없어진 폴더는 막지 않는다. */
export const UNSAFE_FOLDER: ReadonlySet<LinkedFolderStatus> = new Set(['relative', 'inside_xd', 'contains_xd']);

/** 폴더 하나를 보는 데 이보다 오래 걸리면 닿지 않는 폴더로 본다. */
export const CHECK_TIMEOUT_MS = 5000;

/** Windows 의 긴 경로 접두사(`\\?\`)를 걷는다. */
const stripLongPrefix = (p: string): string =>
  p.startsWith('\\\\?\\UNC\\') ? `\\\\${p.slice(8)}` : p.startsWith('\\\\?\\') ? p.slice(4) : p;

/** 절대 경로인가 — Windows 는 드라이브(`C:\`)나 UNC(`\\서버\공유`)로 시작해야 한다(`\foo` 는 드라이브가 없다). */
export function isAbsolutePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\?]+\\[^\\]+/.test(p) : isAbsolute(p);
}

/**
 * 실제 경로 — 파이썬 `os.path.realpath`(엄격하지 않은 판)와 같은 답을 낸다. 두 쪽 판정이 같아야 하므로 그 순서를
 * 그대로 따른다.
 *
 * - POSIX: 앞에서부터 한 칸씩 — 심볼릭 링크를 만나면 그 자리에서 따라가고(끊어진 링크도 가리키는 곳으로), `..` 는
 *   따라간 뒤의 위로 간다. 없는 칸부터는 글자 그대로 붙인다.
 * - Windows: 먼저 글자로 정리(`..` 를 걷는다 — 운영체제도 그렇게 본다)한 뒤, 있는 가장 깊은 조상까지 실제 경로로.
 */
export async function realish(p: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'win32') {
    let head = resolve(p);
    const rest: string[] = [];
    for (;;) {
      try {
        return stripLongPrefix(join(await fsp.realpath(head), ...rest));
      } catch {
        const up = dirname(head);
        if (up === head) return resolve(p);
        rest.unshift(head.slice(up.length).replace(/^[\\/]/, ''));
        head = up;
      }
    }
  }
  let hops = 0;
  const walk = async (base: string, rel: string): Promise<string> => {
    let path = base;
    for (const part of rel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        path = path === '/' ? '/' : dirname(path);
        continue;
      }
      const next = path === '/' ? `/${part}` : `${path}/${part}`;
      let link: string | null = null;
      try {
        if ((await fsp.lstat(next)).isSymbolicLink()) link = await fsp.readlink(next);
      } catch {
        /* 없다 — 글자 그대로 붙인다 */
      }
      if (link === null || ++hops > 40) {
        path = next;
        continue;
      }
      path = link.startsWith('/') ? await walk('/', link) : await walk(path, link);
    }
    return path;
  };
  return walk('/', p);
}

/** `child` 가 `parent` 안(같은 곳 포함)인가 — 글자로. Windows 는 대소문자를 가리지 않는다. */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(parent), norm(child));
  if (rel === '') return true;
  // `..이름`(점 두 개로 시작하는 폴더)은 위로 가는 것이 아니다.
  return !(rel === '..' || /^\.\.[\\/]/.test(rel)) && !isAbsolute(rel);
}

/**
 * 폴더 번호(dev:ino). 번호를 주지 않는 파일 시스템(FAT·일부 네트워크 공유는 0)에서는 모른다(null) — 0 끼리 같다고
 * 보면 그 볼륨의 모든 폴더가 `.xd` 와 "같은" 폴더가 된다.
 */
async function fileId(p: string): Promise<string | null> {
  try {
    const s = await fsp.stat(p, { bigint: true });
    return s.ino ? `${s.dev}:${s.ino}` : null;
  } catch {
    return null;
  }
}

/** 글자로, 그리고 `child` 와 그 위 폴더 가운데 있는 것이 `parent` 와 같은 폴더인지로. */
async function under(child: string, parent: string): Promise<boolean> {
  if (isWithin(child, parent)) return true;
  const target = await fileId(parent);
  if (!target) return false;
  for (let p = child; ; p = dirname(p)) {
    if ((await fileId(p)) === target) return true;
    if (dirname(p) === p) return false;
  }
}

async function check(text: string, stateDir: string): Promise<LinkedFolderStatus> {
  if (!text || !isAbsolutePath(text)) return 'relative';
  const state = await realish(stateDir);
  const target = await realish(text);
  if (await under(target, state)) return 'inside_xd';
  if (await under(state, target)) return 'contains_xd';
  try {
    return (await fsp.stat(target)).isDirectory() ? 'ok' : 'missing';
  } catch {
    return 'missing';
  }
}

export async function checkLinkedFolder(path: string, stateDir: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<LinkedFolderCheck> {
  const text = stripLongPrefix(String(path ?? '').trim());
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<LinkedFolderStatus>((done) => {
    timer = setTimeout(() => done('missing'), timeoutMs);
  });
  try {
    return { path: text, status: await Promise.race([check(text, stateDir), late]) };
  } finally {
    clearTimeout(timer);
  }
}

