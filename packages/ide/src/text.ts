/**
 * 파일 바이트 ↔ 편집기 텍스트.
 *
 * 편집기는 UTF-8 만 다룬다. 줄 끝(LF/CRLF)과 BOM 은 **그대로 되돌려** 쓴다 — 한 글자만
 * 고쳐 저장했는데 파일 전체의 줄 끝이 바뀌면 git 에서 모든 줄이 바뀐 것으로 보인다.
 */

export type Eol = 'LF' | 'CRLF';

export interface DecodedText {
  text: string;
  eol: Eol;
  bom: boolean;
}

const BOM = [0xef, 0xbb, 0xbf];

/**
 * 텍스트로 열 수 없는가 — 앞부분에 NUL 이 있거나 **전체가** UTF-8 로 풀리지 않는다.
 *
 * 앞부분만 보면 안 된다: 뒤쪽에 다른 인코딩이 섞인 파일을 텍스트로 열어 저장하면 풀리지
 * 않던 바이트가 대체 문자로 바뀌어 파일이 조용히 망가진다.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const b of head) if (b === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

export function decodeText(bytes: Uint8Array): DecodedText {
  const bom = bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2];
  const text = new TextDecoder('utf-8').decode(bom ? bytes.subarray(3) : bytes);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { text, eol: crlf > lf ? 'CRLF' : 'LF', bom };
}

export function encodeText(text: string, eol: Eol, bom: boolean): Uint8Array {
  const normalized = text.replace(/\r\n/g, '\n');
  const body = new TextEncoder().encode(eol === 'CRLF' ? normalized.replace(/\n/g, '\r\n') : normalized);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set(BOM, 0);
  out.set(body, 3);
  return out;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);

export function isImagePath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return !!m && IMAGE_EXT.has(m[1].toLowerCase());
}

export function imageMime(path: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext}`;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
