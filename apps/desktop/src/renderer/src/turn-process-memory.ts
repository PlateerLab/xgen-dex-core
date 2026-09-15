/**
 * 끝난 턴의 작업 과정을 이 PC 에 남겨 두었다가, 대화를 다시 열 때(이어보기·앱 재시작) 답에 되붙인다.
 *
 * 서버 이력은 질문·답 글만 돌려준다. 작업 과정(글과 도구가 온 순서·도구 입력·결과·시각)은 이 창이
 * 스트림으로 받은 턴에만 있어서, 대화를 나갔다 들어오면 타임라인·만든 파일·전체 로그가 사라졌다
 * (2026-09-16 사용자 지적 "대화 나갔다 들어오면 다 날아가는 것 같은데").
 *
 * 짝은 **대화 id + 답 글**로 짓는다 — 공백 차이만 무시한다. 턴 번호로 짓지 않는 이유: 웹·다른 기기에서
 * 보낸 턴이 끼면 번호가 어긋나 엉뚱한 답에 과정이 붙는다. 짝이 없으면 아무것도 붙이지 않는다.
 */
import type { ToolEvent } from '@dex/protocol';
import type { ChatMsg, FlowItem } from './session-store';

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const TURN_PROCESS_KEY = 'dex.chat.turnProcess.v1';
/** 남겨 둘 턴 수 — 오래된 것부터 버린다. */
export const TURN_PROCESS_MAX = 30;
/** 문자열 한 값(도구 입력·결과)의 최대 길이 — 긴 파일 내용을 통째로 PC 저장소에 쌓지 않는다. */
export const TURN_PROCESS_CLIP = 8000;

interface Entry {
  conversation: string;
  sig: string;
  savedAt: number;
  flow: FlowItem[];
  tools?: ToolEvent[];
  startedAt?: number;
  lastEventAt?: number;
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
  if (typeof value === 'string') return value.length > TURN_PROCESS_CLIP ? `${value.slice(0, TURN_PROCESS_CLIP)}…` : value;
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => clip(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, depth + 1)]));
}

function readAll(storage: KeyValueStorage): Entry[] {
  try {
    const raw = storage.getItem(TURN_PROCESS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? (parsed as Entry[]).filter((e) => e && typeof e.conversation === 'string' && typeof e.sig === 'string' && Array.isArray(e.flow))
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
  msg: ChatMsg | undefined,
  now: number,
): void {
  if (!storage || !conversation || !msg || msg.role !== 'assistant' || !msg.text?.trim()) return;
  if (!msg.flow?.some((item) => item.kind === 'tool')) return;
  const sig = answerSignature(msg.text);
  const entry: Entry = {
    conversation,
    sig,
    savedAt: now,
    flow: clip(msg.flow) as FlowItem[],
    tools: msg.tools ? (clip(msg.tools) as ToolEvent[]) : undefined,
    startedAt: msg.startedAt,
    lastEventAt: msg.lastEventAt,
  };
  const rest = readAll(storage).filter((e) => !(e.conversation === conversation && e.sig === sig));
  writeAll(storage, [...rest, entry].slice(-TURN_PROCESS_MAX));
}

/** 이력으로 만든 답들에 남겨 둔 과정을 되붙인다. 짝이 없거나 이미 과정이 있는 답은 그대로. */
export function attachTurnProcesses(storage: KeyValueStorage | null, conversation: string, messages: ChatMsg[]): ChatMsg[] {
  if (!storage || !conversation) return messages;
  const bySig = new Map(readAll(storage).filter((e) => e.conversation === conversation).map((e) => [e.sig, e]));
  if (bySig.size === 0) return messages;
  return messages.map((m) => {
    if (m.role !== 'assistant' || m.flow || !m.text) return m;
    const e = bySig.get(answerSignature(m.text));
    return e ? { ...m, flow: e.flow, tools: m.tools ?? e.tools, startedAt: e.startedAt, lastEventAt: e.lastEventAt } : m;
  });
}

/** 렌더러의 localStorage — 없거나 막혀 있으면 null(노드 테스트·사이트 데이터 차단). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}
