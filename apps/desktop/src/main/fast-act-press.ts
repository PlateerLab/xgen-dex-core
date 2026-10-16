/**
 * 누른 것이 버려졌나 — 빠른 조작용.
 *
 * 입력칸(편집기)에 초점이 있는 채 다른 요소를 누르면 mousedown 에서 초점이 빠지고, 칸 값을 폼에 반영하며 화면이 다시
 * 그려진다. 그때 누른 요소가 새 요소로 바뀌면 mouseup 은 새 요소에 떨어지고 브라우저는 click 을 보내지 않는다
 * (10/16 BO 상품 등록 실측: 상품상세 편집기에 쓴 직후 전시카테고리 [추가] — mousedown 111ms 뒤 표 머리 도구줄이 통째로
 * 다시 그려지고 mouseup 만 남아 팝업이 안 떴다. 사람이 눌러도 같다 — 한 번 더 누르면 열린다).
 *
 * 누르기 전 초점이 입력칸에 있을 때만 페이지에서 mousedown·click 을 지켜보고, 누른 뒤 mousedown 은 있었는데 click 이
 * 없고 mousedown 을 받은 요소가 화면에서 빠졌으면 버려진 것으로 본다. mousedown 에 동작하는 요소를 두 번 누르지
 * 않도록 이 셋이 모두 맞을 때만.
 */

const KEY = `Symbol.for('xgen.fastActPress')`;

/** 페이지에서 실행한다 — 초점이 입력칸이면 지켜보기 시작하고 true. 아니면 false. */
export const PRESS_WATCH_SCRIPT = `(() => {
  window[${KEY}]?.off();
  const a = document.activeElement;
  const editing = !!a && (a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/i.test(a.type)));
  if (!editing) return false;
  const s = { down: null, click: false };
  const down = (e) => { if (e.isTrusted && !s.down) s.down = e.target; };
  const click = (e) => { if (e.isTrusted) s.click = true; };
  document.addEventListener('mousedown', down, true);
  document.addEventListener('click', click, true);
  window[${KEY}] = { s, off: () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('click', click, true); delete window[${KEY}]; } };
  return true;
})()`;

/** 페이지에서 실행한다 — 지켜보기를 끝내고, 누른 것이 버려졌으면 true. */
export const PRESS_LOST_SCRIPT = `(() => {
  const w = window[${KEY}];
  if (!w) return false;
  w.off();
  return !!w.s.down && !w.s.click && !w.s.down.isConnected;
})()`;
