/**
 * 채팅 검색 (2026-10-10): 대화 목록 머리의 검색 단추가 여는 창이 쓴다(데스크톱·CLI·VSCode·모바일·XD).
 *
 * 서버(xgen-workflow conversation_search.py)가 정본이다. 여기 규칙은 두 자리에서 쓴다.
 *   - 서버가 없는 XD: 제 SQLite 에 든 대화를 같은 규칙으로 찾는다.
 *   - 검색 API 가 없는 옛 서버(404): 대화 목록의 제목·에이전트 이름만으로 찾는다(내용은 못 본다).
 *
 * 검색어는 띄어쓰기로 낱말을 나누고 **모든 낱말**이 들어 있어야 맞는다. 큰따옴표로 묶은 것은 한
 * 낱말(구절)이다. 대소문자는 가리지 않는다. 낱말은 대화 제목·에이전트 이름·한 턴(보낸 말 + 답)에
 * 나뉘어 있어도 된다.
 *
 * 강조는 조각(`{text, hit}`)으로 다룬다. 서버도 조각으로 보낸다: 파이썬과 자바스크립트는 이모지 같은
 * 글자의 길이를 다르게 세므로 번호로 주고받으면 어긋난다.
 */
import type {
  Conversation,
  ConversationSearchHit,
  ConversationSearchMatch,
  ConversationSearchPage,
  SearchTextPart,
} from './types';
import { parseConversation } from './conversation-list';

/** 검색어 길이 상한(서버와 같다). */
export const SEARCH_QUERY_MAX = 200;
/** 낱말 수 상한(서버와 같다). */
export const SEARCH_TERMS_MAX = 8;
/** 한 줄 조각: 맞은 자리 앞에 남길 글자 수와 전체 길이(서버와 같다). */
export const SEARCH_SNIPPET_BEFORE = 30;
export const SEARCH_SNIPPET_LEN = 120;
/** 검색어가 비었을 때 보여 줄 최근 채팅 수. */
export const SEARCH_RECENT_COUNT = 8;
/** 타자를 멈추고 이만큼 뒤에 묻는다. */
export const SEARCH_DELAY_MS = 250;

const TERM_RE = /"([^"]*)"|(\S+)/g;

/** 검색어 → 낱말들. 큰따옴표로 묶은 것은 한 낱말이다. 같은 낱말(대소문자 무시)은 한 번만. */
export function searchTerms(query: string): string[] {
  const text = String(query ?? '').slice(0, SEARCH_QUERY_MAX);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(TERM_RE)) {
    const term = (m[1] !== undefined ? m[1] : m[2] ?? '').split(/\s+/).filter(Boolean).join(' ');
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= SEARCH_TERMS_MAX) break;
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function termPattern(terms: readonly string[], global: boolean): RegExp | null {
  if (!terms.length) return null;
  // 긴 낱말부터: 겹치는 낱말("매출", "매출액")이 짧은 것에 먼저 걸려 덜 칠해지지 않게.
  const ordered = [...terms].sort((a, b) => b.length - a.length);
  return new RegExp(ordered.map(escapeRe).join('|'), global ? 'giu' : 'iu');
}

/** 글에 낱말이 있는가(대소문자 무시). */
export function searchContains(text: string, term: string): boolean {
  return !!text && new RegExp(escapeRe(term), 'iu').test(text);
}

/** 모든 낱말이 글들 어딘가에 있는가. */
export function searchCovers(texts: readonly string[], terms: readonly string[]): boolean {
  return terms.every((term) => texts.some((t) => searchContains(t, term)));
}

/** 글 → 강조 조각. 낱말이 든 자리는 hit. 빈 글이면 빈 배열. */
export function searchParts(text: string, terms: readonly string[]): SearchTextPart[] {
  if (!text) return [];
  const pattern = termPattern(terms, true);
  if (!pattern) return [{ text, hit: false }];
  const out: SearchTextPart[] = [];
  let pos = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (!m[0]) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: m[0], hit: true });
    pos = start + m[0].length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** 조각에 낱말이 든 자리가 있는가. */
export const searchHasHit = (parts: readonly SearchTextPart[] | null | undefined): boolean =>
  !!parts && parts.some((p) => p.hit);

/** 조각 → 글(강조 없이). */
export const searchPlain = (parts: readonly SearchTextPart[] | null | undefined): string =>
  (parts ?? []).map((p) => p.text).join('');

/** UTF-16 으로 자른 끝에 반쪽 글자(서로게이트)가 남지 않게. */
function trimSurrogates(s: string): string {
  let out = s;
  if (/^[\uDC00-\uDFFF]/.test(out)) out = out.slice(1);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** 긴 글에서 처음 맞은 자리 둘레를 한 줄로 잘라 조각으로. 맞은 자리가 없으면 null. */
export function searchSnippet(text: string, terms: readonly string[]): SearchTextPart[] | null {
  const flat = String(text ?? '').split(/\s+/).filter(Boolean).join(' ');
  const pattern = termPattern(terms, false);
  if (!flat || !pattern) return null;
  const first = pattern.exec(flat);
  if (!first) return null;
  let start = Math.max(0, first.index - SEARCH_SNIPPET_BEFORE);
  const end = Math.min(flat.length, start + SEARCH_SNIPPET_LEN);
  if (end - start < SEARCH_SNIPPET_LEN) start = Math.max(0, end - SEARCH_SNIPPET_LEN);
  const segments = searchParts(trimSurrogates(flat.slice(start, end)), terms);
  if (start > 0) segments.unshift({ text: '…', hit: false });
  if (end < flat.length) segments.push({ text: '…', hit: false });
  return segments;
}

/**
 * 이 턴이 검색어에 맞으면 보여 줄 조각, 아니면 null(서버 turn_match 와 같다).
 * 턴 안에 낱말이 하나는 있어야 한다. 조각은 낱말이 더 많이 든 쪽(같으면 보낸 말)에서 자른다.
 */
export function searchTurnMatch(
  title: string,
  agent: string,
  userText: string,
  answerText: string,
  terms: readonly string[],
): { snippet: SearchTextPart[] | null; snippetFrom: 'input' | 'output' } | null {
  if (!searchCovers([title, agent, userText, answerText], terms)) return null;
  const inUser = terms.filter((t) => searchContains(userText, t)).length;
  const inAnswer = terms.filter((t) => searchContains(answerText, t)).length;
  if (!inUser && !inAnswer) return null;
  const [from, text] = inUser >= inAnswer ? (['input', userText] as const) : (['output', answerText] as const);
  return { snippet: searchSnippet(text, terms), snippetFrom: from };
}

/** 제목·에이전트 이름의 강조 조각만 가진 맞음(내용 조각 없음). */
export function searchMetaMatch(title: string, agent: string, terms: readonly string[]): ConversationSearchMatch {
  return {
    title: searchParts(title, terms),
    agent: searchParts(agent, terms),
    snippet: null,
    snippetFrom: null,
    matchedAt: null,
  };
}

// ── 서버 응답 ─────────────────────────────────────────────────────

/** 서버 조각 → 조각. 모양이 틀린 것은 버린다. */
export function parseSearchParts(raw: unknown): SearchTextPart[] {
  if (!Array.isArray(raw)) return [];
  const out: SearchTextPart[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    if (typeof r.text !== 'string' || !r.text) continue;
    out.push({ text: r.text, hit: r.hit === true });
  }
  return out;
}

/** 검색 결과 한 줄 → 대화 + 맞은 자리. 대화를 가리킬 수 없는 줄은 버린다. */
export function parseConversationSearchHit(raw: unknown): ConversationSearchHit | null {
  const conversation = parseConversation(raw);
  if (!conversation) return null;
  const m = ((raw as Record<string, unknown>).match ?? {}) as Record<string, unknown>;
  const from = typeof m.snippet_from === 'string' ? m.snippet_from : '';
  const snippet = parseSearchParts(m.snippet);
  return {
    conversation,
    match: {
      title: parseSearchParts(m.title),
      agent: parseSearchParts(m.agent),
      snippet: snippet.length ? snippet : null,
      snippetFrom: from === 'input' || from === 'output' ? from : null,
      matchedAt: typeof m.matched_at === 'string' ? m.matched_at : null,
    },
  };
}

/**
 * 검색 API 가 없는 옛 서버: 대화 목록에서 제목·에이전트 이름으로만 찾는다.
 * 순서는 받은 목록 그대로(마지막으로 말한 순서)다.
 */
export function searchConversationList(
  list: readonly Conversation[],
  query: string,
  limit: number,
): ConversationSearchPage {
  const terms = searchTerms(query);
  if (!terms.length) return { query, terms, hits: [], hasMore: false, contentSearched: false };
  const hits: ConversationSearchHit[] = [];
  for (const conversation of list) {
    if (!searchCovers([conversation.title, conversation.workflowName], terms)) continue;
    hits.push({ conversation, match: searchMetaMatch(conversation.title, conversation.workflowName, terms) });
  }
  return { query, terms, hits: hits.slice(0, limit), hasMore: hits.length > limit, contentSearched: false };
}

// ── 날 ────────────────────────────────────────────────────────────

/**
 * 검색 결과 오른쪽의 날: 오늘은 시각(14:05), 어제는 "어제", 올해는 "10월 5일", 그 전은 "2025. 10. 5.".
 * `now` 는 시험이 고정한다.
 */
export function conversationDayLabel(iso: string | number | null | undefined, now: Date = new Date()): string {
  if (iso == null || iso === '') return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(when)) / 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (diff === 0) return `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  if (diff === 1) return '어제';
  if (when.getFullYear() === now.getFullYear()) return `${when.getMonth() + 1}월 ${when.getDate()}일`;
  return `${when.getFullYear()}. ${when.getMonth() + 1}. ${when.getDate()}.`;
}
