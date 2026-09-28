/**
 * IDE 아이콘 — 인라인 SVG(16×16, 선 1.25).
 *
 * 글꼴 아이콘(codicon)은 호스트 번들러가 글꼴 파일을 처리해야 해서 데스크톱·웹 두 곳의
 * 빌드를 건드린다. 그림 몇십 개라 직접 그린다 — 색은 currentColor 를 따른다.
 */
import type { ReactElement, SVGProps } from 'react';

export type IconName =
  | 'files'
  | 'search'
  | 'scm'
  | 'terminal'
  | 'chat'
  | 'close'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'file'
  | 'folder'
  | 'folder-open'
  | 'new-file'
  | 'new-folder'
  | 'refresh'
  | 'collapse'
  | 'more'
  | 'check'
  | 'plus'
  | 'minus'
  | 'discard'
  | 'go-to-file'
  | 'split'
  | 'trash'
  | 'maximize'
  | 'restore'
  | 'link-external'
  | 'key'
  | 'account'
  | 'regex'
  | 'case'
  | 'word'
  | 'replace'
  | 'replace-all'
  | 'dot'
  | 'warning'
  | 'error'
  | 'info'
  | 'sync'
  | 'arrow-up'
  | 'arrow-down'
  | 'branch'
  | 'commit'
  | 'cloud'
  | 'upload'
  | 'download'
  | 'copy'
  | 'lock'
  | 'image'
  | 'stash'
  | 'history'
  | 'layout-sidebar'
  | 'layout-panel'
  | 'settings';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const SHAPES: Record<IconName, ReactElement> = {
  files: (
    <>
      <path {...P} d="M9.5 1.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
      <path {...P} d="M9.5 1.5v3h3" />
      <path {...P} d="M1.5 4.5v9a1 1 0 0 0 1 1h7" />
    </>
  ),
  search: (
    <>
      <circle {...P} cx="9.5" cy="6.5" r="4" />
      <path {...P} d="M6.6 9.4 1.8 14.2" />
    </>
  ),
  scm: (
    <>
      <circle {...P} cx="4.5" cy="3" r="1.6" />
      <circle {...P} cx="4.5" cy="13" r="1.6" />
      <circle {...P} cx="11.5" cy="5.5" r="1.6" />
      <path {...P} d="M4.5 4.6v6.8M11.5 7.1c0 2.4-2.2 3-4 3.4-1.4.3-3 .8-3 2" />
    </>
  ),
  terminal: (
    <>
      <rect {...P} x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path {...P} d="m4 6 2.2 2L4 10M7.8 10.5h4" />
    </>
  ),
  chat: (
    <path {...P} d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.5a1 1 0 0 1-1-1z" />
  ),
  close: <path {...P} d="m4 4 8 8M12 4l-8 8" />,
  'chevron-right': <path {...P} d="m6 3.5 4.5 4.5L6 12.5" />,
  'chevron-down': <path {...P} d="M3.5 6 8 10.5 12.5 6" />,
  'chevron-up': <path {...P} d="M3.5 10 8 5.5 12.5 10" />,
  file: (
    <>
      <path {...P} d="M9 1.5H3.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6z" />
      <path {...P} d="M9 1.5V6h4.5" />
    </>
  ),
  folder: <path {...P} d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />,
  'folder-open': (
    <>
      <path {...P} d="M1.5 12V4a1 1 0 0 1 1-1h3.6l1.5 1.5h5a1 1 0 0 1 1 1V7" />
      <path {...P} d="M1.5 12 3.6 7.6a1 1 0 0 1 .9-.6h10l-2.2 5.4a1 1 0 0 1-.9.6h-9.9" />
    </>
  ),
  'new-file': (
    <>
      <path {...P} d="M8.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1H7" />
      <path {...P} d="M8.5 1.5v4h4v2M12 10v5M9.5 12.5h5" />
    </>
  ),
  'new-folder': (
    <>
      <path {...P} d="M7.5 13h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V8" />
      <path {...P} d="M12 10v5M9.5 12.5h5" />
    </>
  ),
  refresh: (
    <>
      <path {...P} d="M13.5 8A5.5 5.5 0 1 1 11.8 4" />
      <path {...P} d="M12.3 1.5v3h-3" />
    </>
  ),
  collapse: (
    <>
      <rect {...P} x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path {...P} d="M5.5 8h5" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
    </>
  ),
  check: <path {...P} d="m2.5 8.5 3.5 3.5 7.5-8" />,
  plus: <path {...P} d="M8 2.5v11M2.5 8h11" />,
  minus: <path {...P} d="M2.5 8h11" />,
  discard: (
    <>
      <path {...P} d="M5 6.5H10a3.5 3.5 0 0 1 0 7H6" />
      <path {...P} d="M7.5 3.5 4.5 6.5l3 3" />
    </>
  ),
  'go-to-file': (
    <>
      <path {...P} d="M8.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6.5" />
      <path {...P} d="M10 1.5h4v4M14 1.5 8.5 7" />
    </>
  ),
  split: (
    <>
      <rect {...P} x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path {...P} d="M8 2.5v11" />
    </>
  ),
  trash: (
    <>
      <path {...P} d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4" />
      <path {...P} d="M6.8 6.5v4.5M9.2 6.5v4.5" />
    </>
  ),
  maximize: <path {...P} d="M3.5 10 8 5.5l4.5 4.5" />,
  restore: <path {...P} d="M3.5 6 8 10.5 12.5 6" />,
  'link-external': (
    <>
      <path {...P} d="M12.5 9.5v3a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1h3" />
      <path {...P} d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    </>
  ),
  key: (
    <>
      <circle {...P} cx="5" cy="11" r="2.8" />
      <path {...P} d="m7 9 6.5-6.5M11 4.5l1.8 1.8M9.5 6l1.3 1.3" />
    </>
  ),
  account: (
    <>
      <circle {...P} cx="8" cy="5.5" r="3" />
      <path {...P} d="M2.5 14c.6-2.8 2.8-4.2 5.5-4.2s4.9 1.4 5.5 4.2" />
    </>
  ),
  regex: (
    <>
      <path {...P} d="M10.5 2v6M8 3.5l5 3M8 6.5l5-3" />
      <rect x="2.5" y="10.5" width="3" height="3" rx=".5" fill="currentColor" />
    </>
  ),
  case: (
    <path
      {...P}
      d="M1.5 12 4.3 4h.9L8 12M2.5 9.5h4.5M12 12V8.8c0-1.3-.8-1.8-1.8-1.8-.8 0-1.4.3-1.8.9M12 9.8H10.3c-1.1 0-1.8.5-1.8 1.2 0 .7.6 1.1 1.4 1.1 1.3 0 2.1-.8 2.1-2.3"
    />
  ),
  word: (
    <>
      <path {...P} d="M1.5 13.5h13M1.5 11.5v2M14.5 11.5v2" />
      <path {...P} d="M3 10V4M3 7.2C3 6 3.8 5.3 4.8 5.3S6.6 6 6.6 7.6 5.8 10 4.8 10 3 9.3 3 8.2M13 5.8c-.4-.4-.9-.5-1.4-.5-1 0-1.9.8-1.9 2.4s.9 2.3 1.9 2.3c.5 0 1-.2 1.4-.5" />
    </>
  ),
  replace: (
    <>
      <path {...P} d="M2.5 5.5h7l-2-2M13.5 10.5h-7l2 2" />
    </>
  ),
  'replace-all': (
    <>
      <path {...P} d="M2.5 4.5h7l-2-2M13.5 9.5h-7l2 2M2.5 14h11" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="3.5" fill="currentColor" />,
  warning: (
    <>
      <path {...P} d="M8 2 14.5 13.5h-13z" />
      <path {...P} d="M8 6.5v3.2M8 11.6v.1" />
    </>
  ),
  error: (
    <>
      <circle {...P} cx="8" cy="8" r="6" />
      <path {...P} d="m5.8 5.8 4.4 4.4M10.2 5.8l-4.4 4.4" />
    </>
  ),
  info: (
    <>
      <circle {...P} cx="8" cy="8" r="6" />
      <path {...P} d="M8 7.2v4M8 4.9v.1" />
    </>
  ),
  sync: (
    <>
      <path {...P} d="M13 6.5A5.2 5.2 0 0 0 3.7 4.5M3 9.5a5.2 5.2 0 0 0 9.3 2" />
      <path {...P} d="M3.5 1.8v2.9h2.9M12.5 14.2v-2.9H9.6" />
    </>
  ),
  'arrow-up': <path {...P} d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />,
  'arrow-down': <path {...P} d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />,
  branch: (
    <>
      <circle {...P} cx="4.5" cy="3" r="1.6" />
      <circle {...P} cx="4.5" cy="13" r="1.6" />
      <circle {...P} cx="11.5" cy="4.5" r="1.6" />
      <path {...P} d="M4.5 4.6v6.8M11.5 6.1v.4c0 2.2-1.8 3-3.5 3.3-1.7.3-3.5 1-3.5 2.4" />
    </>
  ),
  commit: (
    <>
      <circle {...P} cx="8" cy="8" r="2.8" />
      <path {...P} d="M1.5 8h3.7M10.8 8h3.7" />
    </>
  ),
  cloud: <path {...P} d="M4.5 12.5a3 3 0 0 1-.4-6A4.2 4.2 0 0 1 12 5.6a3.4 3.4 0 0 1 .4 6.9z" />,
  upload: (
    <>
      <path {...P} d="M8 11V2.5M4.5 6 8 2.5 11.5 6" />
      <path {...P} d="M2.5 11v2.5h11V11" />
    </>
  ),
  download: (
    <>
      <path {...P} d="M8 2.5V11M4.5 7.5 8 11l3.5-3.5" />
      <path {...P} d="M2.5 11v2.5h11V11" />
    </>
  ),
  copy: (
    <>
      <rect {...P} x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path {...P} d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  lock: (
    <>
      <rect {...P} x="3" y="7" width="10" height="7" rx="1" />
      <path {...P} d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" />
    </>
  ),
  image: (
    <>
      <rect {...P} x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle {...P} cx="5.5" cy="6" r="1.2" />
      <path {...P} d="m1.5 12 4-3.5 3 2.5 2-1.5 4 3" />
    </>
  ),
  stash: (
    <>
      <path {...P} d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
      <path {...P} d="M2.5 9.5h3.5l.8 1.5h2.4l.8-1.5h3.5M8 2.5V8M5.5 5.5 8 8l2.5-2.5" />
    </>
  ),
  history: (
    <>
      <path {...P} d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" />
      <path {...P} d="M2.5 2.5v2.8h2.8M8 5v3.2l2 1.3" />
    </>
  ),
  'layout-sidebar': (
    <>
      <rect {...P} x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path {...P} d="M5.5 2.5v11" />
    </>
  ),
  'layout-panel': (
    <>
      <rect {...P} x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path {...P} d="M1.5 9.5h13" />
    </>
  ),
  settings: (
    <>
      <circle {...P} cx="8" cy="8" r="2.2" />
      <path
        {...P}
        d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"
      />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  title,
  ...rest
}: { name: IconName; size?: number; title?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className="xide-icon"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {SHAPES[name]}
    </svg>
  );
}

/** 파일 종류 표시 — 확장자별 색 점과 두세 글자(편집기 탭·탐색기·빠른 열기). */
const FILE_KIND: Record<string, { label: string; color: string }> = {
  ts: { label: 'TS', color: '#3178c6' },
  tsx: { label: 'TSX', color: '#3178c6' },
  js: { label: 'JS', color: '#e8c33b' },
  jsx: { label: 'JSX', color: '#e8c33b' },
  mjs: { label: 'JS', color: '#e8c33b' },
  cjs: { label: 'JS', color: '#e8c33b' },
  json: { label: '{}', color: '#cbcb41' },
  py: { label: 'PY', color: '#3d8fd1' },
  ipynb: { label: 'NB', color: '#f37626' },
  md: { label: 'MD', color: '#519aba' },
  markdown: { label: 'MD', color: '#519aba' },
  html: { label: '<>', color: '#e44d26' },
  css: { label: '#', color: '#42a5f5' },
  scss: { label: '#', color: '#cd6799' },
  go: { label: 'GO', color: '#00add8' },
  rs: { label: 'RS', color: '#dea584' },
  java: { label: 'J', color: '#cc3e44' },
  kt: { label: 'KT', color: '#a97bff' },
  c: { label: 'C', color: '#599eff' },
  h: { label: 'H', color: '#a074c4' },
  cpp: { label: 'C++', color: '#f34b7d' },
  cs: { label: 'C#', color: '#68217a' },
  rb: { label: 'RB', color: '#cc342d' },
  php: { label: 'PHP', color: '#8993be' },
  sh: { label: '$', color: '#89e051' },
  bash: { label: '$', color: '#89e051' },
  yml: { label: 'YML', color: '#cb171e' },
  yaml: { label: 'YML', color: '#cb171e' },
  toml: { label: 'TOML', color: '#9c4221' },
  sql: { label: 'SQL', color: '#e38c00' },
  txt: { label: 'TXT', color: '#8a8a8a' },
  csv: { label: 'CSV', color: '#89e051' },
  xml: { label: 'XML', color: '#e37933' },
  svg: { label: 'SVG', color: '#ffb13b' },
  vue: { label: 'VUE', color: '#41b883' },
  svelte: { label: 'SV', color: '#ff3e00' },
  dockerfile: { label: 'DKR', color: '#384d54' },
  lock: { label: 'LCK', color: '#8a8a8a' },
  env: { label: 'ENV', color: '#faf743' },
};

export function fileKind(name: string): { label: string; color: string } | null {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return FILE_KIND.dockerfile;
  if (lower.startsWith('.env')) return FILE_KIND.env;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return FILE_KIND[ext] ?? null;
}

export function FileIcon({ name, open, isDir }: { name: string; open?: boolean; isDir?: boolean }) {
  if (isDir) return <Icon name={open ? 'folder-open' : 'folder'} className="xide-icon xide-folder-icon" />;
  const kind = fileKind(name);
  if (/\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(name)) return <Icon name="image" className="xide-icon xide-file-image" />;
  if (!kind) return <Icon name="file" className="xide-icon xide-file-generic" />;
  return (
    <span className="xide-file-badge" style={{ color: kind.color }} aria-hidden>
      {kind.label}
    </span>
  );
}
