/**
 * teams-files — Teams 첨부의 **디스크 쪽** 절반 (메인 프로세스 전용).
 *
 * 네트워크는 `core/teams.ts` 가, 파일은 여기가 맡는다. 렌더러는 어느 쪽도
 * 직접 만지지 않는다 — 경로 문자열이 렌더러로 새어 나가면 그 순간부터
 * 임의 경로 읽기/쓰기의 통로가 된다.
 *
 * ⚠ 이 파일에는 **동기 파일 I/O 를 쓰면 안 된다.**
 *   가상 드라이브(워크스페이스) 마운트는 이 프로세스의 이벤트 루프가 서빙한다.
 *   대상이 그 마운트일 때 `readFileSync` 로 읽으면 루프가 막히고, FUSE 콜백이
 *   응답하지 못해 서로를 기다리는 데드락이 된다 — `shell.openPath` 를 금지한
 *   것과 정확히 같은 함정이다(index.ts `openInFileManager` 주석 참고).
 *   그래서 읽기/쓰기는 전부 `node:fs/promises` 이고, 파일을 여는 것도
 *   자식 프로세스로 분리한다.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';

/** 파일 이름으로 못 쓰는 문자를 지운다. 서버가 준 이름을 그대로 믿지 않는다. */
export function safeFileName(name: string): string {
  const cleaned = (name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '') // 경로 구분자·제어문자·윈도 금지문자
    .replace(/^\.+/, '') // 앞의 점 — 숨김 파일/상대경로 흉내를 막는다
    .trim();
  return cleaned || 'attachment';
}

/**
 * 첨부를 사용자가 고른 위치에 저장한다. 취소하면 null.
 *
 * 저장 위치를 묻는 이유: 첨부는 남이 올린 파일이다. 사용자가 어디에 떨어지는지
 * 모르는 채 다운로드 폴더에 쌓이게 두지 않는다.
 */
export async function saveAttachmentAs(
  win: BrowserWindow | null,
  filename: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const suggested = safeFileName(filename);
  const options = {
    defaultPath: join(app.getPath('downloads'), suggested),
    // 확장자를 알면 그 확장자만 기본으로 보여준다 — 사용자가 실수로 확장자를
    // 떼어 저장하면 열리지 않는 파일이 된다.
    filters: extension(suggested)
      ? [
          { name: extension(suggested).toUpperCase(), extensions: [extension(suggested)] },
          { name: '모든 파일', extensions: ['*'] },
        ]
      : undefined,
  };
  const res = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return null;
  await writeFile(res.filePath, bytes);
  return res.filePath;
}

function extension(name: string): string {
  return extname(name).replace(/^\./, '').toLowerCase();
}

/**
 * 첨부를 임시 폴더에 풀고 OS 기본 앱으로 연다 — "저장하지 않고 잠깐 보기".
 *
 * 임시 파일은 앱 전용 하위 폴더에 넣는다. 이름이 겹치면 서로 덮어쓰므로
 * 첨부의 저장 키(서버가 보장하는 고유값)로 폴더를 하나 더 판다.
 */
export async function openAttachmentTemp(
  filename: string,
  storageKey: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = join(app.getPath('temp'), 'xgen-dex', 'teams', safeFileName(storageKey));
  await mkdir(dir, { recursive: true });
  const target = join(dir, safeFileName(filename));
  await writeFile(target, bytes);
  openWithDefaultApp(target);
  return target;
}

/**
 * OS 기본 앱으로 열기. **`shell.openPath` 를 쓰지 않는다** — 그 함수는 경로를
 * 동기적으로 확인하므로 대상이 우리 마운트면 이벤트 루프가 막혀 데드락이 된다.
 * 자식 프로세스로 분리하면 우리 루프는 계속 돌고 마운트도 계속 응답한다.
 */
function openWithDefaultApp(target: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
    // explorer 는 성공해도 종료코드 1 을 준다 — 오류로 취급하지 않는다.
    child.on('error', (e) => console.log(`[teams] 첨부 열기 실패: ${e.message}`));
    child.unref();
  } catch (e) {
    console.log(`[teams] 첨부 열기 실패: ${(e as Error).message}`);
  }
}

/** 사용자가 [파일 첨부]로 고른 로컬 파일들. 취소하면 빈 배열. */
export async function pickFilesToAttach(
  win: BrowserWindow | null,
  extensions: string[],
): Promise<string[]> {
  const options = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      { name: '첨부 가능한 파일', extensions },
      { name: '모든 파일', extensions: ['*'] },
    ],
  };
  const res = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return res.canceled ? [] : res.filePaths;
}

/** 업로드 대상으로 읽은 로컬 파일 한 개. */
export interface LocalFileBytes {
  filename: string;
  bytes: Uint8Array;
}

/**
 * 로컬 경로(가상 드라이브 포함)를 읽어 업로드용 바이트로 만든다.
 *
 * 비동기 `readFile` 인 것이 중요하다 — 이 경로는 에이전트 워크스페이스, 즉
 * **우리가 서빙하는 FUSE 마운트일 수 있다**. 파일 맨 위 주석의 데드락 참고.
 */
export async function readFileForUpload(path: string): Promise<LocalFileBytes> {
  const bytes = await readFile(path);
  return { filename: basename(path), bytes: new Uint8Array(bytes) };
}
