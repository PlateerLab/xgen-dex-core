/**
 * 연결 폴더의 IDE 열쇠 — 경로를 base64url 로. IDE 는 열쇠를 `\u0001folders/<열쇠>/<폴더 안 경로>` 주소에 넣으므로 `/` 가
 * 들어가면 안 되고, 다른 폴더의 연결을 끊어도 밀리지 않아야 한다(몇 번째로 하면 밀린다). main 과 화면이 같은 함수를 쓴다.
 */
export function folderId(path: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(path)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 열쇠 → 경로(틀린 열쇠면 null). */
export function folderOfId(id: string): string | null {
  try {
    const bin = atob(id.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}
