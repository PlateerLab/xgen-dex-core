/**
 * 작성기에 파일을 올려 두는 규칙 — 대화 화면과 시작 화면이 같이 쓴다 (2026-10-11).
 *
 * 시작 화면("오늘은 무엇을 해볼까요?")에는 첨부가 없었다. 첫 메시지와 함께 파일을 줄 수 없어서
 * 새 대화를 열고 → 글을 한 번 보내고 → 그다음에야 [+] 로 파일을 올려야 했다. 두 화면이 검사
 * (크기·개수·합계)를 따로 들면 한쪽만 통과하는 일이 생기므로 여기 한 곳에 둔다.
 */
import { UPLOAD_MAX_BYTES } from '@dex/protocol/resumable-upload';
import { xgen } from '../bridge';
import type { ChatImageAttachment } from '../session-store';

export const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const CHAT_IMAGE_ACCEPT = '*/*';
export const CHAT_IMAGE_MAX_COUNT = 10;
/**
 * 파일 한 개의 상한 — 플랫폼 업로드 상한(1GiB). 디스크의 파일은 main 이 조각으로 올리므로
 * 메모리에 올리지 않는다(큰 문서·동영상).
 */
export const CHAT_IMAGE_MAX_BYTES = UPLOAD_MAX_BYTES;
/** 디스크 경로가 없는 파일(붙여 넣은 그림 등)은 메모리로 읽어 보낸다 — 그때의 상한. */
export const CHAT_MEMORY_MAX_BYTES = 100 * 1024 * 1024;
/** 이보다 작은 그림만 미리보기(데이터 URL)를 만든다. 큰 그림은 파일로 붙인다. */
export const CHAT_INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 한 번에 보내는 첨부 합계 — 파일 저장소 → 작업 공간 복사의 한 번 총량과 같다. */
export const CHAT_IMAGE_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

export const TOO_MANY_FILES = `파일은 한 번에 최대 ${CHAT_IMAGE_MAX_COUNT}개까지 첨부할 수 있습니다.`;
export const TOO_LARGE_TOTAL = '첨부 파일의 전체 크기는 4GiB를 넘을 수 없습니다.';

/** 상한을 넘은 파일의 안내 — 디스크의 파일은 1GiB, 메모리에만 있는 파일은 100MiB. */
export function fileTooLargeText(name: string, fromDisk: boolean): string {
  return fromDisk
    ? `${name || '파일'}: 파일 한 개는 1GiB까지 첨부할 수 있습니다.`
    : `${name || '파일'}: 이 파일은 100MiB까지 첨부할 수 있습니다. 디스크에 저장된 파일은 1GiB까지 첨부할 수 있습니다.`;
}

/** 디스크에 있는 File 이면 preload 의 표, 아니면 null(브리지가 없는 시험·옛 preload 도 null). */
function stageOnDisk(file: File): string | null {
  try {
    return xgen?.files?.stage?.(file) ?? null;
  } catch {
    return null;
  }
}

export interface StagedChatImage extends ChatImageAttachment {
  id: string;
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.replace(/^data:;base64,/, 'data:application/octet-stream;base64,'))
        : reject(new Error('파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(reader.error ?? new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(file);
  });
}

function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('지원하지 않거나 손상된 이미지입니다.'));
    image.src = dataUrl;
  });
}

export function imageError(file: Pick<File, 'name' | 'size'>): string | null {
  if (file.size <= 0) return `${file.name || '파일'}: 빈 파일은 첨부할 수 없습니다.`;
  if (file.size > CHAT_IMAGE_MAX_BYTES) return fileTooLargeText(file.name, true);
  return null;
}

/**
 * 고른 파일을 작성기에 올려 둘 모양으로.
 *
 * 디스크의 파일은 표(`fileRef`)만 들고, 바이트는 보낼 때 main 이 디스크에서 조각으로 읽는다 — 1GiB
 * 동영상을 데이터 URL(1.33배 문자열)로 만들면 렌더러가 버티지 못한다. 작은 그림만 미리보기용 데이터
 * URL 을 만든다(에이전트가 아닌 모델은 그림을 이 데이터 URL 로 받는다). 디스크 경로가 없는 파일
 * (붙여 넣은 그림)은 예전처럼 메모리로 읽는다.
 */
export async function prepareChatImage(
  file: File,
  stage: (file: File) => string | null = stageOnDisk,
): Promise<StagedChatImage> {
  const problem = imageError(file);
  if (problem) throw new Error(problem);
  const fileRef = stage(file) ?? undefined;
  if (!fileRef && file.size > CHAT_MEMORY_MAX_BYTES) throw new Error(fileTooLargeText(file.name, false));
  const isImage = CHAT_IMAGE_TYPES.has(file.type.toLowerCase());
  const inline = !fileRef || (isImage && file.size <= CHAT_INLINE_IMAGE_MAX_BYTES);
  const dataUrl = inline ? await fileAsDataUrl(file) : '';
  const asImage = isImage && inline;
  const dimensions = asImage ? await imageDimensions(dataUrl) : {};
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dataUrl,
    name: file.name || `붙여넣은 이미지.${file.type.split('/')[1] || 'png'}`,
    mime: file.type.toLowerCase() || 'application/octet-stream',
    size: file.size,
    kind: asImage ? 'image' : 'file',
    ...(fileRef ? { fileRef } : {}),
    ...dimensions,
  };
}

/**
 * 고른 파일을 하나씩 검사해 올려 둔다. 돌려주는 것은 사용자에게 보일 첫 문제(없으면 null).
 *
 * `used` 는 매번 다시 묻는다 — 한 파일을 올릴 때마다 개수·합계가 바뀐다. 대화 화면은 여기에
 * 브라우저 캡처까지 더해 센다. `prepare` 는 시험에서 바꿔 끼우는 자리다(FileReader 없이).
 */
export async function stageChatFiles(
  files: readonly File[],
  used: () => { count: number; bytes: number },
  add: (image: StagedChatImage) => void,
  prepare: (file: File) => Promise<StagedChatImage> = prepareChatImage,
): Promise<string | null> {
  const problems: string[] = [];
  for (const file of files) {
    const now = used();
    if (now.count >= CHAT_IMAGE_MAX_COUNT) {
      problems.push(TOO_MANY_FILES);
      break;
    }
    const problem = imageError(file);
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (now.bytes + file.size > CHAT_IMAGE_MAX_TOTAL_BYTES) {
      problems.push(TOO_LARGE_TOTAL);
      break;
    }
    try {
      add(await prepare(file));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : '파일을 읽지 못했습니다.');
    }
  }
  return problems[0] ?? null;
}

// ── 붙여넣기 (2026-10-22, 웹 채팅 입력창 packages/ui chat-paste.ts 와 같은 규칙) ─────────────────────
//
// 예전에는 그림 파일만 보고 그림이 하나라도 있으면 글 대신 그림을 붙였다. 엑셀 셀·워드 문단을 복사하면 클립보드에
// 그 내용을 그린 그림도 함께 실려, 표 대신 사진이 붙었다. 탐색기에서 복사한 문서는 파일 대신 이름 글자가 붙었다.

/** 붙여넣기 이벤트의 ``clipboardData`` 중 여기서 읽는 부분(시험에서 흉내 낼 수 있게). */
export interface ClipboardLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  getData(format: string): string;
}

/** 브라우저가 클립보드의 그림에 붙이는 이름(``image.png``). 여러 장이 모두 같은 이름이 되지 않게 바꾼다. */
const GENERIC_IMAGE_NAME = /^image\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i;
const SINGLE_LINK = /^(https?|file|data|blob):\S+$/i;

function clipboardText(data: ClipboardLike): string {
  try {
    return String(data.getData('text/plain') || '').trim();
  } catch {
    return '';
  }
}

function clipboardFiles(data: ClipboardLike): File[] {
  const listed = Array.from(data.files ?? []).filter((f): f is File => !!f);
  if (listed.length > 0) return listed;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
}

function baseName(line: string): string {
  let raw = line.replace(/^file:\/\//i, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // 잘못 인코딩된 경로면 그대로 비교한다.
  }
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

/** 함께 온 글이 파일 이름·경로 목록이거나 주소 한 줄뿐인가(그러면 파일 붙여넣기다). */
function textOnlyNamesFiles(text: string, files: File[]): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && SINGLE_LINK.test(lines[0])) return true;
  const names = new Set(files.map((f) => f.name).filter(Boolean));
  return names.size > 0 && lines.every((l) => names.has(l) || names.has(baseName(l)));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function extensionOf(file: File): string {
  const fromName = /\.([a-z0-9]{1,5})$/i.exec(file.name || '');
  if (fromName) return fromName[1].toLowerCase();
  const sub = (file.type.split('/')[1] || '').split(/[+;]/)[0].toLowerCase();
  if (sub === 'jpeg') return 'jpg';
  return sub || 'bin';
}

/** 이름이 없거나 ``image.png`` 인 파일(클립보드의 그림)에 붙여 넣은 시각으로 이름을 준다. */
function pastedName(file: File, index: number, count: number, text: string, now: Date): File {
  const generic = !file.name || (GENERIC_IMAGE_NAME.test(file.name) && text !== file.name);
  if (!generic) return file;
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} `
    + `${pad2(now.getHours())}.${pad2(now.getMinutes())}.${pad2(now.getSeconds())}`;
  const label = file.type.toLowerCase().startsWith('image/') ? '붙여넣은 이미지' : '붙여넣은 파일';
  const suffix = count > 1 ? ` (${index + 1})` : '';
  return new File([file], `${label} ${stamp}${suffix}.${extensionOf(file)}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * 붙여 넣은 것 중 첨부할 파일. 빈 목록이면 붙여넣기는 기본 동작(글 붙이기)대로 둔다.
 *
 * 그림만이 아니라 탐색기에서 복사한 파일도 받는다. **글이 함께 오면 글이 이긴다**(엑셀 셀·워드 문단). 함께 온 글이
 * 파일 이름·경로나 주소 한 줄뿐이면(Finder 복사, 이미지 복사) 파일로 본다.
 */
export function pastedFiles(data: ClipboardLike | null | undefined, now: Date = new Date()): File[] {
  if (!data) return [];
  const files = clipboardFiles(data);
  if (files.length === 0) return [];
  const text = clipboardText(data);
  if (text && !textOnlyNamesFiles(text, files)) return [];
  return files.map((file, index) => pastedName(file, index, files.length, text, now));
}

/** :func:`ownsDocumentPaste` 가 보는 요소의 모양(DOM 요소가 그대로 맞는다). */
export interface PasteNode {
  readonly isConnected: boolean;
  readonly tagName: string;
  readonly isContentEditable?: boolean;
  readonly offsetParent?: unknown;
  closest(selector: string): PasteNode | null;
  contains(other: unknown): boolean;
}

/** 대화 화면의 뿌리(입력창이 있는 칸). 나눠 본 화면에서 붙여넣기가 어느 대화의 것인지 가른다. */
export const PASTE_ROOT_ATTR = 'data-paste-root';

/**
 * 입력창에 포커스가 없을 때의 붙여넣기를 이 입력창이 받는가.
 *
 * 다른 입력칸·편집기·이 입력창이 없는 대화 상자에 붙여 넣는 것은 받지 않는다. 단추 등에 포커스가 있으면 그것이
 * 든 대화가, 아무것도 포커스되지 않았으면 마지막으로 누른 곳(없으면 마지막으로 쓴 입력창)의 대화가 받는다.
 * 나눠 본 두 대화가 같은 붙여넣기를 함께 가져가지 않고, 대화 밖(사이드바·탐색기)을 누른 뒤의 붙여넣기도 받지 않는다.
 */
export function ownsDocumentPaste(
  target: PasteNode | null,
  input: PasteNode,
  recent: { pointer: PasteNode | null; input: PasteNode | null },
): boolean {
  if (!input.isConnected || input.offsetParent === null) return false;
  const root = input.closest(`[${PASTE_ROOT_ATTR}]`);
  if (!root) return false;
  const onPage = !target || target.tagName === 'BODY' || target.tagName === 'HTML';
  if (target && !onPage) {
    if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
    const dialog = target.closest('[role="dialog"], [aria-modal="true"]');
    if (dialog && !dialog.contains(input)) return false;
  }
  const probe = !onPage
    ? target
    : recent.pointer?.isConnected
      ? recent.pointer
      : recent.input?.isConnected
        ? recent.input
        : null;
  // 이 창에서 처음 붙여 넣는다(누른 곳도 쓴 입력창도 없다): 보이는 입력창이 받는다.
  if (!probe) return true;
  return probe.closest(`[${PASTE_ROOT_ATTR}]`) === root;
}
