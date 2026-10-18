/**
 * 설치된 앱 찾기(macOS) — 앱 이름 → 번들. 데스크탑 앱 도구(apps/desktop desktop-tools.ts)가 "PowerPoint 열어줘" 의
 * 대상을 찾을 때 쓴다. 파일을 읽지 않고 앱 폴더의 번들 이름만 본다. 순수 함수로 두어 단위 테스트한다.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';

export interface InstalledApp {
  /** 번들 이름에서 `.app` 을 뗀 것 — "Microsoft PowerPoint". */
  name: string;
  path: string;
  /** 사용자 언어로 보이는 이름이 번들 이름과 다르면 — "계산기"(Calculator). 채우는 쪽은 apps/desktop(Spotlight). */
  displayName?: string;
}

/** 앱 번들을 찾는 폴더 — 앞쪽이 이긴다(같은 이름이면 /Applications 의 것). */
export function appSearchDirs(home = homedir()): string[] {
  return [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    pathJoin(home, 'Applications'),
  ];
}

/** 위 폴더 밖에 있지만 사람이 "앱"으로 부르는 것. */
const EXTRA_APPS = ['/System/Library/CoreServices/Finder.app'];

/** 설치된 앱 목록. 읽지 못하는 폴더는 건너뛴다. */
export async function listInstalledApps(
  dirs: string[] = appSearchDirs(),
  readDir: (dir: string) => Promise<string[]> = (dir) => readdir(dir),
  extra: string[] = EXTRA_APPS,
): Promise<InstalledApp[]> {
  const out: InstalledApp[] = [];
  const seen = new Set<string>();
  const add = (path: string, file: string) => {
    const name = file.replace(/\.app$/i, '');
    const key = normalizeAppName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name, path });
  };
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readDir(dir);
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (/\.app$/i.test(file) && !file.startsWith('.')) add(pathJoin(dir, file), file);
    }
  }
  for (const path of extra) add(path, path.split('/').pop() ?? '');
  return out;
}

/** 비교용 이름 — 대소문자·공백·문장부호·끝의 ".app"/"앱" 을 무시한다. */
export function normalizeAppName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/\.app$/i, '')
    .replace(/\s*앱$/, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export type AppMatch<T> = { kind: 'one'; app: T } | { kind: 'many'; apps: T[] } | { kind: 'none' };

/**
 * 요청한 이름 → 앱. 앱마다 이름이 여럿일 수 있다(실행 중인 앱은 "카카오톡"·"KakaoTalk"). 이름이 같으면 그것,
 * 아니면 이름을 **포함하는** 앱이 하나일 때 그것("PowerPoint" → "Microsoft PowerPoint"). 여럿이면 고르게 돌려주고,
 * 없으면 none — 약어("PPT")는 에이전트가 앱 목록을 보고 다시 부른다.
 */
export function matchApp<T>(query: string, apps: T[], namesOf: (app: T) => string[]): AppMatch<T> {
  const q = normalizeAppName(query);
  if (!q) return { kind: 'none' };
  const keys = (a: T) => namesOf(a).map(normalizeAppName).filter(Boolean);
  const exact = apps.find((a) => keys(a).includes(q));
  if (exact) return { kind: 'one', app: exact };
  const partial = apps.filter((a) => keys(a).some((k) => k.includes(q)));
  if (partial.length === 1) return { kind: 'one', app: partial[0] };
  if (partial.length > 1) return { kind: 'many', apps: partial };
  return { kind: 'none' };
}
