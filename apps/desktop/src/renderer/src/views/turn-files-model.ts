/**
 * "이 답변에서 만든 파일" 규칙 — 답변이 도는 동안 에이전트 작업 공간에서 새로 생기거나 바뀐 파일을 고른다.
 *
 * 에이전트가 파일을 만들면 답변에는 `uploads/…xlsx` 같은 경로만 글자로 남았고, 채팅에서 바로 열거나
 * 받을 길이 없었다. 파일 이름·확장자·도구 이름으로 짐작하지 않는다 — 서버 파일 목록의 수정 시각과
 * 출처(누가 썼는가)만 본다. 그래서 어떤 에이전트가 어떤 방법(Bash·Write·API 도구)으로 만들었든 같게 동작한다.
 */
import type { WsNode } from '@dex/protocol';

/** 서버와 이 PC 시계가 조금 어긋나도 놓치지 않을 여유. */
export const TURN_FILE_SLACK_BEFORE_MS = 90_000;
export const TURN_FILE_SLACK_AFTER_MS = 120_000;

/** 사용자가 올린 파일의 출처 — 답변이 만든 것이 아니다. */
const USER_ORIGINS = new Set(['web', 'user', 'upload']);

const hidden = (path: string): boolean => path.split('/').some((seg) => seg.startsWith('.'));

/**
 * 턴 동안 바뀐 파일. `startedAt`·`endedAt` 은 이 PC 시계(ms), 노드의 `modified_at` 은 서버 시각(ISO).
 * 폴더·숨김 경로·사용자 업로드는 뺀다. 경로 순으로 돌려준다.
 */
export function filesChangedDuringTurn(nodes: readonly WsNode[], startedAt: number, endedAt: number): WsNode[] {
  const from = startedAt - TURN_FILE_SLACK_BEFORE_MS;
  const to = endedAt + TURN_FILE_SLACK_AFTER_MS;
  const seen = new Set<string>();
  const out: WsNode[] = [];
  for (const n of nodes) {
    if (!n || n.is_dir || !n.path || seen.has(n.path) || hidden(n.path)) continue;
    if (n.origin && USER_ORIGINS.has(n.origin)) continue;
    const at = n.modified_at ? Date.parse(n.modified_at) : NaN;
    if (!Number.isFinite(at) || at < from || at > to) continue;
    seen.add(n.path);
    out.push(n);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 파일 이름 앞의 폴더 — 같은 이름이 여러 폴더에 있을 때 구분용. 루트면 빈 문자열. */
export function parentDir(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '' : path.slice(0, at);
}
