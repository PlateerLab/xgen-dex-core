import type { WebContents } from 'electron';
import type {
  BrowserElementContext,
  BrowserSelectionMode,
  BrowserSelectionPoint,
  BrowserSelectionPreview,
  BrowserSelectionRect,
} from '@dex/protocol/browser';

const MAX_CAPTURE_EDGE = 1600;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const JPEG_QUALITY = 84;

interface BrowserSelectionDomResult {
  rect: BrowserSelectionRect;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  elements: BrowserElementContext[];
}

/**
 * Runs in the guest page. It returns only an allowlisted semantic summary:
 * never input values, data-* attributes, inline handlers, storage or raw HTML.
 */
const BROWSER_SELECTION_SCRIPT = String.raw`
((request) => {
  const MAX_ELEMENTS = 30;
  const MAX_TEXT = 500;
  const semanticSelector = [
    'a', 'button', 'input', 'textarea', 'select', 'option', 'label', 'img', 'iframe',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'dt', 'dd', 'td', 'th',
    'pre', 'code', 'blockquote', 'article', 'section', '[role]', '[aria-label]'
  ].join(',');

  const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const viewport = {
    width: Math.max(0, finite(window.innerWidth)),
    height: Math.max(0, finite(window.innerHeight)),
    scrollX: Math.max(0, finite(window.scrollX)),
    scrollY: Math.max(0, finite(window.scrollY)),
  };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, finite(value)));
  const normalizeRect = (raw) => {
    const x1 = clamp(raw && raw.x, 0, viewport.width);
    const y1 = clamp(raw && raw.y, 0, viewport.height);
    const x2 = clamp(x1 + Math.max(0, finite(raw && raw.width)), 0, viewport.width);
    const y2 = clamp(y1 + Math.max(0, finite(raw && raw.height)), 0, viewport.height);
    return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
  };
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: finite(rect.left),
      y: finite(rect.top),
      width: Math.max(0, finite(rect.width)),
      height: Math.max(0, finite(rect.height)),
    };
  };
  const intersects = (a, b) =>
    a.width > 0 && a.height > 0 &&
    a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;
  const clean = (value, limit = MAX_TEXT) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const escapeHtml = (value) => clean(value, 800)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const secret = (element) => {
    if (!(element instanceof Element)) return false;
    const type = clean(element.getAttribute('type'), 40).toLowerCase();
    const autocomplete = clean(element.getAttribute('autocomplete'), 80).toLowerCase();
    return type === 'password' || type === 'hidden' ||
      /(?:password|one-time-code|cc-number|cc-csc)/.test(autocomplete);
  };
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = rectOf(element);
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
  };
  const safeUrl = (raw) => {
    try {
      const url = new URL(String(raw || ''), document.baseURI);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin + url.pathname : '';
    } catch { return ''; }
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'li') return 'listitem';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'input') {
      const type = clean(element.getAttribute('type'), 40).toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return '';
  };
  const cssPath = (element) => {
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === 1 && depth < 6; depth += 1) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ').slice(0, 400);
  };
  const textFor = (element) => {
    if (secret(element)) return '[redacted]';
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') return '';
    return clean(element.innerText || element.textContent || '');
  };
  const nameFor = (element, text) => {
    if (secret(element)) return '[redacted]';
    const labelled = clean(element.getAttribute('aria-label'));
    const alt = clean(element.getAttribute('alt'));
    const title = clean(element.getAttribute('title'));
    const placeholder = clean(element.getAttribute('placeholder'));
    let label = '';
    if ('labels' in element && element.labels && element.labels.length) {
      label = clean(Array.from(element.labels).map((item) => item.innerText || item.textContent || '').join(' '));
    }
    return labelled || alt || title || label || placeholder || text.slice(0, 160);
  };
  const describe = (element) => {
    if (!(element instanceof Element) || !visible(element)) return null;
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return null;
    const rect = rectOf(element);
    const role = clean(element.getAttribute('role'), 80) || implicitRole(element);
    const text = textFor(element);
    const name = nameFor(element, text);
    const href = tag === 'a' ? safeUrl(element.getAttribute('href')) : '';
    const attrs = [];
    if (role) attrs.push('role="' + escapeHtml(role) + '"');
    if (name && name !== text) attrs.push('aria-label="' + escapeHtml(name) + '"');
    if (href) attrs.push('href="' + escapeHtml(href) + '"');
    const htmlText = secret(element) ? '[redacted]' : (text || name).slice(0, 300);
    const html = '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' +
      escapeHtml(htmlText) + '</' + tag + '>';
    return {
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      selector: cssPath(element),
      ...(href ? { href } : {}),
      html: html.slice(0, 1000),
      rect,
    };
  };
  const deepElementFromPoint = (x, y) => {
    let element = document.elementFromPoint(x, y);
    while (element && element.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
      const nested = element.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === element) break;
      element = nested;
    }
    return element;
  };

  if (request.action === 'inspect') {
    const point = {
      x: clamp(request.point && request.point.x, 0, Math.max(0, viewport.width - 1)),
      y: clamp(request.point && request.point.y, 0, Math.max(0, viewport.height - 1)),
    };
    const element = deepElementFromPoint(point.x, point.y);
    const described = describe(element);
    if (!described) return null;
    return {
      tag: described.tag,
      label: described.name || described.text || described.tag,
      rect: described.rect,
    };
  }

  if (request.mode === 'element') {
    const point = {
      x: clamp(request.point && request.point.x, 0, Math.max(0, viewport.width - 1)),
      y: clamp(request.point && request.point.y, 0, Math.max(0, viewport.height - 1)),
    };
    const element = deepElementFromPoint(point.x, point.y);
    const described = describe(element);
    return described ? { rect: described.rect, viewport, elements: [described] } : null;
  }

  const selection = normalizeRect(request.rect || {});
  if (selection.width < 4 || selection.height < 4) return null;
  const candidates = Array.from(document.querySelectorAll(semanticSelector)).slice(0, 2500);
  const center = deepElementFromPoint(selection.x + selection.width / 2, selection.y + selection.height / 2);
  if (center) candidates.unshift(center);
  const seenElements = new Set();
  const described = [];
  for (const element of candidates) {
    if (seenElements.has(element)) continue;
    seenElements.add(element);
    const item = describe(element);
    if (!item || !intersects(item.rect, selection)) continue;
    described.push(item);
  }
  described.sort((a, b) => {
    const important = (item) => /^(button|link|heading|textbox|checkbox|radio|combobox|img|cell)$/.test(item.role || '') ? 1 : 0;
    const roleDiff = important(b) - important(a);
    if (roleDiff) return roleDiff;
    return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
  });
  const unique = [];
  const textKeys = new Set();
  for (const item of described) {
    const key = (item.role || '') + '|' + (item.name || '') + '|' + (item.text || '');
    if (key !== '||' && textKeys.has(key)) continue;
    if (key !== '||') textKeys.add(key);
    unique.push(item);
    if (unique.length >= MAX_ELEMENTS) break;
  }
  return { rect: selection, viewport, elements: unique };
})
`;

function validCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizedSelectionRect(raw: BrowserSelectionRect): BrowserSelectionRect | null {
  if (
    !validCoordinate(raw?.x) ||
    !validCoordinate(raw?.y) ||
    !validCoordinate(raw?.width) ||
    !validCoordinate(raw?.height)
  ) {
    return null;
  }
  const x1 = Math.min(raw.x, raw.x + raw.width);
  const y1 = Math.min(raw.y, raw.y + raw.height);
  const x2 = Math.max(raw.x, raw.x + raw.width);
  const y2 = Math.max(raw.y, raw.y + raw.height);
  const rect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  return rect.width >= 4 && rect.height >= 4 ? rect : null;
}

function validPoint(point: BrowserSelectionPoint): boolean {
  return validCoordinate(point?.x) && validCoordinate(point?.y);
}

async function evaluateSelection<T>(contents: WebContents, request: unknown): Promise<T | null> {
  const expression = `${BROWSER_SELECTION_SCRIPT}(${JSON.stringify(request)})`;
  const result = await contents.executeJavaScript(expression);
  return result && typeof result === 'object' ? (result as T) : null;
}

export async function inspectBrowserSelection(
  contents: WebContents,
  point: BrowserSelectionPoint,
): Promise<BrowserSelectionPreview | null> {
  if (!validPoint(point)) return null;
  return evaluateSelection<BrowserSelectionPreview>(contents, { action: 'inspect', point });
}

export async function collectBrowserSelection(
  contents: WebContents,
  mode: BrowserSelectionMode,
  target: { point?: BrowserSelectionPoint; rect?: BrowserSelectionRect },
): Promise<BrowserSelectionDomResult | null> {
  if (mode === 'element') {
    if (!target.point || !validPoint(target.point)) return null;
    return evaluateSelection<BrowserSelectionDomResult>(contents, {
      action: 'collect',
      mode,
      point: target.point,
    });
  }
  const rect = target.rect ? normalizedSelectionRect(target.rect) : null;
  if (!rect) return null;
  return evaluateSelection<BrowserSelectionDomResult>(contents, {
    action: 'collect',
    mode,
    rect,
  });
}

function captureRect(
  rect: BrowserSelectionRect,
  viewport: BrowserSelectionDomResult['viewport'],
): BrowserSelectionRect | null {
  const padding = 4;
  const x1 = Math.max(0, Math.floor(rect.x - padding));
  const y1 = Math.max(0, Math.floor(rect.y - padding));
  const x2 = Math.min(viewport.width, Math.ceil(rect.x + rect.width + padding));
  const y2 = Math.min(viewport.height, Math.ceil(rect.y + rect.height + padding));
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export async function captureBrowserSelection(
  contents: WebContents,
  dom: BrowserSelectionDomResult,
  name: string,
): Promise<{
  dataUrl: string;
  name: string;
  mime: 'image/png' | 'image/jpeg';
  size: number;
  width: number;
  height: number;
}> {
  const rect = captureRect(dom.rect, dom.viewport);
  if (!rect) throw new Error('선택 영역이 현재 페이지 화면 밖에 있습니다.');
  let image = await contents.capturePage(rect);
  if (!image || image.isEmpty()) throw new Error('선택 영역을 캡처하지 못했습니다.');
  const original = image.getSize();
  const longest = Math.max(original.width, original.height);
  if (longest > MAX_CAPTURE_EDGE) {
    const ratio = MAX_CAPTURE_EDGE / longest;
    image = image.resize({
      width: Math.max(1, Math.round(original.width * ratio)),
      height: Math.max(1, Math.round(original.height * ratio)),
      quality: 'best',
    });
  }
  const size = image.getSize();
  let mime: 'image/png' | 'image/jpeg' = 'image/png';
  let bytes = image.toPNG();
  if (bytes.byteLength > MAX_PNG_BYTES) {
    mime = 'image/jpeg';
    bytes = image.toJPEG(JPEG_QUALITY);
  }
  return {
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    name: `${name}.${mime === 'image/png' ? 'png' : 'jpg'}`,
    mime,
    size: bytes.byteLength,
    width: size.width,
    height: size.height,
  };
}
