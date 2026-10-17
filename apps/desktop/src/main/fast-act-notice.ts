/**
 * 확인 버튼 하나뿐인 알림창을 닫는다 — 빠른 조작용.
 *
 * 관리자 화면은 입력 검사 결과를 알림창으로 띄운다("가격정보 입력전에 협력사를 먼저 입력해 주세요. [확인]").
 * 알림창이 떠 있으면 스냅샷이 그 창의 버튼 하나뿐이라, 다음 지시가 모두 실패하거나 엉뚱한 것을 고른다
 * (10/16 BO 실측: 알림창 아래로 3개 지시가 서버로 넘어가고, 입력 지시가 브라우저 새로고침을 눌러 폼이 지워졌다).
 *
 * 입력칸이 없고 버튼이 확인·닫기류 하나(또는 확인과 닫기 아이콘)뿐인 창은 고를 것이 없는 알림이다 — 닫고, 알림
 * 문구는 답으로 사용자에게 전한다. 고를 것이 있는 창(확인·취소, 삭제·취소, 입력칸)은 건드리지 않는다.
 */

/** 닫은 알림창 — 문구와 누른 버튼 이름. */
export type Notice = { text: string; button: string };

/** 페이지에서 실행한다 — 맨 위 알림창이 고를 것 없는 알림이면 확인을 누르고 문구를 돌려준다. 아니면 null. */
export const NOTICE_SCRIPT = `(() => {
  const ACK = /^(확인|닫기|ok|close|[x×✕✖])$/i;
  const squash = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(visible);
  const top = dialogs[dialogs.length - 1];
  if (!top) return null;
  const fields = [...top.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox],[role=listbox]')].filter(visible);
  if (fields.length) return null;
  const buttons = [...top.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(visible)
    .map((el) => ({ el, name: squash(el.innerText || el.value || el.getAttribute('aria-label') || el.title) }));
  if (!buttons.length || buttons.length > 2 || !buttons.every((b) => ACK.test(b.name))) return null;
  const pick = buttons.find((b) => /^(확인|ok)$/i.test(b.name)) || buttons[0];
  const all = squash(top.innerText);
  const text = squash(buttons.reduce((s, b) => (b.name && s.endsWith(b.name) ? s.slice(0, -b.name.length) : s), all));
  pick.el.click();
  return { text: text.slice(0, 200), button: pick.name };
})()`;
