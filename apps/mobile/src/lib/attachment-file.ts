/**
 * 대화 첨부 파일의 순수 규칙 — 종류(내용으로)·이름. RN 없이 시험할 수 있게 화면에서 떼어 둔다.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** 글자 코드 → 6비트 값(알파벳 밖은 255). 조각 업로드가 8MiB 조각마다 부르므로 표로 찾는다. */
const B64_VALUE = (() => {
  const table = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** base64 → 바이트. RN 에는 atob 가 없다. 알파벳 밖의 글자(=·줄바꿈)는 건너뛴다. */
export function base64Bytes(value: string): Uint8Array {
  const out = new Uint8Array(Math.floor((value.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const n = code < 256 ? B64_VALUE[code] : 255;
    if (n === 255) continue;
    buffer = ((buffer << 6) | n) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return offset === out.length ? out : out.slice(0, offset);
}

/** 내용으로 그림인지 본다 — 확장자·선언된 MIME 은 자주 틀린다. */
export function imageMime(bytes: Uint8Array): string | undefined {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  const gif = String.fromCharCode(...bytes.slice(0, 6));
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return undefined;
}

/**
 * 작업 공간에 올릴 이름 — 한글은 NFC 로(iOS 는 NFD 이름을 준다. 그대로 두면 에이전트가 같은 이름을
 * 다시 적었을 때 다른 파일이 된다), 그림이면 확장자를 내용에 맞춘다(HEIC 를 JPEG 로 받은 사진이
 * `.heic` 이름을 달고 오면 열리지 않는다).
 */
export function attachmentName(name: string, detectedMime: string | undefined): string {
  const clean = (name || 'file').normalize('NFC');
  if (!detectedMime) return clean;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[detectedMime];
  if (!ext) return clean;
  const dot = clean.lastIndexOf('.');
  const current = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  if (current === ext || (ext === 'jpg' && current === 'jpeg')) return clean;
  return `${dot > 0 ? clean.slice(0, dot) : clean}.${ext}`;
}

