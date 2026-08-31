import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BrowserHistoryListRequest,
  BrowserHistoryListResult,
  BrowserHistoryRemoveRequest,
  BrowserHistorySuggestion,
} from '../core/browser';
import { normalizeBrowserUrl } from '../core/browser';
import { BROWSER_PARTITION_PREFIX } from './browser-security';

const HISTORY_VERSION = 1;
const DEFAULT_MAX_PLACES = 2_000;
const DEFAULT_MAX_VISITS = 10_000;
const DEFAULT_WRITE_DELAY_MS = 750;
const DUPLICATE_VISIT_WINDOW_MS = 1_000;

interface StoredPlace {
  id: string;
  url: string;
  title: string;
  firstVisitedAt: number;
  lastVisitedAt: number;
  visitCount: number;
}

interface StoredVisit {
  id: string;
  placeId: string;
  visitedAt: number;
}

interface PersistedBrowserHistory {
  version: 1;
  places: Record<string, StoredPlace>;
  /** Newest first. */
  visits: StoredVisit[];
}

export interface BrowserHistoryRuntimeEvent {
  type: 'visit' | 'title';
  partition: string;
  url: string;
  title: string;
  visitedAt?: number;
}

export interface BrowserHistoryStoreOptions {
  maxPlaces?: number;
  maxVisits?: number;
  writeDelayMs?: number;
}

function emptyHistory(): PersistedBrowserHistory {
  return { version: HISTORY_VERSION, places: {}, visits: [] };
}

function finiteInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizedTitle(raw: unknown, fallback: string): string {
  const value = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return (value || fallback).slice(0, 512);
}

function historyUrl(raw: unknown): string | null {
  const normalized = normalizeBrowserUrl(raw);
  if (!normalized || normalized === 'about:blank') return null;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function placeIdFor(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function accountHash(partition: string): string {
  const prefix = BROWSER_PARTITION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = new RegExp(`^${prefix}([a-f0-9]{24})$`).exec(partition);
  if (!matched) throw new Error('browser_denied: 올바르지 않은 브라우저 계정 partition입니다.');
  return matched[1];
}

function searchable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function matchScore(place: StoredPlace, query: string): number {
  if (!query) return 0;
  const url = searchable(place.url);
  const title = searchable(place.title);
  let host = '';
  let address = url;
  try {
    const parsed = new URL(place.url);
    host = searchable(parsed.hostname);
    address = searchable(`${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    /* validated on write/load */
  }
  if (host.startsWith(query)) return 600;
  if (address.startsWith(query)) return 550;
  if (title.startsWith(query)) return 500;
  if (host.includes(query)) return 400;
  if (url.includes(query)) return 350;
  if (title.includes(query)) return 300;
  return -1;
}

/**
 * Account-isolated, bounded browser history stored separately from connector.json.
 * All mutations are in-memory first and serialized through an atomic tmp-file rename.
 */
export class BrowserHistoryStore {
  private readonly maxPlaces: number;
  private readonly maxVisits: number;
  private readonly writeDelayMs: number;
  private readonly accounts = new Map<string, Promise<PersistedBrowserHistory>>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writeTails = new Map<string, Promise<void>>();

  constructor(
    private readonly userDataDir: string,
    options: BrowserHistoryStoreOptions = {},
  ) {
    this.maxPlaces = Math.max(1, finiteInteger(options.maxPlaces, DEFAULT_MAX_PLACES));
    this.maxVisits = Math.max(1, finiteInteger(options.maxVisits, DEFAULT_MAX_VISITS));
    this.writeDelayMs = Math.max(0, finiteInteger(options.writeDelayMs, DEFAULT_WRITE_DELAY_MS));
  }

  async apply(event: BrowserHistoryRuntimeEvent): Promise<void> {
    if (event.type === 'title') return this.updateTitle(event.partition, event.url, event.title);
    return this.record(event.partition, event.url, event.title, event.visitedAt);
  }

  async record(
    partition: string,
    rawUrl: unknown,
    rawTitle: unknown,
    at = Date.now(),
  ): Promise<void> {
    const key = accountHash(partition);
    const url = historyUrl(rawUrl);
    if (!url) return;
    const visitedAt = Math.max(0, finiteInteger(at, Date.now()));
    const data = await this.load(key);
    const placeId = placeIdFor(url);
    const existing = data.places[placeId];
    const title = normalizedTitle(rawTitle, existing?.title || new URL(url).hostname || url);
    const latest = data.visits[0];

    if (
      latest?.placeId === placeId &&
      Math.abs(visitedAt - latest.visitedAt) <= DUPLICATE_VISIT_WINDOW_MS
    ) {
      if (existing) {
        existing.title = title;
        existing.lastVisitedAt = Math.max(existing.lastVisitedAt, visitedAt);
      }
      this.scheduleWrite(key);
      return;
    }

    data.places[placeId] = existing
      ? {
          ...existing,
          title,
          firstVisitedAt: Math.min(existing.firstVisitedAt, visitedAt),
          lastVisitedAt: Math.max(existing.lastVisitedAt, visitedAt),
          visitCount: existing.visitCount + 1,
        }
      : {
          id: placeId,
          url,
          title,
          firstVisitedAt: visitedAt,
          lastVisitedAt: visitedAt,
          visitCount: 1,
        };
    data.visits.unshift({ id: randomUUID(), placeId, visitedAt });
    this.prune(data);
    this.scheduleWrite(key);
  }

  async updateTitle(partition: string, rawUrl: unknown, rawTitle: unknown): Promise<void> {
    const key = accountHash(partition);
    const url = historyUrl(rawUrl);
    if (!url) return;
    const data = await this.load(key);
    const place = data.places[placeIdFor(url)];
    if (!place) return;
    const title = normalizedTitle(rawTitle, place.title);
    if (title === place.title) return;
    place.title = title;
    this.scheduleWrite(key);
  }

  async suggestions(
    partition: string,
    rawQuery: unknown,
    rawLimit = 8,
  ): Promise<BrowserHistorySuggestion[]> {
    const data = await this.load(accountHash(partition));
    const query = searchable(String(rawQuery ?? '').trim());
    const limit = Math.min(20, Math.max(1, finiteInteger(rawLimit, 8)));
    return Object.values(data.places)
      .map((place) => ({ place, score: matchScore(place, query) }))
      .filter(({ score }) => score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.place.lastVisitedAt - a.place.lastVisitedAt ||
          b.place.visitCount - a.place.visitCount,
      )
      .slice(0, limit)
      .map(({ place }) => ({
        placeId: place.id,
        url: place.url,
        title: place.title,
        lastVisitedAt: place.lastVisitedAt,
        visitCount: place.visitCount,
      }));
  }

  async list(
    partition: string,
    request: BrowserHistoryListRequest = {},
  ): Promise<BrowserHistoryListResult> {
    const data = await this.load(accountHash(partition));
    const offset = Math.max(0, finiteInteger(request.offset, 0));
    const limit = Math.min(500, Math.max(1, finiteInteger(request.limit, 200)));
    return {
      total: data.visits.length,
      items: data.visits.slice(offset, offset + limit).flatMap((visit) => {
        const place = data.places[visit.placeId];
        return place
          ? [
              {
                visitId: visit.id,
                placeId: place.id,
                url: place.url,
                title: place.title,
                visitedAt: visit.visitedAt,
              },
            ]
          : [];
      }),
    };
  }

  async remove(partition: string, request: BrowserHistoryRemoveRequest): Promise<boolean> {
    const key = accountHash(partition);
    const data = await this.load(key);
    if (request.visitId) {
      const index = data.visits.findIndex((visit) => visit.id === request.visitId);
      if (index < 0) return false;
      const [removed] = data.visits.splice(index, 1);
      this.decrementPlace(data, removed);
      this.scheduleWrite(key);
      return true;
    }
    if (request.placeId && data.places[request.placeId]) {
      delete data.places[request.placeId];
      data.visits = data.visits.filter((visit) => visit.placeId !== request.placeId);
      this.scheduleWrite(key);
      return true;
    }
    return false;
  }

  async clear(partition: string): Promise<void> {
    const key = accountHash(partition);
    const timer = this.writeTimers.get(key);
    if (timer) clearTimeout(timer);
    this.writeTimers.delete(key);
    this.accounts.set(key, Promise.resolve(emptyHistory()));
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => rm(this.filePath(key), { force: true }));
    this.writeTails.set(key, task);
    await task;
    if (this.writeTails.get(key) === task) this.writeTails.delete(key);
  }

  async flush(partition: string): Promise<void> {
    await this.persist(accountHash(partition));
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.accounts.keys()].map((key) => this.persist(key)));
  }

  private async load(key: string): Promise<PersistedBrowserHistory> {
    let pending = this.accounts.get(key);
    if (!pending) {
      pending = this.read(key);
      this.accounts.set(key, pending);
    }
    return pending;
  }

  private async read(key: string): Promise<PersistedBrowserHistory> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath(key), 'utf8'),
      ) as Partial<PersistedBrowserHistory>;
      if (parsed.version !== HISTORY_VERSION || !parsed.places || !Array.isArray(parsed.visits)) {
        return emptyHistory();
      }
      const data = emptyHistory();
      for (const candidate of Object.values(parsed.places)) {
        const url = historyUrl(candidate?.url);
        if (!url) continue;
        const id = placeIdFor(url);
        if (candidate?.id !== id) continue;
        const firstVisitedAt = Math.max(0, finiteInteger(candidate.firstVisitedAt, 0));
        const lastVisitedAt = Math.max(
          firstVisitedAt,
          finiteInteger(candidate.lastVisitedAt, firstVisitedAt),
        );
        data.places[id] = {
          id,
          url,
          title: normalizedTitle(candidate.title, new URL(url).hostname || url),
          firstVisitedAt,
          lastVisitedAt,
          visitCount: Math.max(1, finiteInteger(candidate.visitCount, 1)),
        };
      }
      data.visits = parsed.visits
        .flatMap((candidate) => {
          if (!candidate || typeof candidate.id !== 'string' || !data.places[candidate.placeId]) {
            return [];
          }
          return [
            {
              id: candidate.id.slice(0, 128),
              placeId: candidate.placeId,
              visitedAt: Math.max(0, finiteInteger(candidate.visitedAt, 0)),
            },
          ];
        })
        .sort((a, b) => b.visitedAt - a.visitedAt);
      this.prune(data);
      return data;
    } catch {
      return emptyHistory();
    }
  }

  private prune(data: PersistedBrowserHistory): void {
    if (data.visits.length > this.maxVisits) data.visits.length = this.maxVisits;
    const places = Object.values(data.places).sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
    if (places.length <= this.maxPlaces) return;
    const keep = new Set(places.slice(0, this.maxPlaces).map((place) => place.id));
    for (const place of places.slice(this.maxPlaces)) delete data.places[place.id];
    data.visits = data.visits.filter((visit) => keep.has(visit.placeId));
  }

  private decrementPlace(data: PersistedBrowserHistory, visit: StoredVisit): void {
    const place = data.places[visit.placeId];
    if (!place) return;
    place.visitCount = Math.max(0, place.visitCount - 1);
    if (place.visitCount === 0) {
      delete data.places[visit.placeId];
      return;
    }
    const remaining = data.visits.filter((item) => item.placeId === visit.placeId);
    if (remaining.length) {
      place.lastVisitedAt = Math.max(...remaining.map((item) => item.visitedAt));
      place.firstVisitedAt = Math.min(
        place.firstVisitedAt,
        ...remaining.map((item) => item.visitedAt),
      );
    }
  }

  private scheduleWrite(key: string): void {
    const previous = this.writeTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.writeTimers.delete(key);
      void this.persist(key).catch(() => undefined);
    }, this.writeDelayMs);
    timer.unref?.();
    this.writeTimers.set(key, timer);
  }

  private async persist(key: string): Promise<void> {
    const timer = this.writeTimers.get(key);
    if (timer) clearTimeout(timer);
    this.writeTimers.delete(key);
    const previous = this.writeTails.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const data = await this.load(key);
        const dir = this.historyDir();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const target = this.filePath(key);
        const temporary = join(dir, `.${key}.${process.pid}.tmp`);
        await writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
      });
    this.writeTails.set(key, task);
    await task;
    if (this.writeTails.get(key) === task) this.writeTails.delete(key);
  }

  private historyDir(): string {
    return join(this.userDataDir, 'browser-history', `v${HISTORY_VERSION}`);
  }

  private filePath(key: string): string {
    return join(this.historyDir(), `${key}.json`);
  }
}
