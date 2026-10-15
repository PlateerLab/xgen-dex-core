/**
 * 에이전트 뷰어 [워크플로우] 탭의 캔버스.
 *
 * 웹의 캔버스 편집기를 **그대로** 쓴다: 서버의 `/canvas?load={id}&embed=1` 을 <webview> 로 띄운다. 따로 만든
 * 화면이 아니라서 노드 추가 · 연결 · 실행 · 저장이 웹과 같고, 웹 캔버스가 고쳐지면 이 탭도 함께 고쳐진다.
 * 내장 모드(embed=1)의 캔버스는 사이드바와 헤더가 없고 저장은 하단 바의 [저장]과 Ctrl+S 다.
 *
 * 왜 iframe 이 아니라 webview 인가: 웹은 로그인을 `xgen_access_token` 쿠키로 안다. 앱 창(file://) 안의
 * iframe 은 서버와 다른 사이트라 그 쿠키를 읽지 못하고, 서버가 붙이는 frame-ancestors 'self' 에도 막힌다.
 * webview 는 자기 문서의 최상위라 쿠키가 1st-party 이고 frame-ancestors 를 받지 않는다.
 *
 * 자격: 전용 **메모리 세션**(디스크에 남지 않는다)에 이 앱의 액세스 토큰을 웹과 같은 이름의 쿠키로 심는다.
 * refresh 토큰은 넣지 않는다: 게이트웨이는 회전할 때 옛 토큰의 세션 키를 지우므로, 웹 페이지가 스스로
 * 회전하면 이 앱의 토큰이 폐기된다. 대신 이 앱이 회전할 때 쿠키를 갈아 끼우고(onTokensRotated), 캔버스가
 * 로그인 화면으로 떨어지면 이 앱이 회전해 다시 연다(healLogin).
 *
 * 경계: 서버의 `/canvas` 만 붙일 수 있고(will-attach-webview), 다른 출처로는 이동하지 못한다(밖의 주소는
 * 기본 브라우저로 연다). 새 창은 같은 출처(실행 패널 떼어 내기 about:blank 포함)만 같은 세션으로 연다.
 * 캔버스 세션의 로그아웃 요청은 막는다(같은 토큰이라 이 앱까지 로그아웃된다).
 */
import { session, shell, type WebContents } from 'electron';
import { originOf } from './canvas-url';

export { canvasUrl, isCanvasUrl } from './canvas-url';

/** 메모리 세션: 'persist:' 를 붙이지 않는다. 앱을 끄면 쿠키도 사라진다. */
export const CANVAS_PARTITION = 'xgen-canvas';
const TOKEN_COOKIE = 'xgen_access_token';

let seededOrigin = '';

function canvasSession(): Electron.Session {
  return session.fromPartition(CANVAS_PARTITION);
}

export function isCanvasSession(target: Electron.Session): boolean {
  return target === canvasSession();
}

let guarded = false;

/**
 * 캔버스 세션에서 나가는 로그아웃 요청을 막는다. 캔버스 문서가 같은 토큰으로 로그아웃하면 서버가 그 토큰을
 * 회수해 이 앱 전체가 로그아웃된다(웹의 비활동 타이머는 문서마다 따로 돈다). 웹도 내장 캔버스에서는 타이머를
 * 끄지만(auth-provider), 그 판이 서버에 올라가기 전에도 이 앱이 지켜지게 여기서 한 번 더 막는다.
 */
function guardCanvasRequests(): void {
  if (guarded) return;
  guarded = true;
  canvasSession().webRequest.onBeforeRequest(
    { urls: ['http://*/api/auth/logout*', 'https://*/api/auth/logout*'] },
    (details, callback) => callback({ cancel: !!seededOrigin && originOf(details.url) === seededOrigin }),
  );
}

/** 이 앱의 토큰을 캔버스 세션에 웹과 같은 쿠키로 심는다. */
export async function seedCanvasAuth(server: string, token: string): Promise<void> {
  const origin = originOf(server);
  if (!origin || !token) return;
  guardCanvasRequests();
  await canvasSession().cookies.set({
    url: origin,
    name: TOKEN_COOKIE,
    value: token,
    path: '/',
    secure: origin.startsWith('https:'),
    httpOnly: false, // 웹이 document.cookie 로 읽는다
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  });
  seededOrigin = origin;
}

/** 토큰이 회전됐다: 캔버스를 연 적이 있으면 쿠키도 새 토큰으로. */
export function refreshCanvasAuth(server: string, token: string): void {
  if (!seededOrigin || originOf(server) !== seededOrigin) return;
  void seedCanvasAuth(server, token).catch(() => undefined);
}

/** 로그아웃: 캔버스 세션의 쿠키 · 저장소를 비운다. */
export async function clearCanvasAuth(): Promise<void> {
  seededOrigin = '';
  await canvasSession()
    .clearStorageData()
    .catch(() => undefined);
}

function sameOrigin(server: string, url: string): boolean {
  const origin = originOf(server);
  return !!origin && originOf(url) === origin;
}

function openOutside(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
}

const CHILD_PREFERENCES: Electron.WebPreferences = {
  partition: CANVAS_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
};

function keepInside(contents: WebContents, server: () => string): void {
  contents.on('will-navigate', (event, url) => {
    if (sameOrigin(server(), url)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // 실행 패널 떼어 내기는 빈 창(about:blank)을 열어 그 안에 그린다. 같은 출처 링크는 같은 세션의 창으로.
    if (!url || url === 'about:blank' || sameOrigin(server(), url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: CHILD_PREFERENCES },
      };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => keepInside(child.webContents, server));
}

/**
 * 붙은 캔버스 webview 를 지킨다. `heal` 은 토큰을 회전해 새 토큰을 돌려준다(못 하면 null).
 * 캔버스가 로그인 화면으로 떨어지면 한 번 회전해 다시 연다. 1분 안에 또 떨어지면 그대로 둔다(되풀이 방지).
 */
export function guardCanvasGuest(
  guest: WebContents,
  deps: { server: () => string; heal: () => Promise<string | null> },
): void {
  keepInside(guest, deps.server);
  let lastCanvasUrl = '';
  let healedAt = 0;
  const watch = (url: string) => {
    if (!sameOrigin(deps.server(), url)) return;
    const path = new URL(url).pathname;
    if (path === '/canvas') {
      lastCanvasUrl = url;
      return;
    }
    if (!path.startsWith('/login') || !lastCanvasUrl || Date.now() - healedAt < 60_000) return;
    healedAt = Date.now();
    void deps
      .heal()
      .then(async (token) => {
        if (!token || guest.isDestroyed()) return;
        await seedCanvasAuth(deps.server(), token);
        await guest.loadURL(lastCanvasUrl);
      })
      .catch(() => undefined);
  };
  guest.on('did-navigate', (_event, url) => watch(url));
  guest.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) watch(url);
  });
}
