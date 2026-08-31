import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDirectory } from '@dex/engine';

/**
 * 터미널 UI 의 취향을 기억한다.
 *
 * 지금은 한/영 하나뿐이다. 서버 설정(config.json)과 섞지 않은 이유는 그쪽이 앱·확장과
 * 함께 쓰는 계약이기 때문이다 — 터미널에서만 뜻이 있는 값을 거기 넣으면, 그 계약을
 * 읽는 모든 곳이 이 값을 알아야 하는 것처럼 보인다.
 *
 * 읽기도 쓰기도 실패해도 조용히 넘어간다. 취향을 기억하지 못하는 것과 대화를 못 하는
 * 것은 다른 일이고, 후자를 전자 때문에 막으면 안 된다.
 */
export interface TuiPreferences {
  hangulMode: boolean;
}

export function preferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(env), 'tui.json');
}

/**
 * 아직 고른 적이 없을 때의 기본값.
 *
 * 로케일이 한국어면 한글로 시작한다. 한국어 환경에서 쓰는 사람이 매번 Ctrl+Space
 * 를 눌러야 한다면, 그 자체가 우리가 없애려던 불편이다.
 */
export function localeDefaultHangul(env: NodeJS.ProcessEnv = process.env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /^ko(_|-|\.|$)/i.test(locale.trim());
}

export async function readPreferences(env: NodeJS.ProcessEnv = process.env): Promise<TuiPreferences> {
  const fallback: TuiPreferences = { hangulMode: localeDefaultHangul(env) };
  try {
    const raw = JSON.parse(await readFile(preferencesPath(env), 'utf8')) as Record<string, unknown>;
    return typeof raw.hangulMode === 'boolean' ? { hangulMode: raw.hangulMode } : fallback;
  } catch {
    return fallback;
  }
}

export async function writePreferences(
  preferences: TuiPreferences,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const path = preferencesPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  } catch {
    // 취향을 못 적는다고 대화를 막지 않는다.
  }
}
