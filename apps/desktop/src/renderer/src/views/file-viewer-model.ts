/**
 * 파일 뷰어 순수 모델 — React 없이 단위 테스트되는 부분.
 *
 * 탐색기에서 파일을 클릭하면 콘텐츠 영역 탭으로 여는 뷰어가, 확장자·내용으로
 * "어떻게 그릴지"를 정하는 규칙이 전부 여기 있다:
 *
 *   code     → VS Code 풍 읽기 전용 에디터 (줄 번호 + 구문 강조)
 *   markdown → 렌더 보기 (원본 토글)
 *   image / pdf / audio / video → 브라우저 네이티브 렌더 (Blob URL)
 *   csv      → 표 렌더 (원본 토글)
 *   office   → 서버 렌더 페이지 이미지 (웹 [파일 저장소]와 동일 계약,
 *              클라우드 섹션에서만 — 경로→항목 해석이 필요해서)
 *   binary   → 정보 패널 (다운로드/OS 열기)
 */

export type ViewerKind =
  | 'code'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'csv'
  | 'office'
  | 'binary';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v']);
const OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx']);

/** 구문 강조 언어 매핑 — highlight.js 언어 id. 텍스트로 열 수 있는 확장자의
 *  전체 목록이기도 하다 (없으면 code 로 열되 plaintext). */
const LANG_BY_EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', php: 'php', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', swift: 'swift', scala: 'scala',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
  sql: 'sql', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
  conf: 'ini', env: 'ini', properties: 'ini',
  dockerfile: 'dockerfile', makefile: 'makefile', cmake: 'cmake',
  gradle: 'gradle', groovy: 'groovy', lua: 'lua', r: 'r', pl: 'perl', dart: 'dart',
  diff: 'diff', patch: 'diff', graphql: 'graphql', proto: 'protobuf',
  md: 'markdown', markdown: 'markdown', txt: 'plaintext', text: 'plaintext', log: 'plaintext',
  gitignore: 'plaintext', gitattributes: 'plaintext', editorconfig: 'ini',
  lock: 'plaintext', csv: 'plaintext', tsv: 'plaintext',
};

/** 확장자 소문자 — 이름 전체가 dot 파일이면 dot 뒤 전부 (".gitignore" → "gitignore"). */
export function extOf(name: string): string {
  const base = name.split('/').pop() ?? name;
  const i = base.lastIndexOf('.');
  if (i <= 0) return base.toLowerCase() === 'makefile' || base.toLowerCase() === 'dockerfile'
    ? base.toLowerCase()
    : '';
  return base.slice(i + 1).toLowerCase();
}

/** 파일 이름 → 뷰어 종류. 내용을 보기 전의 1차 판정이다. */
export function kindForFile(name: string): ViewerKind {
  const ext = extOf(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (ext in LANG_BY_EXT) return 'code';
  return 'binary'; // 미지의 확장자 — 내용 스니핑이 텍스트면 code 로 승격된다.
}

export function langForFile(name: string): string {
  return LANG_BY_EXT[extOf(name)] ?? 'plaintext';
}

export function mimeForFile(name: string): string {
  const ext = extOf(name);
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    avif: 'image/avif', pdf: 'application/pdf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    flac: 'audio/flac', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    m4v: 'video/mp4',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** 앞 4KB 에 NUL 이 있으면 바이너리로 본다 — VS Code 와 같은 휴리스틱. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** UTF-8 디코드 (BOM 제거). 잘못된 시퀀스는 U+FFFD 로 — 원본은 다운로드가 진실. */
export function decodeText(bytes: Uint8Array): string {
  let view = bytes;
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    view = view.subarray(3);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(view);
}

/** 텍스트 계열을 통으로 그릴 상한 — 넘으면 앞부분만 + 안내. */
export const TEXT_RENDER_LIMIT = 2 * 1024 * 1024;
/** 구문 강조를 켤 상한 — 넘으면 평문 렌더 (하이라이터가 수 초를 먹는다). */
export const HIGHLIGHT_LIMIT = 512 * 1024;

/**
 * CSV/TSV 파서 — RFC4180 따옴표 규칙 (겹따옴표 이스케이프, 따옴표 안 개행).
 * 표 렌더 상한을 위해 maxRows 에서 끊고 잘림 여부를 알린다.
 */
export function parseCsv(
  text: string,
  delim: ',' | '\t',
  maxRows = 2000,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let truncated = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // 완전히 빈 꼬리 행은 버린다.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) pushField();
    else if (ch === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1);
      pushRow();
      if (rows.length >= maxRows) {
        truncated = i < text.length - 1;
        break;
      }
    } else field += ch;
  }
  if (!truncated && (field !== '' || row.length > 0)) pushRow();
  return { rows, truncated };
}

/** 바이트 표시 — 탐색기의 formatSize 와 같은 톤. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

/** 뷰어 탭 id — 같은 파일을 다시 클릭하면 기존 탭을 되살린다. */
export function fileTabId(workflowId: string, rel: string): string {
  return `file:${workflowId}:${rel}`;
}

/** HTML 이스케이프 — 평문 줄을 강조 HTML 과 같은 파이프라인으로 태운다. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 강조된 HTML 을 줄 단위로 쪼갠다 — 줄 경계를 넘는 <span> 을 닫고 다음 줄에서
 * 다시 연다. 하이라이터는 토큰이 여러 줄에 걸치는 HTML 을 내놓는데, 뷰어는
 * 줄 번호 정렬을 위해 "한 줄 = 한 행" 렌더가 필요해서다.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = []; // 열린 <span …> 원문 태그들
  let cur = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        cur += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) stack.pop();
      else if (!tag.endsWith('/>')) stack.push(tag);
      cur += tag;
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  lines.push(cur + '</span>'.repeat(stack.length));
  return lines;
}
