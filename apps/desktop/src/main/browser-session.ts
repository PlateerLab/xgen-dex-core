import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserPageInfo, BrowserState } from '@dex/protocol/browser';
import { allowedBrowserUrl } from './browser-security';

type BrowserSession = Pick<BrowserState, 'pages' | 'activeByWorkflow'>;

/** Only ordinary tabs survive restart; popup opener state cannot be replayed from a URL. */
export class BrowserSessionStore {
  private lastSaved = new Map<string, string>();

  constructor(private readonly userDataDir: string) {}

  private path(partition: string): string {
    const key = createHash('sha256').update(partition).digest('hex');
    return join(this.userDataDir, 'browser-sessions', `${key}.json`);
  }

  load(partition: string): BrowserSession {
    const empty = { pages: [], activeByWorkflow: {} };
    try {
      const data = JSON.parse(readFileSync(this.path(partition), 'utf8'));
      if (data?.version !== 1 || !Array.isArray(data.pages)) return empty;
      const pages: BrowserPageInfo[] = [];
      const ids = new Set<string>();
      for (const page of data.pages) {
        if (
          !page ||
          typeof page.pageId !== 'string' ||
          !page.pageId ||
          ids.has(page.pageId) ||
          typeof page.workflowId !== 'string' ||
          !page.workflowId.trim() ||
          typeof page.url !== 'string'
        )
          continue;
        const url = allowedBrowserUrl(page.url);
        if (!url) continue;
        ids.add(page.pageId);
        pages.push({
          pageId: page.pageId,
          workflowId: page.workflowId,
          workflowName: typeof page.workflowName === 'string' ? page.workflowName : page.workflowId,
          url,
          title: typeof page.title === 'string' ? page.title : '새 탭',
          mode: 'shared',
          partition,
          loading: 'idle',
          canGoBack: false,
          canGoForward: false,
          generation: 0,
        });
      }
      const active = new Map<string, string>();
      for (const page of pages) {
        if (
          !active.has(page.workflowId) ||
          data.activeByWorkflow?.[page.workflowId] === page.pageId
        )
          active.set(page.workflowId, page.pageId);
      }
      return { pages, activeByWorkflow: Object.fromEntries(active) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('[browser-session] 복원 실패:', error);
      return empty;
    }
  }

  save(partition: string, state: BrowserState): void {
    const pages = state.pages
      .filter((page) => page.mode === 'shared' && page.partition === partition)
      .map(({ pageId, workflowId, workflowName, url, title }) => ({
        pageId,
        workflowId,
        workflowName,
        url,
        title,
      }));
    // 팝업이 앞에 있으면 팝업을 연 탭을 고른 탭으로 남긴다 — 팝업은 저장하지 않으므로.
    const byId = new Map(state.pages.map((page) => [page.pageId, page]));
    const openerOf = (pageId: string) => {
      for (let page = byId.get(pageId); page?.mode === 'popup' && page.openerPageId; page = byId.get(pageId))
        pageId = page.openerPageId;
      return pageId;
    };
    const activeByWorkflow = Object.fromEntries(
      Object.entries(state.activeByWorkflow)
        .map(([workflowId, pageId]) => [workflowId, openerOf(pageId)])
        .filter(([workflowId, pageId]) =>
          pages.some((page) => page.pageId === pageId && page.workflowId === workflowId),
        ),
    );
    const serialized = JSON.stringify({ version: 1, pages, activeByWorkflow });
    if (this.lastSaved.get(partition) === serialized) return;
    try {
      const path = this.path(partition);
      mkdirSync(join(this.userDataDir, 'browser-sessions'), { recursive: true });
      writeFileSync(`${path}.tmp`, serialized, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
      this.lastSaved.set(partition, serialized);
    } catch (error) {
      console.error('[browser-session] 저장 실패:', error);
    }
  }
}
