/**
 * 끝난 턴의 작업 과정을 이 기기에 남겨 두었다가, 대화를 다시 열 때 답에 되붙인다.
 *
 * 서버 이력은 질문·답 글만 돌려준다. 작업 과정(글과 도구가 온 순서·도구 입력·결과·시각)은 그 화면이
 * 스트림으로 받은 턴에만 있어서, 대화를 나갔다 들어오면 타임라인·만든 파일·전체 로그가 사라진다.
 * 데스크톱에서 먼저 고쳤고(2026-09-16 "대화 나갔다 들어오면 다 날아가는 것 같은데"), 웹도 같은
 * 규칙으로 되붙여야 두 화면이 같은 대화를 다르게 보이지 않는다 — 그래서 여기가 정본이다.
 *
 * 짝은 **대화 id + 답 글**로 짓는다 — 공백 차이만 무시한다. 턴 번호로 짓지 않는 이유: 웹·다른 기기에서
 * 보낸 턴이 끼면 번호가 어긋나 엉뚱한 답에 과정이 붙는다. 짝이 없으면 아무것도 붙이지 않는다.
 */
import type { TimelineFlowItem } from './process-timeline';
import type { ToolEvent } from './types';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** 저장 키 — 데스크톱과 웹이 서로 다른 출처(origin)라 부딪히지 않는다. 같은 이름을 쓰는 것은 뜻이 같아서다. */
export const TURN_PROCESS_KEY = 'dex.chat.turnProcess.v1';
/** 남겨 둘 턴 수 — 오래된 것부터 버린다. */
export const TURN_PROCESS_MAX = 30;
/** 문자열 한 값(도구 입력·결과)의 최대 길이 — 긴 파일 내용을 통째로 저장소에 쌓지 않는다. */
export const TURN_PROCESS_CLIP = 8000;

/** 한 답변의 작업 과정 — 화면이 스트림에서 받은 것. */
export interface TurnProcess {
  flow: TimelineFlowItem[];
  tools?: ToolEvent[];
  /** 턴을 보낸(없으면 첫 이벤트를 받은) 시각(ms). */
  startedAt?: number;
  /** 마지막으로 글·도구 이벤트를 받은 시각(ms). */
  lastEventAt?: number;
}

interface Entry extends TurnProcess {
  conversation: string;
  sig: string;
  savedAt: number;
}

/** 답 글의 짝 표시 — 공백을 모두 걷은(NFC) 글의 길이와 FNV-1a 해시. */
export function answerSignature(text: string): string {
  const s = text.normalize('NFC').replace(/\s+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > TURN_PROCESS_CLIP ? `${value.slice(0, TURN_PROCESS_CLIP)}…` : value;
  }
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clip(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, depth + 1)]));
}

function readAll(storage: KeyValueStorage): Entry[] {
  try {
    const raw = storage.getItem(TURN_PROCESS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? (parsed as Entry[]).filter(
          (e) => e && typeof e.conversation === 'string' && typeof e.sig === 'string' && Array.isArray(e.flow),
        )
      : [];
  } catch {
    return [];
  }
}

function writeAll(storage: KeyValueStorage, entries: Entry[]): void {
  let list = entries;
  for (let attempt = 0; attempt < 4 && list.length > 0; attempt += 1) {
    try {
      storage.setItem(TURN_PROCESS_KEY, JSON.stringify(list));
      return;
    } catch {
      // 용량 초과 — 오래된 절반을 버리고 다시. 끝내 못 남기면 다시 열었을 때 과정이 없을 뿐이다
      list = list.slice(Math.ceil(list.length / 2));
    }
  }
}

/** 끝난 턴을 남긴다. 도구를 한 번도 안 쓴 턴·빈 답은 남기지 않는다(되붙일 과정이 없다). */
export function rememberTurnProcess(
  storage: KeyValueStorage | null,
  conversation: string,
  answerText: string | undefined,
  process: TurnProcess | undefined,
  now: number,
): void {
  if (!storage || !conversation || !process || !answerText?.trim()) return;
  if (!process.flow.some((item) => item.kind === 'tool')) return;
  const sig = answerSignature(answerText);
  const entry: Entry = {
    conversation,
    sig,
    savedAt: now,
    flow: clip(process.flow) as TimelineFlowItem[],
    tools: process.tools ? (clip(process.tools) as ToolEvent[]) : undefined,
    startedAt: process.startedAt,
    lastEventAt: process.lastEventAt,
  };
  const rest = readAll(storage).filter((e) => !(e.conversation === conversation && e.sig === sig));
  writeAll(storage, [...rest, entry].slice(-TURN_PROCESS_MAX));
}

/** 이 대화에서 남겨 둔 과정들 — 답 글의 짝 표시로 찾는다. 없으면 빈 지도. */
export function recallTurnProcesses(
  storage: KeyValueStorage | null,
  conversation: string,
): Map<string, TurnProcess> {
  const out = new Map<string, TurnProcess>();
  if (!storage || !conversation) return out;
  for (const e of readAll(storage)) {
    if (e.conversation !== conversation) continue;
    out.set(e.sig, { flow: e.flow, tools: e.tools, startedAt: e.startedAt, lastEventAt: e.lastEventAt });
  }
  return out;
}

/** 답 하나의 과정 — 없으면 null. 답이 여럿이면 {@link recallTurnProcesses} 로 한 번에 읽는다. */
export function recallTurnProcess(
  storage: KeyValueStorage | null,
  conversation: string,
  answerText: string,
): TurnProcess | null {
  return recallTurnProcesses(storage, conversation).get(answerSignature(answerText)) ?? null;
}

/** 브라우저의 localStorage — 없거나 막혀 있으면 null(노드 테스트·사이트 데이터 차단). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
