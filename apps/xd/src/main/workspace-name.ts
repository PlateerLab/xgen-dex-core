/**
 * 에이전트 이름 → 작업 공간 폴더 이름(`<루트>/workspace/<이름>`).
 *
 * 엔진(apps/xd/engine/xd_engine/layout.py `check_folder_name`)이 받는 이름만 만든다: 한 칸짜리, 숨김(`.`)으로
 * 시작하지 않음, Windows 가 거부하는 글자·끝 공백/점·예약 이름(CON·NUL…) 없음, 255바이트 이하. 한글 등 글자는
 * 그대로 둔다 — 사용자가 탐색기에서 알아보는 이름이어야 한다. 겹치면 ` (2)` 를 붙인다.
 */
const BAD = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
/** 글자 수 상한 — 한글 3바이트 기준으로도 255바이트 안에 든다(숫자 꼬리 포함). */
const MAX_CHARS = 60;

export function baseFolderName(name: string): string {
  let out = String(name || '')
    .replace(BAD, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[ .]+$/, '');
  if (Array.from(out).length > MAX_CHARS) out = Array.from(out).slice(0, MAX_CHARS).join('').replace(/[ .]+$/, '');
  if (!out) out = 'agent';
  // `con.txt` 처럼 점 앞이 예약 이름이어도 거부된다 — 뒤가 아니라 앞에 붙인다.
  if (RESERVED.has(out.split('.', 1)[0].toUpperCase())) out = `_${out}`;
  return out;
}

/** 겹치지 않는 폴더 이름. `taken` 은 이미 쓰인 이름인지(DB·디스크, 대소문자 무시)를 답한다. */
export function uniqueFolderName(name: string, taken: (candidate: string) => boolean): string {
  const base = baseFolderName(name);
  if (!taken(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error('no free workspace folder name');
}

/** 엔진의 규칙과 같은 검사 — 시험과 들어온 값의 재확인에 쓴다. */
export function isValidFolderName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return false;
  if (new RegExp(BAD.source).test(name)) return false;
  if (name !== name.replace(/[ .]+$/, '')) return false;
  if (Buffer.byteLength(name, 'utf8') > 255) return false;
  return !RESERVED.has(name.split('.', 1)[0].toUpperCase());
}
