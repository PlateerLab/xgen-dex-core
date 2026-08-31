/**
 * markdown-core — pure text→HTML/segment helpers for the connector's chat.
 *
 * The XGEN web chat renders markdown with a hand-rolled parser (no react-markdown);
 * the connector showed raw `**bold**` / ```` ``` ```` / `- lists`. This module ports
 * the CORE of that parser so the connector renders the SAME way: inline emphasis,
 * code, links (sanitized), plus the "unglue" normalization that makes LLM output
 * (headers/lists glued to the previous sentence) parse. The XGEN-web-specific
 * surfaces (KaTeX math, think/tool/feedback blocks, download buttons) are dropped —
 * the connector handles tools/citations separately and never receives those markers.
 *
 * Framework-agnostic (no React) so it is unit-tested directly; `Markdown.tsx`
 * turns the block structure into React nodes.
 */

/** Escape raw HTML so external/agent text can't inject markup (XSS / layout break).
 *  Called BEFORE we add our own trusted <code>/<strong>/<a> tags. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Validate a markdown link href to a protocol allowlist — block javascript:/data:
 *  and protocol-relative (//host); allow http/https/mailto/tel + relative (/,#). */
export function sanitizeLinkHref(href: string): string {
  const raw = decodeHtmlAttribute(href).trim();
  if (!raw) return '#';
  if (raw.startsWith('//')) return '#';
  if (raw.startsWith('/') || raw.startsWith('#')) return escapeHtml(raw);
  try {
    const url = new URL(raw);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return escapeHtml(url.toString());
  } catch {
    return '#';
  }
  return '#';
}

// Sentinel to protect inline-code content from further inline processing.
const CODE_SENTINEL = String.fromCharCode(0xe010);

/** Inline markdown → HTML: code, bold, italic, strikethrough, links.
 *  Input is escaped first; only our own trusted tags are added. Inline `code`
 *  content is masked BEFORE emphasis/links so markdown inside code (e.g.
 *  `**x**`) stays literal instead of being bolded (an improvement over the web
 *  renderer, which processes those in-place). */
export function processInlineMarkdown(text: string): string {
  let p = escapeHtml(text);
  const codes: string[] = [];
  p = p.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    const tok = `${CODE_SENTINEL}${codes.length}${CODE_SENTINEL}`;
    codes.push(`<code class="md-inline-code">${c}</code>`);
    return tok;
  });
  p = p.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  p = p.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  p = p.replace(/(?<!\*)\*([^*\s][^*]*[^*\s]|\S)\*(?!\*)/g, '<em>$1</em>');
  p = p.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  p = p.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, href: string) =>
      `<a href="${sanitizeLinkHref(href)}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`,
  );
  p = p.replace(new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, 'g'), (_m, i: string) => codes[Number(i)] ?? '');
  return p;
}

/** Normalize exotic vertical-bar lookalikes to ASCII `|` so GFM tables parse. */
export function normalizeTableSeparators(text: string): string {
  return text
    .replace(/∣/g, '|').replace(/∣/g, '|').replace(/│/g, '|')
    .replace(/｜/g, '|').replace(/｜/g, '|').replace(/│/g, '|')
    .replace(/ǀ/g, '|').replace(/׀/g, '|')
    .replace(/❘/g, '|').replace(/❙/g, '|').replace(/❚/g, '|');
}

// Sentinel to protect emphasis spans while separating glued lists/headers.
const UNGLUE_SENTINEL = String.fromCharCode(0xe000);

/**
 * Insert the newlines LLMs omit before block markers, so a header/list glued to
 * the previous sentence ("…다.### 제목", "…음* 항목") still parses. Emphasis is
 * masked first so the list/header regexes don't chew on `*`/`_`. Ported from the
 * web renderer (core subset — the exhaustive GPT/Qwen table fixes are out of scope).
 */
export function ungluMarkdownMarkers(text: string): string {
  const spans: string[] = [];
  const mask = (re: RegExp): void => {
    text = text.replace(re, (m) => {
      const tok = `${UNGLUE_SENTINEL}${spans.length}${UNGLUE_SENTINEL}`;
      spans.push(m);
      return tok;
    });
  };
  mask(/\*\*[^\n*]+\*\*/g); // **bold**
  mask(/__[^\n_]+__/g); // __bold__
  mask(/(?<![\w*])\*(?!\s)(?:(?!\*|\* )[^\n])*\*(?![\w*])/g); // *em*

  let s = text;
  // header marker missing space: "###제목" → "### 제목"
  s = s.replace(/(#{2,6})([^\s#])/g, '$1 $2');
  // header glued mid-line → break before it
  s = s.replace(/([^\n#])(#{1,6}[ \t]+\S)/g, '$1\n\n$2');
  // ordered list glued (skip decimals like 3.14 and header-internal "1. ")
  s = s.replace(/([^\n\d#\s])(\d+\.[ \t]+\S)/g, '$1\n$2');
  // unordered list glued (skip "**"/"---" and table cells "- |")
  s = s.replace(/([^\n\s])([*+-][ \t]+\S)/g, (m: string, before: string, marker: string) => {
    if (/^([*+-])\1/.test(marker)) return m;
    if (marker.endsWith('|')) return m;
    if (before === ':' || before === '-') return m;
    return `${before}\n${marker}`;
  });
  // horizontal rule glued mid-sentence → isolate (dates 2026-05-13 are single hyphens)
  s = s.replace(/([^\s|:-])(-{3,})(?=[^\s|:-])/g, '$1\n\n$2\n\n');
  // row boundary || → split rows
  s = s.replace(/\|\|/g, '|\n|');

  // restore emphasis spans
  s = s.replace(new RegExp(`${UNGLUE_SENTINEL}(\\d+)${UNGLUE_SENTINEL}`, 'g'), (_m, i: string) => spans[Number(i)] ?? '');
  return s;
}

export type MdSegment =
  | { kind: 'text'; content: string }
  | { kind: 'code'; language: string; code: string; closed: boolean };

/**
 * Split text into fenced-code and text segments. A trailing ``` fence that hasn't
 * closed yet (streaming) is emitted as an OPEN code segment so it renders as code
 * live instead of showing raw backticks.
 */
export function splitFences(text: string): MdSegment[] {
  const segments: MdSegment[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: 'text', content: text.slice(last, m.index) });
    segments.push({ kind: 'code', language: (m[1] || '').trim(), code: m[2].replace(/\n$/, ''), closed: true });
    last = fence.lastIndex;
  }
  const rest = text.slice(last);
  // An unterminated fence in the remainder → open code block (streaming).
  const open = rest.match(/```([^\n`]*)\n?([\s\S]*)$/);
  if (open) {
    const before = rest.slice(0, open.index);
    if (before) segments.push({ kind: 'text', content: before });
    segments.push({ kind: 'code', language: (open[1] || '').trim(), code: open[2].replace(/\n$/, ''), closed: false });
  } else if (rest) {
    segments.push({ kind: 'text', content: rest });
  }
  return segments;
}

/**
 * Inline HTML for the avatar SUBTITLE — a compact bubble where full block layout
 * (tables/code) would be out of place. Renders inline emphasis and cleans block
 * markers per line (headers → plain, bullets → •, fence lines dropped) so the
 * spoken text reads naturally instead of showing raw `**`/`###`/```` ``` ````.
 * Safe on a streaming prefix: unbalanced markers just stay literal.
 */
export function inlineMarkdownHtml(text: string): string {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    if (/^\s*```/.test(line)) continue; // drop fence lines
    line = line.replace(/^\s*#{1,6}\s+/, ''); // header → plain
    line = line.replace(/^\s*>\s?/, ''); // blockquote marker
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• '); // bullet
    out.push(processInlineMarkdown(line));
  }
  return out.join('<br/>');
}
