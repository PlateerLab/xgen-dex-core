/**
 * 작성기에 파일을 올려 두는 규칙 — 대화 화면과 시작 화면이 같이 쓴다 (2026-10-11).
 *
 * 시작 화면("오늘은 무엇을 해볼까요?")에는 첨부가 없었다. 첫 메시지와 함께 파일을 줄 수 없어서
 * 새 대화를 열고 → 글을 한 번 보내고 → 그다음에야 [+] 로 파일을 올려야 했다. 두 화면이 검사
 * (크기·개수·합계)를 따로 들면 한쪽만 통과하는 일이 생기므로 여기 한 곳에 둔다.
 */
import type { ChatImageAttachment } from '../session-store';

export const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const CHAT_IMAGE_ACCEPT = '*/*';
export const CHAT_IMAGE_MAX_COUNT = 10;
export const CHAT_IMAGE_MAX_BYTES = 100 * 1024 * 1024;
export const CHAT_IMAGE_MAX_TOTAL_BYTES = 250 * 1024 * 1024;

export const TOO_MANY_FILES = `파일은 한 번에 최대 ${CHAT_IMAGE_MAX_COUNT}개까지 첨부할 수 있습니다.`;
export const TOO_LARGE_TOTAL = '첨부 파일의 전체 크기는 250MiB를 넘을 수 없습니다.';

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
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `${file.name || '파일'}: 파일 한 개는 100MiB까지 첨부할 수 있습니다.`;
  }
  return null;
}

export async function prepareChatImage(file: File): Promise<StagedChatImage> {
  const problem = imageError(file);
  if (problem) throw new Error(problem);
  const dataUrl = await fileAsDataUrl(file);
  const isImage = CHAT_IMAGE_TYPES.has(file.type.toLowerCase());
  const dimensions = isImage ? await imageDimensions(dataUrl) : {};
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    dataUrl,
    name: file.name || `붙여넣은 이미지.${file.type.split('/')[1] || 'png'}`,
    mime: file.type.toLowerCase() || 'application/octet-stream',
    size: file.size,
    kind: isImage ? 'image' : 'file',
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

/** 붙여 넣은 것 중 그림 파일만. 글을 붙여 넣으면 빈 목록이라 기본 동작(글 붙이기)이 그대로 간다. */
export function pastedImageFiles(items: DataTransferItemList | readonly DataTransferItem[]): File[] {
  return Array.from(items)
    .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}
