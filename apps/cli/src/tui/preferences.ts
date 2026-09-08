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
/**
 * 마지막으로 보던 대화.
 *
 * 서버 실행은 연결이 아니라 **대화**에 매여 있다 — 터미널을 닫아도(종료 신호가
 * 아니다) 턴은 계속 돈다. 그 대화를 다시 열어야 [진행 중]과 정지가 돌아오는데,
 * CLI 는 매번 새 프로세스라 기억해 둘 자리가 없으면 되찾을 방법이 없다.
 */
export interface LastChat {
  workflowId: string;
  workflowName: string;
  interactionId: string;
}

export interface TuiPreferences {
  hangulMode: boolean;
  lastChat?: LastChat;
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

function cleanLastChat(raw: unknown): LastChat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const workflowId = typeof value.workflowId === 'string' ? value.workflowId : '';
  const interactionId = typeof value.interactionId === 'string' ? value.interactionId : '';
  if (!workflowId || !interactionId) return undefined;
  const workflowName = typeof value.workflowName === 'string' ? value.workflowName : workflowId;
  return { workflowId, workflowName, interactionId };
}

export async function readPreferences(env: NodeJS.ProcessEnv = process.env): Promise<TuiPreferences> {
  const fallback: TuiPreferences = { hangulMode: localeDefaultHangul(env) };
  try {
    const raw = JSON.parse(await readFile(preferencesPath(env), 'utf8')) as Record<string, unknown>;
    return {
      hangulMode: typeof raw.hangulMode === 'boolean' ? raw.hangulMode : fallback.hangulMode,
      ...(cleanLastChat(raw.lastChat) ? { lastChat: cleanLastChat(raw.lastChat) } : {}),
    };
  } catch {
    return fallback;
  }
}

/**
 * 준 값만 고쳐 쓴다.
 *
 * 통째로 덮어쓰면 한/영을 토글하는 순간 마지막 대화 기록이 함께 지워진다 —
 * 서로 아무 관계 없는 두 값이 같은 파일에 산다는 이유만으로.
 */
export async function writePreferences(
  patch: Partial<TuiPreferences>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const path = preferencesPath(env);
    const current = await readPreferences(env);
    const next: TuiPreferences = { ...current, ...patch };
    if ('lastChat' in patch && !patch.lastChat) delete next.lastChat;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // 취향을 못 적는다고 대화를 막지 않는다.
  }
}
