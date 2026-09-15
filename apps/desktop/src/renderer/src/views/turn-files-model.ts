/**
 * "이 답변에서 만든 파일" 규칙 — 답변이 도는 동안 에이전트 작업 공간에서 새로 생기거나 바뀐 파일을 고르고,
 * 그중 사용자가 요청한 결과물을 가려낸다.
 *
 * 에이전트가 파일을 만들면 답변에는 `uploads/…xlsx` 같은 경로만 글자로 남았고, 채팅에서 바로 열거나
 * 받을 길이 없었다. 반대로 바뀐 파일을 전부 늘어놓으면 중간 파일에 묻혀 받을 파일을 못 찾는다.
 *   - 무엇이 바뀌었나: 서버 파일 목록의 수정 시각과 출처(누가 썼는가)만 본다 — 도구 이름·방법 무관.
 *   - 무엇이 결과물인가: 이 턴의 요청 글·최종 답 글에 적힌 파일 이름·형식만 본다 — 박아 둔 파일 이름 없음.
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

/**
 * 요청 글에 나온 파일 형식 → 확장자. 사람이 "엑셀로 저장해 줘" 라고 말하는 방식을 옮긴 일반 사전이다
 * (특정 에이전트·시연을 알아보는 규칙이 아니다). 영어 단어는 단어 경계로만 잡는다(keyword 의 word 오인 방지).
 */
const REQUESTED_TYPES: Array<[RegExp, string[]]> = [
  [/엑셀|스프레드\s*시트|\b(excel|xlsx?|spreadsheet)\b/i, ['xlsx', 'xls']],
  [/\bcsv\b/i, ['csv']],
  [/\bjson\b/i, ['json']],
  [/\bpdf\b/i, ['pdf']],
  [/워드\s*(파일|문서)|\b(word|docx?)\b/i, ['docx', 'doc']],
  [/파워\s*포인트|슬라이드|발표\s*자료|\b(pptx?|powerpoint|slides?)\b/i, ['pptx', 'ppt']],
  [/이미지|그림|사진|차트|그래프|\b(image|png|jpe?g|svg|chart)\b/i, ['png', 'jpg', 'jpeg', 'svg', 'webp']],
  [/웹\s*페이지|\bhtml?\b/i, ['html', 'htm']],
  [/마크다운|\b(markdown|md)\b/i, ['md']],
  [/텍스트\s*파일|\btxt\b/i, ['txt']],
  [/압축|\bzip\b/i, ['zip']],
  [/한글\s*(파일|문서)|\bhwpx?\b/i, ['hwp', 'hwpx']],
];

const extOf = (name: string): string => {
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
};

/** 글에 적힌 파일 이름(확장자가 붙은 낱말). 경로가 붙어 있으면 마지막 이름만. */
const FILE_NAME_RE = /[\w가-힣.\-]+\.[A-Za-z0-9]{2,5}\b/g;

/**
 * 턴에서 바뀐 파일을 "요청한 결과물" 과 "그 외(중간 파일 등)" 로 가른다.
 *   1) 요청 글에 파일 이름이나 형식(엑셀·CSV·PDF…)이 있으면 그에 맞는 파일
 *   2) 없으면 최종 답에 이름이 나온 파일 (에이전트가 사용자에게 알린 것)
 *   3) 둘 다 없으면 결과물로 단정하지 않는다 — 전부 "그 외" 로 접어 둔다
 * 요청 글에 적힌 파일 이름의 확장자는 형식 요청으로 치지 않는다 — "a.json 을 읽어서 엑셀로" 는 엑셀 요청이다.
 */
export function splitRequestedFiles(
  files: readonly WsNode[],
  request: string,
  answer: string,
): { requested: WsNode[]; others: WsNode[] } {
  const names = new Set([...request.matchAll(FILE_NAME_RE)].map((m) => m[0].toLowerCase()));
  const prose = request.replace(FILE_NAME_RE, ' ');
  const exts = new Set(REQUESTED_TYPES.filter(([re]) => re.test(prose)).flatMap(([, e]) => e));
  let requested = files.filter((f) => names.has(f.name.toLowerCase()) || exts.has(extOf(f.name)));
  if (requested.length === 0 && answer) {
    const lower = answer.toLowerCase();
    requested = files.filter((f) => lower.includes(f.path.toLowerCase()) || lower.includes(f.name.toLowerCase()));
  }
  const picked = new Set(requested.map((f) => f.path));
  return { requested, others: files.filter((f) => !picked.has(f.path)) };
}

/** `index` 번째 답변을 부른 요청 — 그 앞의 가장 가까운 사용자 글. 없으면 빈 문자열. */
export function requestBefore(messages: readonly { role: string; text?: string }[], index: number): string {
  for (let j = index - 1; j >= 0; j -= 1) {
    if (messages[j]?.role === 'user') return messages[j].text ?? '';
  }
  return '';
}

/** 파일 이름 앞의 폴더 — 같은 이름이 여러 폴더에 있을 때 구분용. 루트면 빈 문자열. */
export function parentDir(path: string): string {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '' : path.slice(0, at);
}
