/**
 * 작업 과정 타임라인의 순수 규칙 — 무엇을 한 단계로 묶고, 도구 카드에 무엇이라고 쓰고, 결과를 어떤 모양으로 보여 줄지.
 *
 * **특정 에이전트·도구·서비스를 이름으로 알아보지 않는다.** 이 화면은 어떤 에이전트의 어떤 도구에도 같은
 * 규칙으로 동작해야 한다.
 *   · 도구 이름표: XGeny 기본 도구(셸·파일·검색·웹)만 사람 말로 바꾼다. 나머지(MCP·API·커넥터 도구)는
 *     등록된 도구 설명의 첫 마디(있으면)나 도구 이름에 인자 두 개를 붙인다.
 *   · 셸 명령: 명령 내용으로 목적을 짐작하지 않는다 — 언어·줄 수·불러온 모듈까지만.
 *   · 결과: JSON 이면 모양으로 그린다(객체 목록 → 작은 표, 이름·제목이 있는 객체 → 카드, 그 밖 → 키·값).
 *     JSON 이 아니면 첫 줄.
 * 렌더와 타이머는 ProcessTimeline.tsx 에 있다.
 */
import type { ToolEvent } from '@dex/protocol';
import { shortToolName, toolCallId, toolPhase, type ToolPhase } from '@dex/protocol/tool-activity';

/** session-store 의 FlowItem 과 같은 모양 — 모델이 스토어(와 그 의존성)를 끌어오지 않도록 여기서 받는다. */
export type TimelineFlowItem =
  | { kind: 'text'; text: string; at: number }
  | { kind: 'tool'; event: ToolEvent; at: number };

/** 도구 호출 한 건. */
export interface TimelineRow {
  key: string;
  name: string;
  input: unknown;
  result?: string;
  error?: string;
  phase: ToolPhase;
  durationMs?: number;
  /** 이 호출의 첫 이벤트를 받은 시각(ms) — 실행 중 경과 시간. */
  startedAt: number;
}

/** 진행 문장 하나와 그 뒤에 이어 부른 도구들. */
export interface TimelineStep {
  text: string;
  rows: TimelineRow[];
}

/** flow → 단계들. 텍스트는 도구가 한 번이라도 끼어든 뒤에 오면 새 단계를 연다. 호출은 id(없으면 이름)로 짝을 맞춘다. */
export function buildSteps(flow: readonly TimelineFlowItem[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const rows: TimelineRow[] = [];
  const byId = new Map<string, TimelineRow>();
  let cur: TimelineStep | null = null;
  let toolSinceText = true;
  for (const item of flow) {
    if (item.kind === 'text') {
      if (!cur || toolSinceText) {
        cur = { text: '', rows: [] };
        steps.push(cur);
        toolSinceText = false;
      }
      cur.text += item.text;
      continue;
    }
    const e = item.event;
    if (!cur) {
      cur = { text: '', rows: [] };
      steps.push(cur);
    }
    toolSinceText = true;
    const id = toolCallId(e);
    const name = typeof e.toolName === 'string' ? e.toolName : '';
    const tone = toolPhase(e).tone;
    let row = id !== undefined ? byId.get(id) : undefined;
    if (!row && (tone !== 'run' || e.eventType === 'tool_start')) {
      row = rows.find((r) => r.phase === 'run' && r.name === name);
    }
    if (!row) {
      row = { key: id ?? `#${rows.length + 1}`, name, input: undefined, phase: 'run', startedAt: item.at };
      rows.push(row);
      cur.rows.push(row);
      if (id !== undefined) byId.set(id, row);
    }
    if (row.input === undefined && e.toolInput !== undefined) row.input = e.toolInput;
    if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs)) row.durationMs = e.durationMs;
    if (e.result !== undefined) row.result = String(e.result);
    if (e.error) row.error = String(e.error);
    if (tone !== 'run' && row.phase !== 'err') row.phase = tone;
  }
  return steps;
}

/** 단계 글의 첫 문단(단계 제목)과 나머지(본문). */
export function splitFirstParagraph(text: string): { title: string; body: string } {
  const s = text.replace(/^\s+/, '');
  const at = s.indexOf('\n\n');
  return at < 0 ? { title: s.trim(), body: '' } : { title: s.slice(0, at).trim(), body: s.slice(at + 2) };
}

export type ToolIcon = 'terminal' | 'package' | 'search' | 'file' | 'edit' | 'web' | 'list' | 'external';

export function parseToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === 'string') {
    try {
      const v = JSON.parse(input);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }
  return {};
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const workspaceTail = (p: string): string => p.split('/workspace/').pop() ?? p;

/** 셸 명령 요약 — 한 줄이면 명령 그대로, 여러 줄이면 언어 · 줄 수 · 불러온 모듈. */
export function summarizeCommand(command: string): string {
  const cmd = command.trim();
  if (!cmd) return '명령 실행';
  const lines = cmd.split('\n');
  if (lines.length === 1) return clip(cmd, 100);
  const head = lines[0];
  const lang = /\bpython3?\b/.test(head) ? '파이썬' : /\b(node|deno|bun)\b/.test(head) ? '자바스크립트' : '셸';
  const mods: string[] = [];
  if (lang === '파이썬') {
    for (const line of lines) {
      const imp = line.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
      const from = line.match(/^\s*from\s+([\w.]+)\s+import\b/);
      const names = imp ? imp[1].split(',') : from ? [from[1]] : [];
      for (const n of names) {
        const top = n.trim().split('.')[0];
        if (top && !mods.includes(top)) mods.push(top);
      }
    }
  }
  const modText = mods.length ? ` · ${mods.slice(0, 4).join(', ')}${mods.length > 4 ? ' 외' : ''}` : '';
  return `${lang} 스크립트 ${lines.length}줄${modText}`;
}

/** 인자 요약 — 짧은 값 `max` 개까지 `키 값`. 객체·배열·참거짓(대개 옵션 스위치) 인자는 건너뛴다. */
export function summarizeArgs(input: Record<string, unknown>, max = 2): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || typeof v === 'object' || typeof v === 'boolean') continue;
    const s = String(v).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    parts.push(`${k} ${clip(s, 40)}`);
    if (parts.length >= max) break;
  }
  return parts.join(', ');
}

/** 도구 설명의 첫 마디 — 카드 한 줄에 들어갈 만큼만. */
export function descriptionHeadline(description: string | undefined): string {
  const d = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!d) return '';
  const first = d.split(/(?<=[.!?。])\s/)[0] ?? d;
  return clip(first.replace(/[.。]$/, ''), 48);
}

/** 도구 카드 한 줄. `description` 은 에이전트에 등록된 도구 설명(모르면 비움). */
export function describeTool(name: string, rawInput: unknown, description?: string): { icon: ToolIcon; text: string } {
  const input = parseToolInput(rawInput);
  const short = shortToolName(name);
  const str = (...keys: string[]): string => {
    for (const k of keys) if (typeof input[k] === 'string' && (input[k] as string).trim()) return input[k] as string;
    return '';
  };
  switch (short) {
    case 'Bash':
      return { icon: 'terminal', text: summarizeCommand(str('command')) };
    case 'PythonEnv': {
      const pkgs = Array.isArray(input.packages) ? (input.packages as unknown[]).join(', ') : '';
      return { icon: 'package', text: `파이썬 패키지 준비${pkgs ? ` · ${clip(pkgs, 60)}` : ''}` };
    }
    case 'Glob':
      return { icon: 'search', text: `파일 찾기 · ${str('pattern')}` };
    case 'Grep':
      return { icon: 'search', text: `내용 찾기 · ${str('pattern')}` };
    case 'ToolSearch':
      return { icon: 'search', text: `사용할 도구 찾기 · ${str('query')}` };
    case 'Read':
      return { icon: 'file', text: `파일 읽기 · ${workspaceTail(str('file_path', 'path'))}` };
    case 'Write':
      return { icon: 'edit', text: `파일 쓰기 · ${workspaceTail(str('file_path', 'path'))}` };
    case 'Edit':
    case 'MultiEdit':
      return { icon: 'edit', text: `파일 수정 · ${workspaceTail(str('file_path', 'path'))}` };
    case 'WebFetch':
      return { icon: 'web', text: `웹 페이지 열기 · ${clip(str('url'), 60)}` };
    case 'WebSearch':
      return { icon: 'web', text: `웹 검색 · ${str('query')}` };
    case 'TodoWrite':
      return { icon: 'list', text: '할 일 목록 갱신' };
    default: {
      const label = descriptionHeadline(description) || short;
      const args = summarizeArgs(input);
      return { icon: 'external', text: args ? `${label} · ${args}` : label };
    }
  }
}

/** 결과를 보여 줄 모양. 비어 있는 칸은 그리지 않는다. */
export interface ResultView {
  /** 이름·제목이 있는 객체 → 카드 제목. */
  title?: string;
  /** 짧은 값 `[키, 값]`. */
  fields: Array<[string, string]>;
  /** 참/거짓 값 `[키, 값]`. */
  flags: Array<[string, boolean]>;
  /** 객체 목록 → 작은 표 (앞 5행). */
  table?: { columns: string[]; rows: string[][]; more: number };
  /** JSON 이 아니면 첫 줄. */
  line?: string;
}

const TITLE_KEYS = ['title', 'name', 'display_name', 'displayName', 'label', 'subject', 'headline'];
const TABLE_ROWS = 5;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalarText = (v: unknown): string | null =>
  typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), 60) : typeof v === 'number' ? String(v) : null;

function titleOf(o: Record<string, unknown>): [string, string] | null {
  for (const k of TITLE_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return [k, v.trim()];
  }
  return null;
}

function collect(
  o: Record<string, unknown>,
  skip: ReadonlySet<string>,
  view: ResultView,
  maxFields: number,
): void {
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k)) continue;
    if (typeof v === 'boolean') {
      if (view.flags.length < 4) view.flags.push([k, v]);
      continue;
    }
    const s = scalarText(v);
    if (s && view.fields.length < maxFields) view.fields.push([k, s]);
  }
}

function tableOf(items: Record<string, unknown>[]): NonNullable<ResultView['table']> {
  const first = items[0];
  const keys = Object.keys(first).filter((k) => typeof first[k] === 'string' || typeof first[k] === 'number');
  const t = titleOf(first)?.[0];
  const columns = (t ? [t, ...keys.filter((k) => k !== t)] : keys).slice(0, 4);
  return {
    columns,
    rows: items.slice(0, TABLE_ROWS).map((r) => columns.map((c) => scalarText(r[c]) ?? '')),
    more: Math.max(0, items.length - TABLE_ROWS),
  };
}

function jsonView(v: unknown): ResultView {
  const view: ResultView = { fields: [], flags: [] };
  if (Array.isArray(v)) {
    const objs = v.filter(isPlainObject);
    if (objs.length) view.table = tableOf(objs);
    else view.line = clip(JSON.stringify(v), 160);
    return view;
  }
  if (!isPlainObject(v)) {
    view.line = clip(String(v), 160);
    return view;
  }
  const keys = Object.keys(v);
  const listKey = keys.find((k) => Array.isArray(v[k]) && (v[k] as unknown[]).some(isPlainObject));
  const own = titleOf(v);
  const entityKey = own ? undefined : keys.find((k) => isPlainObject(v[k]) && titleOf(v[k] as Record<string, unknown>));
  if (own) {
    view.title = own[1];
    collect(v, new Set([own[0], ...(listKey ? [listKey] : [])]), view, 3);
  } else if (entityKey) {
    const entity = v[entityKey] as Record<string, unknown>;
    const t = titleOf(entity) as [string, string];
    view.title = t[1];
    collect(entity, new Set([t[0]]), view, 3);
    // 바깥의 참/거짓(찾았는가 등)은 카드 옆에 함께 보인다
    collect(v, new Set([entityKey, ...(listKey ? [listKey] : [])]), view, view.fields.length);
  } else {
    collect(v, new Set(listKey ? [listKey] : []), view, listKey ? 3 : 6);
  }
  if (listKey) view.table = tableOf((v[listKey] as unknown[]).filter(isPlainObject));
  if (!view.title && !view.table && !view.fields.length && !view.flags.length) {
    view.line = clip(JSON.stringify(v), 160);
  }
  return view;
}

/** 도구 결과(글) → 보여 줄 모양. 결과가 없으면 null. 잘린 JSON 은 글로 다룬다. */
export function resultView(result: string | undefined): ResultView | null {
  const raw = (result ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return jsonView(JSON.parse(raw));
    } catch {
      // 서버가 4000자에서 자른 JSON — 아래에서 첫 줄로
    }
  }
  const lines = raw.split('\n').map((l) => l.trim().replace(/^\d+\s+/, '')).filter((l) => l.length >= 2);
  const first = lines[0] ?? raw.split('\n')[0].trim();
  const count = raw.split('\n').length;
  return { fields: [], flags: [], line: `${clip(first, 140)}${count > 1 ? ` · ${count}줄` : ''}` };
}
