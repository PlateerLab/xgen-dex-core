/** Shared browser contracts used by the main process, preload and renderer. */

export type BrowserPageMode = 'shared' | 'background';

export type BrowserLoadingState = 'idle' | 'loading' | 'error';

export const BROWSER_SEARCH_PROVIDERS = {
  google: {
    label: 'Google',
    searchUrl: 'https://www.google.com/search?q={query}',
  },
} as const;

export type BrowserSearchProvider = keyof typeof BROWSER_SEARCH_PROVIDERS;

export interface BrowserAddressSearchConfig {
  enabled?: boolean;
  provider?: BrowserSearchProvider;
}

/** Normalize user-entered browser URLs while keeping the runtime scheme allowlist narrow. */
export function normalizeBrowserUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value || value === 'about:blank') return 'about:blank';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function looksLikeBrowserUrl(value: string): boolean {
  if (value === 'about:blank' || /^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  if (/\s/.test(value)) return false;
  const normalized = normalizeBrowserUrl(value);
  if (!normalized || normalized === 'about:blank') return false;
  try {
    const hostname = new URL(normalized).hostname;
    return (
      hostname === 'localhost' ||
      hostname.includes('.') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname.includes(':')
    );
  } catch {
    return false;
  }
}

/** Resolve an omnibox value to a URL, optionally falling back to a configured search provider. */
export function resolveBrowserAddress(
  raw: unknown,
  search: BrowserAddressSearchConfig = {},
): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (looksLikeBrowserUrl(value)) return normalizeBrowserUrl(value);
  if (!search.enabled) return null;
  const provider = search.provider ?? 'google';
  const definition = BROWSER_SEARCH_PROVIDERS[provider];
  if (!definition) return null;
  return definition.searchUrl.replace('{query}', encodeURIComponent(value));
}

export interface BrowserPageInfo {
  pageId: string;
  workflowId: string;
  workflowName: string;
  mode: BrowserPageMode;
  url: string;
  title: string;
  loading: BrowserLoadingState;
  error?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Persisted Electron partition. It contains only a hashed account key. */
  partition: string;
  /** Changes when navigation/process replacement invalidates snapshot refs. */
  generation: number;
}

export interface BrowserState {
  enabled: boolean;
  pages: BrowserPageInfo[];
  activeByWorkflow: Record<string, string>;
  popupRequests: BrowserPopupRequest[];
}

/** One unique URL returned by the account-local omnibox history index. */
export interface BrowserHistorySuggestion {
  placeId: string;
  url: string;
  title: string;
  lastVisitedAt: number;
  visitCount: number;
}

/** One chronological visit shown in the browser history panel. */
export interface BrowserHistoryVisit {
  visitId: string;
  placeId: string;
  url: string;
  title: string;
  visitedAt: number;
}

export interface BrowserHistorySuggestionsRequest {
  query?: string;
  limit?: number;
}

export interface BrowserHistoryListRequest {
  offset?: number;
  limit?: number;
}

export interface BrowserHistoryListResult {
  items: BrowserHistoryVisit[];
  total: number;
}

/** Remove one visit or every visit for one URL. Exactly one id is expected. */
export interface BrowserHistoryRemoveRequest {
  visitId?: string;
  placeId?: string;
}

export interface BrowserConnectionEvent {
  phase: 'required' | 'connected' | 'timeout' | 'cancelled';
  pageId: string;
  workflowId: string;
  workflowName: string;
}

export interface BrowserCreateRequest {
  workflowId: string;
  workflowName?: string;
  mode?: BrowserPageMode;
  url?: string;
}

export interface BrowserNavigateRequest {
  pageId: string;
  action: 'goto' | 'back' | 'forward' | 'reload' | 'stop';
  url?: string;
}

export type BrowserSelectionMode = 'element' | 'region';

export interface BrowserSelectionPoint {
  x: number;
  y: number;
}

export interface BrowserSelectionRect extends BrowserSelectionPoint {
  width: number;
  height: number;
}

export interface BrowserSelectionBeginRequest {
  pageId: string;
  generation: number;
  mode: BrowserSelectionMode;
}

/** One-shot, main-process-owned permission to inspect and capture one visible page. */
export interface BrowserSelectionSession {
  token: string;
  pageId: string;
  generation: number;
  mode: BrowserSelectionMode;
  expiresAt: number;
}

export interface BrowserSelectionInspectRequest {
  token: string;
  point: BrowserSelectionPoint;
}

export interface BrowserSelectionCompleteRequest {
  token: string;
  point?: BrowserSelectionPoint;
  rect?: BrowserSelectionRect;
}

export interface BrowserSelectionPreview {
  tag: string;
  label: string;
  rect: BrowserSelectionRect;
}

export interface BrowserElementContext {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  href?: string;
  /** A short allowlisted reconstruction, never the page's raw outerHTML. */
  html?: string;
  rect: BrowserSelectionRect;
}

export interface BrowserSelectionResult {
  id: string;
  workflowId: string;
  pageId: string;
  generation: number;
  kind: BrowserSelectionMode;
  title: string;
  url: string;
  rect: BrowserSelectionRect;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  elements: BrowserElementContext[];
  image: {
    dataUrl: string;
    name: string;
    mime: 'image/png' | 'image/jpeg';
    size: number;
    width: number;
    height: number;
  };
}

export type BrowserPopupPermission = 'allow' | 'block';

/** Persisted popup rules keyed first by the account-hashed browser partition. */
export type BrowserPopupPermissions = Record<string, Record<string, BrowserPopupPermission>>;

export type BrowserPopupDecision = 'allow_always' | 'allow_session' | 'block';

/**
 * A secret-free popup summary exposed to the renderer. The main process keeps
 * the complete target URL (including query/fragment) behind requestId.
 */
export interface BrowserPopupRequest {
  requestId: string;
  pageId: string;
  workflowId: string;
  openerOrigin: string;
  targetOrigin: string;
  targetDisplayUrl: string;
  createdAt: number;
}

export interface BrowserPopupResolveRequest {
  requestId: string;
  decision: BrowserPopupDecision;
}

/** Exact http(s) origin used as the popup permission key. */
export function browserOrigin(raw: unknown): string | null {
  const normalized = normalizeBrowserUrl(raw);
  if (!normalized || normalized === 'about:blank') return null;
  try {
    return new URL(normalized).origin;
  } catch {
    return null;
  }
}

export type BrowserErrorCode =
  | 'browser_disabled'
  | 'browser_no_page'
  | 'browser_page_not_found'
  | 'browser_stale_ref'
  | 'browser_timeout'
  | 'browser_denied';

export const BROWSER_CONTEXT_START = '<xgen_browser_context>';
export const BROWSER_CONTEXT_END = '</xgen_browser_context>';

/** Only expose origin + pathname to chat. Query strings and fragments can hold secrets. */
export function sanitizedBrowserUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'about:') return 'about:blank';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

/** Remove the connector-only browser envelope before text is shown to a user. */
export function stripBrowserContext(text: string): string {
  if (typeof text !== 'string' || !text.startsWith(BROWSER_CONTEXT_START)) return text;
  const end = text.indexOf(BROWSER_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + BROWSER_CONTEXT_END.length).replace(/^\r?\n/, '');
}

/** Add a machine-readable envelope only when this workflow owns live pages. */
export function prependBrowserContext(
  input: string,
  workflowId: string,
  state: BrowserState,
  selections: BrowserSelectionResult[] = [],
): string {
  if (!state.enabled) return input;
  const pages = state.pages
    .filter((page) => page.workflowId === workflowId)
    .map((page) => ({
      workflow_id: page.workflowId,
      page_id: page.pageId,
      mode: page.mode,
      title: page.title,
      url: sanitizedBrowserUrl(page.url),
    }));
  const selected = selections
    .filter((selection) => selection.workflowId === workflowId)
    .map((selection) => ({
      id: selection.id,
      page_id: selection.pageId,
      generation: selection.generation,
      kind: selection.kind,
      title: selection.title,
      url: sanitizedBrowserUrl(selection.url),
      rect: selection.rect,
      viewport: selection.viewport,
      elements: selection.elements,
      image_name: selection.image.name,
    }));
  if (!pages.length && !selected.length) return input;
  const envelope = JSON.stringify({
    version: selected.length ? 2 : 1,
    workflow_id: workflowId,
    pages,
    ...(selected.length ? { selections: selected } : {}),
  });
  return `${BROWSER_CONTEXT_START}\n${envelope}\n${BROWSER_CONTEXT_END}\n${input}`;
}
