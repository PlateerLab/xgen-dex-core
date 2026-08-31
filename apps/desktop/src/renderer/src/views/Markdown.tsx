/**
 * Markdown — renders assistant chat text the way the XGEN web chat does.
 *
 * Splits fenced code blocks out (rendered with a copy button), then parses the
 * remaining text into blocks (headings, lists, tables, blockquotes, rules,
 * paragraphs) with inline emphasis. Partial markdown mid-stream renders safely —
 * unclosed markers stay literal until they close. Theme-aware via CSS tokens
 * (light/dark), unlike the web's hardcoded light styles.
 */
import React, { useState } from 'react';
import { copyText } from '../bridge';
import {
  inlineMarkdownHtml,
  normalizeTableSeparators,
  processInlineMarkdown,
  splitFences,
  ungluMarkdownMarkers,
} from '../markdown-core';

const HEAD_CLASS: Record<number, string> = {
  1: 'md-h1',
  2: 'md-h2',
  3: 'md-h3',
  4: 'md-h4',
  5: 'md-h5',
  6: 'md-h6',
};

const isTableLine = (s: string): boolean => s.trim().includes('|');
const isTableSep = (s: string): boolean =>
  /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*\|?)\s*$/.test(s.trim());
const parseRow = (s: string): string[] =>
  s
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/** Turn a text segment (no code fences) into block React nodes. */
function parseBlocks(text: string, startKey: string): React.ReactNode[] {
  if (!text.trim()) return [];
  const inline = (s: string): { __html: string } => ({ __html: processInlineMarkdown(s) });
  const normalized = normalizeTableSeparators(ungluMarkdownMarkers(text));

  // collapse runs of blank lines
  const lines: string[] = [];
  let lastEmpty = false;
  for (const line of normalized.split('\n')) {
    const empty = !line.trim();
    if (empty && lastEmpty) continue;
    lines.push(line);
    lastEmpty = empty;
  }

  const out: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = `${startKey}-${i}`;
    const next = lines[i + 1];

    // GFM table
    if (isTableLine(line) && next && isTableSep(next)) {
      const body: string[] = [];
      let j = i + 2;
      while (j < lines.length && isTableLine(lines[j]) && !isTableSep(lines[j])) {
        body.push(lines[j]);
        j++;
      }
      const aligns = next
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((s) => {
          const t = s.trim();
          if (t.startsWith(':') && t.endsWith(':')) return 'center' as const;
          if (t.endsWith(':')) return 'right' as const;
          return 'left' as const;
        });
      const headers = parseRow(line);
      out.push(
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, idx) => (
                  <th
                    key={idx}
                    style={{ textAlign: aligns[idx] || 'left' }}
                    dangerouslySetInnerHTML={inline(h)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => {
                const cells = parseRow(row);
                return (
                  <tr key={ri}>
                    {cells.map((c, ci) => (
                      <td
                        key={ci}
                        style={{ textAlign: aligns[ci] || 'left' }}
                        dangerouslySetInnerHTML={inline(c)}
                      />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }

    // horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      out.push(<hr className="md-hr" key={key} />);
      continue;
    }

    // heading
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      out.push(
        <div
          className={`md-h ${HEAD_CLASS[hm[1].length]}`}
          key={key}
          dangerouslySetInnerHTML={inline(hm[2])}
        />,
      );
      continue;
    }

    // blockquote
    const bq = line.match(/^>\s*(.+)$/);
    if (bq) {
      out.push(
        <blockquote className="md-quote" key={key} dangerouslySetInnerHTML={inline(bq[1])} />,
      );
      continue;
    }

    // ordered list item
    const ol = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (ol) {
      out.push(
        <div className="md-li" key={key} style={{ marginLeft: `${ol[1].length * 0.9}rem` }}>
          <span className="md-li-marker md-ol">{ol[2]}.</span>
          <span dangerouslySetInnerHTML={inline(ol[3])} />
        </div>,
      );
      continue;
    }

    // unordered list item
    const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ul) {
      out.push(
        <div className="md-li" key={key} style={{ marginLeft: `${ul[1].length * 0.9}rem` }}>
          <span className="md-li-marker md-ul">•</span>
          <span dangerouslySetInnerHTML={inline(ul[2])} />
        </div>,
      );
      continue;
    }

    // paragraph / blank spacer
    if (line.trim()) {
      out.push(<div className="md-p" key={key} dangerouslySetInnerHTML={inline(line)} />);
    } else if (out.length > 0 && lines[i - 1]?.trim() !== '') {
      out.push(<div className="md-gap" key={key} />);
    }
  }
  return out;
}

const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const ok = await copyText(code);
    if (!ok) return; // 복사 실패 시 "복사됨" 으로 바꾸지 않는다
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{language || 'text'}</span>
        <button className="md-code-copy" onClick={() => void copy()}>
          {copied ? '✓ 복사됨' : '복사'}
        </button>
      </div>
      <pre className="md-code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
};

/** Full markdown for chat bubbles. */
export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const segments = splitFences(text || '');
  return (
    <div className={`md ${className ?? ''}`}>
      {segments.map((seg, i) =>
        seg.kind === 'code' ? (
          <CodeBlock key={`c-${i}`} language={seg.language} code={seg.code} />
        ) : (
          <React.Fragment key={`t-${i}`}>{parseBlocks(seg.content, `s${i}`)}</React.Fragment>
        ),
      )}
    </div>
  );
};

/** Inline-only markdown for the avatar subtitle (compact, streaming-prefix safe). */
export const SubtitleMarkdown: React.FC<{ text: string }> = ({ text }) => (
  <span
    className="md-inline"
    dangerouslySetInnerHTML={{ __html: inlineMarkdownHtml(text || '') }}
  />
);
