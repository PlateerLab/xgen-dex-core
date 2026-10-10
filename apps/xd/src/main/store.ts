/**
 * XD 저장소 — `<루트>/.xd/xd.db` (SQLite, Electron 내장 `node:sqlite`. 네이티브 모듈 없음).
 *
 * 에이전트·대화·턴·제공자 계정(비밀 아닌 설정)·앱 설정. 비밀(API 키)은 여기 없다 — secrets.ts.
 * 마이그레이션은 앞으로만 간다(`PRAGMA user_version`). 설계: apps/xd/DESIGN.md §7.
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { searchCovers, searchParts, searchTerms, searchTurnMatch } from '@dex/protocol/conversation-search';
import type { ConversationSearchMatch } from '@dex/protocol/types';

export type TurnStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface XdAgent {
  id: string;
  name: string;
  description: string;
  /** null = 런타임 기본 문구, '' = 시스템 프롬프트 없음(사용자가 일부러 비움). */
  systemPrompt: string | null;
  accountId: string | null;
  model: string;
  /** `<루트>/workspace/` 아래 폴더 이름 — 만들 때 정하고, 이름을 바꿔도 그대로다. */
  workspace: string;
  folders: string[];
  memory: boolean;
  /** temperature·max_tokens·thinking·도구 묶음 끄기 등 — 엔진 config 로 그대로 간다. */
  options: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface XdConversation {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 대화 목록의 한 줄: 에이전트를 가리지 않는 한 목록(마지막으로 말한 순서)에 쓴다. 에이전트 이름은 줄 위쪽에 작게.
 * 제목이 빈 대화는 화면이 "새 대화" 로 보인다.
 */
export interface XdConversationListItem extends XdConversation {
  agentName: string;
}

/** 채팅 검색 결과 한 줄: 대화 + 맞은 자리(강조 조각). */
export interface XdConversationSearchHit {
  conversation: XdConversationListItem;
  match: ConversationSearchMatch;
}

export interface XdTurn {
  id: string;
  conversationId: string;
  seq: number;
  question: string;
  attachments: unknown[];
  answer: string;
  /** 작업 과정 — 엔진의 tool·progress 사건 그대로. */
  process: unknown[];
  usage: Record<string, unknown> | null;
  status: TurnStatus;
  error: { code: string; message: string } | null;
  startedAt: number;
  endedAt: number | null;
}

export interface XdAccount {
  id: string;
  /** anthropic · openai · google · openai_compatible · claude_code · codex */
  kind: string;
  label: string;
  baseUrl: string | null;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const MIGRATIONS: string[] = [
  // 1 — 처음 모양
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT,
    account_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    workspace TEXT NOT NULL UNIQUE,
    folders TEXT NOT NULL DEFAULT '[]',
    memory INTEGER NOT NULL DEFAULT 1,
    options TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX conversations_by_agent ON conversations(agent_id, updated_at DESC);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    question TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    answer TEXT NOT NULL DEFAULT '',
    process TEXT NOT NULL DEFAULT '[]',
    usage TEXT,
    status TEXT NOT NULL,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (conversation_id, seq)
  );
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    base_url TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

/** 이 판이 아는 마지막 마이그레이션. 이보다 새 DB(앱을 내린 경우)는 열지 않는다 — 모르는 모양을 망가뜨린다. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** 엔진(layout.check_id)이 받는 id — 대화 id 는 엔진에서 기억의 대화 칸 폴더 이름이 된다. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const json = (value: unknown) => JSON.stringify(value ?? null);
function parse<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, unknown>;

function toAgent(r: Row): XdAgent {
  return {
    id: String(r.id),
    name: String(r.name),
    description: String(r.description ?? ''),
    systemPrompt: r.system_prompt === null || r.system_prompt === undefined ? null : String(r.system_prompt),
    accountId: r.account_id ? String(r.account_id) : null,
    model: String(r.model ?? ''),
    workspace: String(r.workspace),
    folders: parse<string[]>(r.folders, []),
    memory: Number(r.memory) === 1,
    options: parse<Record<string, unknown>>(r.options, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toConversation(r: Row): XdConversation {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    title: String(r.title ?? ''),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toTurn(r: Row): XdTurn {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    seq: Number(r.seq),
    question: String(r.question),
    attachments: parse<unknown[]>(r.attachments, []),
    answer: String(r.answer ?? ''),
    process: parse<unknown[]>(r.process, []),
    usage: parse<Record<string, unknown> | null>(r.usage, null),
    status: String(r.status) as TurnStatus,
    error: parse<{ code: string; message: string } | null>(r.error, null),
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at),
  };
}

function toAccount(r: Row): XdAccount {
  return {
    id: String(r.id),
    kind: String(r.kind),
    label: String(r.label),
    baseUrl: r.base_url ? String(r.base_url) : null,
    settings: parse<Record<string, unknown>>(r.settings, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** 대화 제목 — 첫 질문의 첫 줄(길면 줄인다). */
export function titleFrom(question: string): string {
  const line = question.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(file: string, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.recoverInterrupted();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version ?? 0);
    if (current > SCHEMA_VERSION) {
      throw new Error(`this data was written by a newer XD (schema ${current} > ${SCHEMA_VERSION})`);
    }
    for (let v = current; v < SCHEMA_VERSION; v += 1) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** 앱이 턴 도중 꺼졌다 — 그 턴은 끝나지 않았다고 적는다(영원히 "실행 중" 으로 남지 않게). */
  private recoverInterrupted(): void {
    this.db
      .prepare(`UPDATE turns SET status = 'error', error = ?, ended_at = ? WHERE status = 'running'`)
      .run(json({ code: 'interrupted', message: 'The app closed before this answer finished.' }), this.now());
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── 에이전트 ────────────────────────────────────────────────────────
  listAgents(): XdAgent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all() as Row[]).map(toAgent);
  }

  getAgent(id: string): XdAgent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  workspaceTaken(name: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM agents WHERE workspace = ? COLLATE NOCASE').get(name));
  }

  createAgent(input: {
    name: string;
    workspace: string;
    description?: string;
    systemPrompt?: string | null;
    accountId?: string | null;
    model?: string;
    folders?: string[];
    memory?: boolean;
    options?: Record<string, unknown>;
  }): XdAgent {
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, system_prompt, account_id, model, workspace, folders, memory, options, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? '',
        input.systemPrompt === undefined ? null : input.systemPrompt,
        input.accountId ?? null,
        input.model ?? '',
        input.workspace,
        json(input.folders ?? []),
        input.memory === false ? 0 : 1,
        json(input.options ?? {}),
        at,
        at,
      );
    return this.getAgent(id) as XdAgent;
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<XdAgent, 'name' | 'description' | 'systemPrompt' | 'accountId' | 'model' | 'folders' | 'memory' | 'options'>>,
  ): XdAgent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`no agent ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, description = ?, system_prompt = ?, account_id = ?, model = ?, folders = ?, memory = ?, options = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.description,
        next.systemPrompt,
        next.accountId,
        next.model,
        json(next.folders),
        next.memory ? 1 : 0,
        json(next.options),
        this.now(),
        id,
      );
    return this.getAgent(id) as XdAgent;
  }

  /** 에이전트와 그 대화·턴을 지운다. 작업 공간 폴더는 지우지 않는다(사용자 파일). */
  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  // ── 대화 ────────────────────────────────────────────────────────────
  listConversations(agentId: string): XdConversation[] {
    return (
      this.db.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId) as Row[]
    ).map(toConversation);
  }

  /**
   * 모든 에이전트의 대화를 한 목록으로. 마지막으로 말한 순서(updated_at), 같은 시각이면 나중에 생긴 대화가 위.
   * 에이전트 이름을 함께 싣는다. 에이전트를 지우면 그 대화도 함께 지워지므로(ON DELETE CASCADE) 주인 없는 줄은 없다.
   *
   * 이 정렬에 맞춘 색인은 따로 두지 않는다. 이 PC 한 사람의 대화라 줄 수가 작아 정렬 비용이 없고, 에이전트별
   * 목록은 conversations_by_agent 가 받친다.
   */
  listAllConversations(limit?: number): XdConversationListItem[] {
    const sql = `SELECT c.*, a.name AS agent_name FROM conversations c JOIN agents a ON a.id = c.agent_id
       ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC`;
    const rows = (
      limit !== undefined ? this.db.prepare(`${sql} LIMIT ?`).all(Math.max(0, Math.floor(limit))) : this.db.prepare(sql).all()
    ) as Row[];
    return rows.map((r) => ({ ...toConversation(r), agentName: String(r.agent_name ?? '') }));
  }

  /**
   * 채팅 검색(2026-10-10): 대화 제목·에이전트 이름·질문·답에서 찾는다. 낱말 규칙은 서버와 같은
   * @dex/protocol conversation-search 다(모든 낱말, 큰따옴표는 구절, 제목·이름·한 턴에 나뉘어도 된다).
   *
   * SQL LIKE 는 후보만 좁히고(ASCII 대소문자만 무시한다), 맞았는지는 그 규칙으로 다시 본다. 순서는 목록과 같은
   * 마지막으로 말한 순서이고, 대화마다 가장 최근에 맞은 턴의 한 줄을 싣는다.
   */
  searchConversations(query: string, limit = 30): { hits: XdConversationSearchHit[]; hasMore: boolean } {
    const terms = searchTerms(query);
    if (!terms.length) return { hits: [], hasMore: false };
    const like = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const any = (cols: string[]) => `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    const args = (cols: string[]) => terms.flatMap((t) => cols.map(() => like(t)));

    const meta = ['c.title', 'a.name'];
    const metaRows = this.db
      .prepare(
        `SELECT c.*, a.name AS agent_name FROM conversations c JOIN agents a ON a.id = c.agent_id
         WHERE ${terms.map(() => any(meta)).join(' AND ')}`,
      )
      .all(...args(meta)) as Row[];

    const turn = ['t.question', 't.answer'];
    const all = [...meta, ...turn];
    const turnRows = this.db
      .prepare(
        `SELECT t.conversation_id, t.question, t.answer, t.started_at, c.title, a.name AS agent_name
         FROM turns t JOIN conversations c ON c.id = t.conversation_id JOIN agents a ON a.id = c.agent_id
         WHERE (${terms.map(() => any(turn)).join(' OR ')}) AND ${terms.map(() => any(all)).join(' AND ')}
         ORDER BY t.started_at DESC, t.seq DESC`,
      )
      .all(...args(turn), ...args(all)) as Row[];

    const matches = new Map<string, ConversationSearchMatch>();
    for (const r of turnRows) {
      const id = String(r.conversation_id);
      if (matches.has(id)) continue;
      const title = String(r.title ?? '');
      const agent = String(r.agent_name ?? '');
      const found = searchTurnMatch(title, agent, String(r.question ?? ''), String(r.answer ?? ''), terms);
      if (!found) continue;
      matches.set(id, {
        title: searchParts(title, terms),
        agent: searchParts(agent, terms),
        snippet: found.snippet,
        snippetFrom: found.snippetFrom,
        matchedAt: new Date(Number(r.started_at)).toISOString(),
      });
    }
    for (const r of metaRows) {
      const id = String(r.id);
      const title = String(r.title ?? '');
      const agent = String(r.agent_name ?? '');
      if (matches.has(id) || !searchCovers([title, agent], terms)) continue;
      matches.set(id, { title: searchParts(title, terms), agent: searchParts(agent, terms), snippet: null, snippetFrom: null, matchedAt: null });
    }
    if (!matches.size) return { hits: [], hasMore: false };

    const ids = [...matches.keys()];
    const rows = this.db
      .prepare(
        `SELECT c.*, a.name AS agent_name FROM conversations c JOIN agents a ON a.id = c.agent_id
         WHERE c.id IN (${ids.map(() => '?').join(', ')})
         ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC`,
      )
      .all(...ids) as Row[];
    const max = Math.max(1, Math.floor(limit));
    const hits = rows.slice(0, max).map((r) => ({
      conversation: { ...toConversation(r), agentName: String(r.agent_name ?? '') },
      match: matches.get(String(r.id)) as ConversationSearchMatch,
    }));
    return { hits, hasMore: rows.length > max };
  }

  getConversation(id: string): XdConversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Row | undefined;
    return row ? toConversation(row) : null;
  }

  /** 대화를 만든다. id 를 주면 그대로 쓴다(Dex 화면은 대화 id 를 스스로 만든다) — 엔진이 받는 글자만. */
  createConversation(agentId: string, title = '', id: string = randomUUID()): XdConversation {
    if (!this.getAgent(agentId)) throw new Error(`no agent ${agentId}`);
    if (!ID_RE.test(id)) throw new Error(`invalid conversation id: ${id}`);
    const at = this.now();
    this.db
      .prepare('INSERT INTO conversations (id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, agentId, title, at, at);
    return this.getConversation(id) as XdConversation;
  }

  /**
   * 대화 이름을 바꾼다. 목록 순서(마지막으로 말한 시각)는 그대로 둔다. 빈 이름이면 붙인 이름을 버리고 첫 질문에서
   * 다시 정한다(아직 질문이 없으면 빈 제목, 첫 턴이 정한다). 바뀐 대화를 돌려준다(없으면 null).
   */
  renameConversation(id: string, title: string): XdConversation | null {
    const wanted = title.trim();
    const next = wanted || this.titleFromFirstTurn(id);
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(next, id);
    return this.getConversation(id);
  }

  /** 첫 턴의 질문으로 정하는 제목(턴이 없으면 빈 글). */
  private titleFromFirstTurn(conversationId: string): string {
    const row = this.db
      .prepare('SELECT question FROM turns WHERE conversation_id = ? ORDER BY seq LIMIT 1')
      .get(conversationId) as Row | undefined;
    return row ? titleFrom(String(row.question)) : '';
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  // ── 턴 ──────────────────────────────────────────────────────────────
  listTurns(conversationId: string): XdTurn[] {
    return (
      this.db.prepare('SELECT * FROM turns WHERE conversation_id = ? ORDER BY seq').all(conversationId) as Row[]
    ).map(toTurn);
  }

  getTurn(id: string): XdTurn | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Row | undefined;
    return row ? toTurn(row) : null;
  }

  /** 새 턴(실행 중). 대화의 첫 턴이면 제목을 질문에서 정한다. */
  startTurn(conversationId: string, question: string, attachments: unknown[] = []): XdTurn {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`no conversation ${conversationId}`);
    const id = randomUUID();
    const at = this.now();
    return this.tx(() => {
      const last = this.db.prepare('SELECT MAX(seq) AS seq FROM turns WHERE conversation_id = ?').get(conversationId) as Row;
      const seq = last.seq === null || last.seq === undefined ? 1 : Number(last.seq) + 1;
      this.db
        .prepare(
          `INSERT INTO turns (id, conversation_id, seq, question, attachments, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(id, conversationId, seq, question, json(attachments), at);
      const title = conversation.title || titleFrom(question);
      this.db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, at, conversationId);
      this.db.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(at, conversation.agentId);
      return this.getTurn(id) as XdTurn;
    });
  }

  /** 끝난 턴을 적는다 — 답·작업 과정·사용량·상태를 한 번에. */
  finishTurn(
    id: string,
    result: {
      answer: string;
      process: unknown[];
      usage: Record<string, unknown> | null;
      status: Exclude<TurnStatus, 'running'>;
      error?: { code: string; message: string } | null;
    },
  ): XdTurn {
    this.db
      .prepare(`UPDATE turns SET answer = ?, process = ?, usage = ?, status = ?, error = ?, ended_at = ? WHERE id = ?`)
      .run(
        result.answer,
        json(result.process),
        result.usage ? json(result.usage) : null,
        result.status,
        result.error ? json(result.error) : null,
        this.now(),
        id,
      );
    return this.getTurn(id) as XdTurn;
  }

  /**
   * 엔진에 넘길 이전 대화 — 답이 있는 턴만, 오래된 것부터, 끝에서 `limit` 개.
   * 답이 없는 질문만 넣으면 같은 쪽 말이 이어져 제공자가 거절하거나 모델이 헷갈린다.
   */
  history(conversationId: string, limit = 50): Array<{ role: 'user' | 'assistant'; content: string }> {
    const rows = this.db
      .prepare(
        `SELECT question, answer FROM turns WHERE conversation_id = ? AND status != 'running' AND answer != ''
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(conversationId, limit) as Row[];
    return rows.reverse().flatMap((r) => [
      { role: 'user' as const, content: String(r.question) },
      { role: 'assistant' as const, content: String(r.answer) },
    ]);
  }

  // ── 계정 ────────────────────────────────────────────────────────────
  listAccounts(): XdAccount[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as Row[]).map(toAccount);
  }

  getAccount(id: string): XdAccount | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    return row ? toAccount(row) : null;
  }

  createAccount(input: { kind: string; label: string; baseUrl?: string | null; settings?: Record<string, unknown> }): XdAccount {
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare('INSERT INTO accounts (id, kind, label, base_url, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.kind, input.label, input.baseUrl ?? null, json(input.settings ?? {}), at, at);
    return this.getAccount(id) as XdAccount;
  }

  updateAccount(id: string, patch: Partial<Pick<XdAccount, 'label' | 'baseUrl' | 'settings'>>): XdAccount {
    const current = this.getAccount(id);
    if (!current) throw new Error(`no account ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare('UPDATE accounts SET label = ?, base_url = ?, settings = ?, updated_at = ? WHERE id = ?')
      .run(next.label, next.baseUrl, json(next.settings), this.now(), id);
    return this.getAccount(id) as XdAccount;
  }

  /** 계정을 지운다. 그 계정을 쓰던 에이전트는 계정 없음으로 남는다(지우지 않는다). */
  deleteAccount(id: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE agents SET account_id = NULL WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
  }

  // ── 설정 ────────────────────────────────────────────────────────────
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? parse<T>(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, json(value));
  }
}
