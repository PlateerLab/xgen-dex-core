/**
 * 채팅 메시지에 붙은 파일 — 어디서 다시 받을 수 있는지, 어떤 모양으로 보일지.
 *
 * 에이전트(XGeny)에 첨부한 파일은 전송 전에 그 에이전트 작업 공간에 올라가고, 서버 이력은
 * `geny-workspace:uploads/users/…/이름.pdf` 처럼 **버킷 접두사가 붙은 경로**로 돌려준다.
 * 화면은 작업 공간 기준 경로(`uploads/users/…/이름.pdf`)로 열고 받는다.
 */

/** 서버·업로드가 준 경로를 작업 공간 기준 경로로. 알 수 없으면 undefined. */
export function workspacePathOf(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let path = String(raw).trim();
  // `bucket:path` — 윈도 드라이브(`C:\`)와 URL(`https://`)은 여기 오지 않는다
  const colon = path.indexOf(':');
  if (colon > 0 && !path.slice(0, colon).includes('/')) path = path.slice(colon + 1);
  path = path.replace(/^\/+/, '').replace(/^workspace\//, '');
  return path && !path.split('/').includes('..') ? path : undefined;
}

export type FileTone = 'pdf' | 'sheet' | 'doc' | 'slide' | 'image' | 'archive' | 'text' | 'code' | 'other';

const TONES: Array<[FileTone, RegExp]> = [
  ['pdf', /^pdf$/],
  ['sheet', /^(xlsx?|xlsm|csv|tsv|numbers)$/],
  ['doc', /^(docx?|hwpx?|rtf|odt|pages)$/],
  ['slide', /^(pptx?|key|odp)$/],
  ['image', /^(png|jpe?g|gif|webp|svg|bmp|heic|tiff?)$/],
  ['archive', /^(zip|tar|gz|tgz|7z|rar)$/],
  ['text', /^(txt|md|log)$/],
  ['code', /^(json|ya?ml|xml|html?|js|ts|py|sql|sh)$/],
];

/** 대화창에 바로 그려 줄 그림인가 — 받아서 여는 게 아니라 보이는 게 맞는 파일. */
export function isImageFile(name: string, mime = ''): boolean {
  return fileBadge(name, mime).tone === 'image';
}

/** 파일 카드 왼쪽 배지 — 확장자 글자(최대 4자)와 색 계열. 확장자가 없으면 MIME 으로. */
export function fileBadge(name: string, mime = ''): { label: string; tone: FileTone } {
  const dot = name.lastIndexOf('.');
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ext && mime) ext = (mime.split('/')[1] || '').split(/[.+;-]/).pop()?.toLowerCase() ?? '';
  const tone = TONES.find(([, re]) => re.test(ext))?.[0] ?? 'other';
  return { label: (ext || 'FILE').slice(0, 4).toUpperCase(), tone };
}
