/**
 * MCP 카탈로그 사용 기록 보고기 — 이벤트를 이 PC 에 쌓아 두었다가(재시작해도 남는다)
 * 몇 초마다 모아서 서버(`POST /events`, 최대 100개)로 보낸다. 실패하면 점점 늦게 다시 보낸다.
 *
 * 무엇을 보내지 않는가(공통 계약 §2.4): 변수 값 · 도구 인자 · 결과 · 토큰. 이벤트를 만드는
 * 쪽이 이미 걸렀더라도 여기서 한 번 더 거른다 — 허용 필드만 남기고, 오류 문구는 비밀 값 ·
 * 인증 헤더 모양 · 긴 토큰 모양 문자열 · 홈 경로를 가린 뒤 500자로 자른다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  CATALOG_ERROR_MESSAGE_MAX,
  CATALOG_EVENTS_MAX_BATCH,
  isCatalogEventName,
  type CatalogEventIn,
} from '@dex/protocol/mcp-catalog';
import { McpSecretRedactor } from './mcp-redaction';

export interface CatalogEventStorage {
  load(): CatalogEventIn[];
  save(events: CatalogEventIn[]): void;
}

/** JSON 파일 하나(임시 파일 → rename 으로 원자적 교체). 읽기 실패는 빈 큐. */
export function fileEventStorage(path: string): CatalogEventStorage {
  return {
    load() {
      try {
        if (!existsSync(path)) return [];
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(raw?.events) ? raw.events : [];
      } catch {
        return [];
      }
    },
    save(events) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, events }));
        renameSync(tmp, path);
      } catch {
        /* 기록을 디스크에 못 남겨도 앱은 계속된다(메모리 큐는 남는다) */
      }
    },
  };
}

export function memoryEventStorage(
  initial: CatalogEventIn[] = [],
): CatalogEventStorage & { saved: CatalogEventIn[][] } {
  let current = [...initial];
  const saved: CatalogEventIn[][] = [];
  return {
    saved,
    load: () => [...current],
    save(events) {
      current = [...events];
      saved.push([...events]);
    },
  };
}

const AUTH_LIKE = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const KEY_VALUE_SECRET =
  /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|apikey|authorization)[A-Za-z0-9_]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const LONG_TOKEN = /[A-Za-z0-9_\-]{32,}/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const URL_QUERY = /(\bhttps?:\/\/[^\s?#]+)\?[^\s#]*/gi;

/** 비밀이 섞였을 수 있는 문구를 보낼 수 있는 모양으로. */
export function scrubCatalogMessage(
  text: string,
  redactor?: McpSecretRedactor,
  home = homedir(),
): string {
  let out = redactor ? redactor.text(text, 4000) : String(text ?? '');
  out = out
    .replace(URL_CREDENTIALS, '$1[REDACTED]@')
    .replace(URL_QUERY, '$1?[REDACTED]')
    .replace(AUTH_LIKE, (_m, scheme: string) => `${scheme} [REDACTED]`)
    .replace(KEY_VALUE_SECRET, (_m, key: string) => `${key}=[REDACTED]`)
    .replace(LONG_TOKEN, '[REDACTED]');
  if (home && home.length > 1) out = out.split(home).join('~');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > CATALOG_ERROR_MESSAGE_MAX ? out.slice(0, CATALOG_ERROR_MESSAGE_MAX) : out;
}

function shortText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function nonNegInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** 허용 필드만 남긴다. 이름이 계약 밖이거나 catalog_id 가 없으면 버린다(null). */
export function sanitizeCatalogEvent(
  input: CatalogEventIn,
  redactor?: McpSecretRedactor,
): CatalogEventIn | null {
  if (!input || !isCatalogEventName(input.event)) return null;
  const catalogId = shortText(input.catalog_id, 64);
  if (!catalogId) return null;
  const ts = Number.isNaN(Date.parse(String(input.ts)))
    ? new Date().toISOString()
    : new Date(input.ts).toISOString();
  const out: CatalogEventIn = { ts, catalog_id: catalogId, event: input.event };
  const revision = nonNegInt(input.revision);
  if (revision !== undefined) out.revision = revision;
  const serverName = shortText(input.server_name, 128);
  if (serverName) out.server_name = serverName;
  if (typeof input.ok === 'boolean') out.ok = input.ok;
  const runtime = shortText(input.runtime, 32);
  if (runtime) out.runtime = runtime;
  const runtimeVersion = shortText(input.runtime_version, 64);
  if (runtimeVersion) out.runtime_version = runtimeVersion;
  const duration = nonNegInt(input.duration_ms);
  if (duration !== undefined) out.duration_ms = duration;
  const code = shortText(input.error_code, 64);
  if (code && /^[a-z0-9_.-]+$/i.test(code)) out.error_code = code;
  if (input.error_message) {
    const message = scrubCatalogMessage(String(input.error_message), redactor);
    if (message) out.error_message = message;
  }
  const tools = nonNegInt(input.tool_count);
  if (tools !== undefined) out.tool_count = tools;
  if (input.detail && typeof input.detail === 'object') {
    const detail: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(input.detail).slice(0, 12)) {
      if (!/^[a-z0-9_]{1,32}$/i.test(k)) continue;
      if (v === null || typeof v === 'boolean') detail[k] = v;
      else if (typeof v === 'number' && Number.isFinite(v)) detail[k] = v;
      else if (typeof v === 'string') detail[k] = scrubCatalogMessage(v, redactor).slice(0, 120);
    }
    // 서버 상한 2KB — 넘으면 한 건 때문에 묶음 전체가 400 이 되므로 아예 뺀다.
    if (Object.keys(detail).length && JSON.stringify(detail).length <= 1800) out.detail = detail;
  }
  return out;
}

export interface CatalogEventReporterOptions {
  storage: CatalogEventStorage;
  /** 한 묶음을 보낸다. 받은 수를 돌려준다. 실패하면 던진다(`status` 가 있으면 본다). */
  send: (events: CatalogEventIn[]) => Promise<number>;
  /** 지금 보낼 수 있는가(로그인 · 서버 주소). 아니면 큐에 둔다. */
  canSend: () => boolean;
  intervalMs?: number;
  maxQueue?: number;
  maxBackoffMs?: number;
  /** 설치에서 쓰인 비밀 값을 한 번 더 가리고 싶을 때. */
  redactor?: () => McpSecretRedactor | undefined;
}

/** 보내도 다시 받지 않을 묶음(형식 오류) — 계속 다시 보내면 큐가 영원히 막힌다. */
function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 400 || status === 413 || status === 422;
}

export class CatalogEventReporter {
  private queue: CatalogEventIn[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;
  private stopped = true;
  private readonly intervalMs: number;
  private readonly maxQueue: number;
  private readonly maxBackoffMs: number;
  /** 보고 결과(시험·진단용). */
  lastError: string | null = null;
  dropped = 0;

  constructor(private readonly opts: CatalogEventReporterOptions) {
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.maxQueue = opts.maxQueue ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 5 * 60_000;
    this.queue = opts.storage
      .load()
      .filter((e) => !!sanitizeCatalogEvent(e))
      .slice(-this.maxQueue);
  }

  size(): number {
    return this.queue.length;
  }

  pending(): CatalogEventIn[] {
    return [...this.queue];
  }

  enqueue(event: CatalogEventIn): boolean {
    const clean = sanitizeCatalogEvent(event, this.opts.redactor?.());
    if (!clean) return false;
    this.queue.push(clean);
    if (this.queue.length > this.maxQueue) {
      // 오래된 것부터 버린다 — 상한이 없으면 오프라인 PC 의 파일이 끝없이 커진다.
      this.dropped += this.queue.length - this.maxQueue;
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    this.opts.storage.save(this.queue);
    this.schedule(this.intervalMs);
    return true;
  }

  start(): void {
    this.stopped = false;
    if (this.queue.length) this.schedule(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 로그인 직후 · 온라인 복귀 때 바로 보내 보게 한다. */
  kick(): void {
    this.failures = 0;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.stopped || !this.queue.length) return;
    if (this.timer) {
      if (ms > 0) return; // 이미 예약됨
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** 큐가 빌 때까지(또는 실패할 때까지) 묶음으로 보낸다. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    // .finally 는 대입 뒤에 돈다 — 본문이 동기로 끝나도(보낼 수 없음) 잠금이 남지 않는다.
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      if (!this.opts.canSend()) {
        this.schedule(this.backoff());
        return;
      }
      const batch = this.queue.slice(0, CATALOG_EVENTS_MAX_BATCH);
      try {
        await this.opts.send(batch);
        this.failures = 0;
        this.lastError = null;
      } catch (error) {
        this.lastError = String((error as Error)?.message ?? error).slice(0, 200);
        if (!isPermanent(error)) {
          this.failures++;
          this.schedule(this.backoff());
          return;
        }
        // 서버는 한 건이라도 틀리면 묶음 전체를 400 으로 거절한다 — 한 건씩 다시 보내
        // 틀린 것만 버린다(드문 경우라 요청 수는 문제 되지 않는다).
        if (batch.length > 1) {
          const kept = await this.sendOneByOne(batch);
          if (kept) return;
        } else {
          this.dropped += batch.length;
        }
      }
      // 보낸(또는 영구 거절된) 묶음만 뺀다 — 보내는 동안 들어온 이벤트는 그대로 남는다.
      const done = new Set(batch);
      this.queue = this.queue.filter((e) => !done.has(e));
      this.opts.storage.save(this.queue);
    }
  }

  /** 한 건씩 보낸다. 일시 실패를 만나면 거기서 멈추고 true(남은 것은 큐에 둔다). */
  private async sendOneByOne(batch: CatalogEventIn[]): Promise<boolean> {
    for (const event of batch) {
      try {
        await this.opts.send([event]);
      } catch (error) {
        if (!isPermanent(error)) {
          this.failures++;
          this.schedule(this.backoff());
          return true;
        }
        this.dropped++;
      }
      this.queue = this.queue.filter((e) => e !== event);
      this.opts.storage.save(this.queue);
    }
    return false;
  }

  private backoff(): number {
    return Math.min(this.intervalMs * 2 ** Math.min(this.failures, 10), this.maxBackoffMs);
  }
}
