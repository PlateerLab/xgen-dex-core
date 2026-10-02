/**
 * 앱 한 장 찍기 — 보이지 않는 창에 앱을 띄워 카드 크기의 JPEG 로.
 *
 * 화면 밖 렌더링(offscreen)으로 그린다. 숨긴 일반 창의 capturePage 는 플랫폼에 따라 빈 그림을 돌려준
 * 적이 있다 — 찍으려고 만든 창이니 처음부터 찍는 쪽으로 그린다.
 *
 * 창은 기본 세션을 쓴다 — 서버 주소의 `/api/…` 요청에 main 이 로그인 자격을 붙여 주는 그 세션이라,
 * 사람이 [앱] 탭에서 여는 것과 같은 자격으로 열린다(주인의 앱이다). 새 창·다운로드·다른 곳으로의
 * 이동은 막고, 소리는 끈다. 무엇이 되든 창은 반드시 닫는다.
 */
import { BrowserWindow } from 'electron';

export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;
/** 카드에 쓰는 크기 — 640×400 이면 고해상도 화면에서도 카드 폭을 채운다. */
export const THUMB_WIDTH = 640;
/** 문서가 뜬 뒤 지도 타일·글꼴·차트가 그려질 시간. */
const SETTLE_MS = 2500;
/** 한 장에 쓰는 시간의 상한. */
const SHOT_TIMEOUT_MS = 25_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('미리보기 시간 초과')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function shootAppPreview(url: string, opts?: { settleMs?: number }): Promise<Uint8Array | null> {
  const origin = new URL(url).origin;
  const win = new BrowserWindow({
    show: false,
    width: SHOT_WIDTH,
    height: SHOT_HEIGHT,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  // 이 창이 내는 다운로드만 막는다 — 세션은 앱 전체가 함께 쓰므로 듣기는 찍는 동안만.
  const noDownload = (event: Electron.Event, _item: Electron.DownloadItem, from: Electron.WebContents) => {
    if (from === wc) event.preventDefault();
  };
  const session = wc.session;
  session.on('will-download', noDownload);
  try {
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, target) => {
      try {
        if (new URL(target).origin !== origin) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    const work = (async () => {
      await wc.loadURL(url);
      await new Promise((r) => setTimeout(r, opts?.settleMs ?? SETTLE_MS));
      const shot = await wc.capturePage();
      if (shot.isEmpty()) return null;
      const thumb = shot.resize({ width: THUMB_WIDTH, quality: 'good' });
      return new Uint8Array(thumb.toJPEG(80));
    })();
    return await withTimeout(work, SHOT_TIMEOUT_MS);
  } catch {
    return null;
  } finally {
    session.removeListener('will-download', noDownload);
    if (!win.isDestroyed()) win.destroy();
  }
}
