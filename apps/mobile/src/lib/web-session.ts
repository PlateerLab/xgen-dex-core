/**
 * 폰 안에서 서버 화면(내 앱·문서·PDF·소리·영상)을 여는 길 — WebView 에 로그인을 싣는다.
 *
 * 데스크톱은 main 프로세스가 서버로 가는 모든 요청에 로그인 머리를 붙인다. WebView 는 첫 요청에만 머리를
 * 붙일 수 있고, 그 뒤의 자원·fetch·소켓에는 붙일 길이 없다. 그래서 **같은 출처의 쿠키**로 싣는다:
 * 게이트웨이는 `xgen_access_token` 쿠키를, 웹 화면(로그인 확인)은 `access_token` 쿠키를 본다.
 *
 * 순서: 서버 출처로 여는 작은 시작 문서가 쿠키를 심고 → 목적지로 넘어간다. 남의 앱(스토어의 공개 링크)에는
 * 쓰지 않는다 — 로그인이 필요 없고, 남의 화면에 내 로그인을 실을 까닭이 없다.
 */

/** 쿠키 값으로 그대로 실어도 되는 토큰인가(JWT 는 영문·숫자·`-_.` 뿐이다). */
function cookieValue(token: string): string {
  return /^[\w.\-~]+$/.test(token) ? token : encodeURIComponent(token);
}

/** 서버 주소의 출처(`https://host:port`) — WebView 의 시작 문서가 이 출처로 열려야 쿠키가 그 서버에 붙는다. */
export function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return '';
  }
}

function cookieScript(token: string, secure: boolean): string {
  const v = JSON.stringify(cookieValue(token));
  const tail = JSON.stringify(`; path=/; SameSite=Lax${secure ? '; Secure' : ''}`);
  return `document.cookie='xgen_access_token='+${v}+${tail};document.cookie='access_token='+${v}+${tail};`;
}

/**
 * 쿠키를 심고 `target`(같은 서버의 주소)으로 넘어가는 시작 문서. WebView 에는
 * `{ html, baseUrl: serverOrigin(serverUrl) + '/' }` 로 준다.
 */
export function sessionBootstrapHtml(target: string, token: string, opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ?? target.startsWith('https:');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<script>${cookieScript(token, secure)}location.replace(${JSON.stringify(target)});</script>` +
    '</head><body></body></html>'
  );
}

/**
 * 쿠키를 심은 뒤 그리는 한 장짜리 문서 — 문서 페이지 그림·PDF·소리·영상처럼 서버 주소를 직접 쓰는 것을
 * 폰 안에서 그릴 때. `body` 는 우리가 만든 마크업이다(사용자 글을 넣을 때는 escapeHtml).
 */
export function sessionDocumentHtml(
  body: string,
  token: string,
  opts: { secure?: boolean; dark?: boolean; head?: string } = {},
): string {
  const bg = opts.dark ? '#0E1015' : '#F5F6F8';
  const fg = opts.dark ? '#E9ECF2' : '#16181D';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4">' +
    `<script>${cookieScript(token, !!opts.secure)}</script>` +
    `<style>html,body{margin:0;padding:0;background:${bg};color:${fg};font-family:-apple-system,system-ui,sans-serif}` +
    '.page{display:block;width:100%;height:auto;margin:0 0 10px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2)}' +
    '.wrap{padding:10px}.note{padding:24px;text-align:center;font-size:14px;opacity:.7}' +
    'video,audio{width:100%}canvas{display:block;width:100%;height:auto;margin:0 0 10px;background:#fff}</style>' +
    (opts.head ?? '') +
    `</head><body>${body}</body></html>`
  );
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** 문서 페이지 그림들(서버 렌더) — 쿠키가 심긴 뒤 같은 출처의 주소로 불러온다. */
export function pagesBody(pagePaths: readonly string[], name: string): string {
  if (!pagePaths.length) return '<div class="note">페이지가 없습니다.</div>';
  return (
    '<div class="wrap">' +
    pagePaths
      .map((p, i) => `<img class="page" loading="lazy" src="${escapeHtml(p)}" alt="${escapeHtml(`${name} ${i + 1}페이지`)}">`)
      .join('') +
    '</div>'
  );
}

/** pdf.js 판 — 화면이 직접 그린다(안드로이드 WebView 는 PDF 를 그리지 못한다). */
export const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

/**
 * PDF — pdf.js 로 쪽마다 캔버스에 그린다. 원본은 같은 출처의 주소에서 쿠키로 받는다.
 * pdf.js 를 받지 못하면(인터넷이 막힌 곳) 안내를 남기고, 화면은 [내보내기] 로 기기 앱에 넘길 수 있다.
 */
export function pdfBody(rawPath: string): string {
  return (
    '<div class="wrap" id="pages"><div class="note" id="msg">PDF 를 그리는 중입니다.</div></div>' +
    `<script src="${PDFJS_BASE}/pdf.min.js"></script>` +
    '<script>(function(){var msg=document.getElementById("msg");' +
    'function fail(t){msg.textContent=t;window.ReactNativeWebView&&window.ReactNativeWebView.postMessage("pdf-failed");}' +
    'if(!window.pdfjsLib){fail("PDF 를 그릴 도구를 받지 못했습니다. 내보내기로 기기 앱에서 여세요.");return;}' +
    `pdfjsLib.GlobalWorkerOptions.workerSrc=${JSON.stringify(`${PDFJS_BASE}/pdf.worker.min.js`)};` +
    `pdfjsLib.getDocument({url:${JSON.stringify(rawPath)},withCredentials:true}).promise.then(function(doc){` +
    'msg.remove();var box=document.getElementById("pages");var w=Math.min(window.innerWidth-20,1200);' +
    'var chain=Promise.resolve();for(var i=1;i<=doc.numPages;i++){(function(n){chain=chain.then(function(){return doc.getPage(n).then(function(page){' +
    'var v=page.getViewport({scale:1});var s=(w*(window.devicePixelRatio||1))/v.width;var vp=page.getViewport({scale:s});' +
    'var c=document.createElement("canvas");c.width=vp.width;c.height=vp.height;box.appendChild(c);' +
    'return page.render({canvasContext:c.getContext("2d"),viewport:vp}).promise;});});})(i);}' +
    'return chain;}).catch(function(){fail("PDF 를 열지 못했습니다. 내보내기로 기기 앱에서 여세요.");});})();</script>'
  );
}

/** 소리·영상 — 같은 출처의 주소를 그대로(쿠키로 로그인, 서버가 구간 요청을 받는다). */
export function mediaBody(rawPath: string, kind: 'audio' | 'video'): string {
  const src = escapeHtml(rawPath);
  return kind === 'video'
    ? `<div class="wrap"><video controls playsinline preload="metadata" src="${src}"></video></div>`
    : `<div class="wrap" style="padding-top:40px"><audio controls preload="metadata" src="${src}"></audio></div>`;
}
