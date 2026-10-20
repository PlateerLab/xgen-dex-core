/**
 * 페이지가 연 새 창과 연 페이지 사이의 window.opener·postMessage 를 이어 준다.
 *
 * DeX 는 페이지가 연 새 창을 네이티브 자식 창으로 만들지 않고 관리 탭으로 다시 연다(browser-runtime
 * installPopupHandler) — 그래서 window.open 은 null 을 돌려주고 새 탭의 window.opener 도 null 이다. 관리자 화면의
 * 검색 팝업(협력사·브랜드·카테고리 찾기)은 고른 값을 window.opener.postMessage 로 돌려보내는데, 길이 없어서
 * [적용]을 눌러도 원래 화면 칸이 비어 있었다(10/16 BO 상품 등록 실측). 연 페이지는 window.open 이 null 이면
 * "Could not open popup window." 로 멈추기도 한다.
 *
 * 같은 출처로 여는 창만 잇는다. 연 쪽 window.open 은 DeX 가 새 탭을 열게 그대로 부르고(팝업 차단·권한 판정은
 * 그대로), 대신 상대 창 노릇을 하는 객체를 돌려준다. 새 탭의 window.opener 도 같은 객체다. 이 객체는 페이지 안
 * 숨은 빈 iframe 의 창이라 진짜 Window 로 통한다(new MessageEvent({ source }) 가 받는다) — postMessage·close·
 * focus 만 DeX 로 보내게 바꾼다. 보낸 글은 console 로 메인에 넘어가고(게스트에는 preload 가 없다), 메인이 짝 탭에
 * message 이벤트로 넣는다. 받는 출처 검사(targetOrigin)와 보낸 출처는 메인이 실제 주소로 정한다.
 * 데이터는 JSON 으로 옮긴다 — JSON 으로 못 옮기는 값(함수·순환)은 DataCloneError 다.
 */

/** 페이지에서 메인으로 넘기는 console 글의 머리. */
export const BRIDGE_TAG = '⁣dex-popup ';
/** 브리지가 연 창 요청의 창 이름 머리 — 뒤에 `${id}:${원래 이름}`. */
const FRAME_PREFIX = '__dexpopup:';
/** 한 번에 옮기는 데이터 상한(JSON 글자 수). */
export const BRIDGE_MAX_DATA = 256 * 1024;

/** 페이지에서 실행한다(모든 공유 탭, 문서마다 한 번) — window.open 을 감싸고 짝 창 객체·받기 함수를 둔다. */
export const BRIDGE_SCRIPT = `(() => {
  const B = '__dexPopupBridge';
  if (window[B]) return true;
  const TAG = ${JSON.stringify(BRIDGE_TAG)};
  const send = (m) => console.debug(TAG + JSON.stringify(m));
  const peers = new Map();
  const peer = (id) => {
    const known = peers.get(id);
    if (known) return known.win;
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.style.display = 'none';
    (document.body || document.documentElement).appendChild(frame);
    const win = frame.contentWindow;
    const state = { win, closed: false };
    const targetOf = (o) => (typeof o === 'string' ? o : (o && o.targetOrigin) || '/');
    Object.defineProperties(win, {
      postMessage: {
        configurable: true,
        value: (data, options) => {
          let json;
          try { json = JSON.stringify(data === undefined ? null : data); } catch (e) { json = undefined; }
          if (json === undefined) throw new DOMException('The object could not be cloned.', 'DataCloneError');
          if (!state.closed) send({ k: 'msg', id, data: json, target: String(targetOf(options)) });
        },
      },
      close: { configurable: true, value: () => send({ k: 'close', id }) },
      focus: { configurable: true, value: () => send({ k: 'focus', id }) },
      blur: { configurable: true, value: () => {} },
      closed: { configurable: true, get: () => state.closed },
    });
    peers.set(id, state);
    return win;
  };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const realOpen = window.open;
  // 새 창이 아닌 요청(_self·_parent·_top·페이지 안 frame 이름)과 opener 를 끊으라는 요청(noopener)은 그대로.
  const bridged = (name, features) => {
    const n = name == null ? '' : String(name);
    if (/^_(self|parent|top)$/i.test(n) || /(^|[\\s,])(noopener|noreferrer)\\b/i.test(String(features || ''))) return false;
    return !n || n === '_blank' || ![...document.querySelectorAll('iframe,frame')].some((f) => f.name === n);
  };
  window.open = function open(url, name, features) {
    let target = null;
    try { target = new URL(url == null || url === '' ? 'about:blank' : String(url), location.href); } catch (e) { target = null; }
    if (!target || target.origin !== location.origin || !bridged(name, features)) return realOpen.apply(window, arguments);
    const id = newId();
    const opened = realOpen.call(window, target.href, ${JSON.stringify(FRAME_PREFIX)} + id + ':' + (name == null || name === '_blank' ? '' : String(name)), features);
    return opened || peer(id);
  };
  Object.defineProperty(window, B, {
    value: Object.freeze({
      deliver: (id, data, origin) => {
        window.dispatchEvent(new MessageEvent('message', { data, origin, source: peer(id) }));
        return true;
      },
      closed: (id) => {
        const known = peers.get(id);
        if (known) known.closed = true;
        return true;
      },
      opener: (id, name) => {
        if (name) window.name = name;
        window.close = () => send({ k: 'close', id, self: true });
        Object.defineProperty(window, 'opener', { configurable: true, get: () => peer(id), set: () => {} });
        return true;
      },
    }),
  });
  return true;
})()`;

/** 브리지가 연 창 요청의 창 이름에서 짝 번호와 원래 창 이름. 아니면 null. */
export function parseBridgeFrameName(frameName: string): { id: string; name: string } | null {
  if (!frameName.startsWith(FRAME_PREFIX)) return null;
  const rest = frameName.slice(FRAME_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const id = rest.slice(0, sep);
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  return { id, name: rest.slice(sep + 1).slice(0, 200) };
}

export type BridgeMessage =
  | { k: 'msg'; id: string; data: unknown; target: string }
  | { k: 'close'; id: string; self: boolean }
  | { k: 'focus'; id: string };

/** 페이지 console 글에서 브리지 글. 형식이 다르거나 데이터가 크거나 JSON 이 아니면 null. */
export function parseBridgeMessage(text: string): BridgeMessage | null {
  if (!text.startsWith(BRIDGE_TAG) || text.length > BRIDGE_MAX_DATA + 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(BRIDGE_TAG.length));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !/^[\w-]{8,64}$/.test(m.id)) return null;
  if (m.k === 'close') return { k: 'close', id: m.id, self: m.self === true };
  if (m.k === 'focus') return { k: 'focus', id: m.id };
  if (m.k !== 'msg' || typeof m.data !== 'string' || typeof m.target !== 'string') return null;
  if (m.data.length > BRIDGE_MAX_DATA) return null;
  try {
    return { k: 'msg', id: m.id, data: JSON.parse(m.data), target: m.target };
  } catch {
    return null;
  }
}

/** postMessage 의 targetOrigin 으로 받는 쪽에 보내도 되는가 — '*', '/'(보낸 쪽과 같은 출처), 아니면 출처가 같을 때. */
export function targetAllowed(target: string, senderOrigin: string, destOrigin: string): boolean {
  if (target === '*') return true;
  if (target === '/') return senderOrigin === destOrigin;
  try {
    return new URL(target).origin === destOrigin;
  } catch {
    return false;
  }
}

/** 받는 탭에서 실행한다 — 짝 창이 보낸 글을 message 이벤트로 넣는다. */
export function deliverScript(id: string, data: unknown, origin: string): string {
  return `window.__dexPopupBridge?.deliver(${JSON.stringify(id)}, ${JSON.stringify(data)}, ${JSON.stringify(origin)}) ?? false`;
}

/** 짝 창이 닫혔다 — 그 쪽 창 객체의 closed 를 참으로. */
export function closedScript(id: string): string {
  return `window.__dexPopupBridge?.closed(${JSON.stringify(id)}) ?? false`;
}

/** 새 탭에서 실행한다 — window.opener 를 짝 창 객체로, 창 이름을 연 쪽이 준 이름으로. */
export function openerScript(id: string, name: string): string {
  return `window.__dexPopupBridge?.opener(${JSON.stringify(id)}, ${JSON.stringify(name)}) ?? false`;
}
