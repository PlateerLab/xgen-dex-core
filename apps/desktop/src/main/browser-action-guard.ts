import { turnInputText } from '@dex/protocol/history';
import { stripBrowserContext } from '@dex/protocol/browser';
import { stripTeamsContext } from '@dex/protocol/teams-bridge';
import { stripVoiceContext } from '@dex/protocol/voice-context';

export type BrowserActionTarget = {
  role?: string;
  name?: string;
  navigates?: boolean;
  submit?: boolean;
  reset?: boolean;
  search?: boolean;
  login?: boolean;
  unsafeForm?: boolean;
  multiline?: boolean;
};

export const BROWSER_ACTION_BLOCKED =
  '사용자 승인 없이 실행할 수 없습니다. 현재 대상의 저장·등록·승인요청·제출·보내기는 사용자에게 명시적으로 요청받은 뒤 한 번만 실행하세요. 승인 없이 다른 도구로 재시도하지 마세요.';

export const BROWSER_COMMIT_GUIDE =
  'Search/query and opening lookup dialogs do not require save/submit authorization. ' +
  'Stop before save/register/approval/submission/sending unless the user explicitly authorized that action for the current page and unchanged form. ' +
  'Use BrowserInteract click for one named button; authorization lasts 120 seconds and is consumed once. ' +
  'If blocked, ask a question naming the exact pending button (for example, "현재 상품을 임시저장할까요?") and wait for the user. ' +
  'A direct request such as "임시저장해줘" also authorizes it. Ambiguous wording needs confirmation. ' +
  'Do not retry without new authorization or use tool arguments, eval, keyboard shortcuts or another tool to bypass the check. Deletion remains blocked. ';

/** Field values are data; action requests and actual controls determine the block. */
// shortcut: custom saves without action labels or native submission need a site-specific policy.
export function allowsBrowserAction(
  operation: string,
  target: BrowserActionTarget = {},
  key = '',
  instruction = '',
): boolean {
  const field = ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(target.role ?? '');
  const choice = ['checkbox', 'radio', 'switch', 'option', 'treeitem', 'tab', 'listbox'].includes(
    target.role ?? '',
  );
  const name = (target.name ?? '').trim();
  const destructive =
    /(삭제|지우기|비우기|제거|탈퇴|해지|로그\s*아웃|초기화|(?:결제|구매|주문)(?:하기|요청|확인|진행)?$|\b(?:delete|remove|erase|empty|log\s*out|reset|uninstall|purchase|checkout|pay now)\b)/i;
  const commit =
    /(임시\s*저장|저장|등록|승인\s*요청|제출|(?<!내)보내기|전송|발송)(\s*(하기|요청|완료|진행|버튼))?\s*[.!…]*$|\b(save(?: draft)?|submit|register|request approval|send for approval|publish)\b/i;
  if (operation === 'click') {
    const request = instruction.replace(/[\s「」『』"'“”‘’]/g, '');
    if (
      /(삭제|지워|지우|비워|비우|제거|탈퇴|해지|로그아웃|초기화|결제|구매|주문|저장|등록|승인요청|제출|(?<!내)보내기?|전송|발송)(?:(?:버튼을?|을|를)?(?:눌러|누르기|클릭|실행|진행|해|하|하기|요청|처리|줘|주세요))*[.!?]*$/.test(
        request,
      ) ||
      /^(?:please\s+)?(?:delete|remove|erase|empty|log\s*out|reset|uninstall|purchase|checkout|save|submit|register|publish|request approval)(?:\s|$)/i.test(
        instruction.replace(/[「」『』"'“”‘’]/g, '').trim(),
      )
    )
      return false;
  }
  // A login form (password field, no save-like button) is submitted the same way as a search.
  const plainForm = (target.search === true || target.login === true) && !target.unsafeForm;
  if (operation === 'submit') return plainForm;
  if (operation === 'keypress') {
    const chord = key.toLowerCase().replace(/\s/g, '');
    if (/(?:control|ctrl|meta|cmd|command)\+.*s$/.test(chord)) return false;
    if (/(?:^|\+)(?:enter|return)$/.test(chord))
      return (
        !/(?:control|ctrl|meta|cmd|command|alt)\+/.test(chord) &&
        (target.multiline === true || plainForm || choice)
      );
    if (/(?:^|\+)(?:delete|backspace)$/.test(chord)) return field;
    if (key === ' ' || /(?:^|\+)(?:space|spacebar)$/.test(chord))
      return field || choice || allowsBrowserAction('click', target);
    return true;
  }
  if (['fill', 'type', 'select', 'check', 'uncheck'].includes(operation)) return field || choice;
  if (field || choice) return true;
  if (target.reset) return false;
  if (destructive.test(name)) return false;
  const registrationPage =
    target.role === 'link' &&
    target.navigates !== false &&
    /등록|\bregister\b/i.test(name) &&
    !/저장|승인|제출|\b(save|submit|approval|publish)\b/i.test(name);
  if (commit.test(name) && !registrationPage) return false;
  if (target.submit) return plainForm;
  // Unnamed buttons are icons and section toggles; save-like actions carry a name.
  return true;
}

export type BrowserCommitAction = '저장' | '임시저장' | '등록' | '승인요청' | '제출' | '보내기';

const COMMIT_WORDS = /임시\s*저장|승인\s*요청|저장|등록|제출|(?<!내)보내기|전송|발송/g;
const commitAction = (word: string) =>
  (/보내기|전송|발송/.test(word) ? '보내기' : word.replace(/\s/g, '')) as BrowserCommitAction;

/** Only the host calls this with a real user message, never with tool arguments. */
export function requestedBrowserCommit(input: unknown, pageTitle = ''): BrowserCommitAction | 'confirm' | null {
  const plain = stripVoiceContext(stripTeamsContext(stripBrowserContext(turnInputText(input))));
  const text = plain.trim()
    .replace(new RegExp(`[「『"“‘'](${COMMIT_WORDS.source})[」』"”’']`, 'g'), '$1')
    .replace(/(?<!내)보내\s*(?=줘|주세요)/g, '보내기 해');
  if (/^(?:네|넵|예|응|좋아|진행해줘|진행해주세요|확인했어|확인했습니다|허용|yes|ok|okay)[.!\s]*$/i.test(text))
    return 'confirm';
  // Quoted data, conditions and multi-action requests do not confer execution permission.
  if (/[「」『』"“”‘’'`\n?？]/.test(text) || /하지|말고|말아|금지|(?:^|\s)안(?:\s|돼)|못|않|취소|보류|중지|그만|아니|전에|전까지|나중|후에|하면|되면|가능|방법|테스트|차단|확인해|어떻게/.test(text)) return null;
  const actions = text.match(COMMIT_WORDS);
  if (!actions || actions.length !== 1) return null;
  const at = text.indexOf(actions[0]);
  let before = text.slice(0, at).trim().replace(/^(?:네|예|응|좋아)[,\s]+/, '');
  const location = before.match(/^(?:(?:지금|현재)(?:\s*보이는)?\s*)?(.+?)(?:\s*(?:화면|페이지))?에서\s*/);
  if (location) {
    const name = location[1].replace(/\s/g, '');
    if (!['화면', '페이지', '메일', '메일작성', '메일작성화면'].includes(name) &&
      (!pageTitle || !pageTitle.replace(/\s/g, '').includes(name))) return null;
    before = before.slice(location[0].length).trim();
  }
  if (!/^(?:(?:이|현재|지금|현재\s*(?:화면|페이지)의?)\s*)?(?:(?:상품|내용|입력값|입력한\s*내용|메일|이메일)(?:을|를)?\s*)?$/.test(before)) return null;
  const after = text.slice(at + actions[0].length).trim();
  if (!/^(?:(?:을|를|버튼(?:을|를)?)\s*)?(?:(?:진행|실행|클릭)\s*)?(?:해\s*줘|해\s*주세요|해주세요|진행해|실행해|눌러\s*줘|눌러\s*주세요|클릭해\s*줘|허용할게|승인할게|합니다|하세요)[.!\s]*$/.test(after)) return null;
  return commitAction(actions[0]);
}

/** A bare yes is consent only after the assistant actually asked about one named action. */
export function browserCommitQuestion(reply: string): BrowserCommitAction | null {
  const question = (reply.trim().split('\n').at(-1) ?? '').replace(/(?<!내)보낼까요/g, '보내기할까요');
  const actions = question.match(COMMIT_WORDS);
  return actions?.length === 1 && /할까요|될까요|누를까요|하시겠어요|하시겠습니까/.test(question)
    ? commitAction(actions[0]) : null;
}

export function browserCommitConfirmationAsked(reply: string, action: BrowserCommitAction): boolean {
  return browserCommitQuestion(reply) === action;
}

const BROWSER_ACTION_DOM = `
  const allowed = ${allowsBrowserAction.toString()};
  const nameOf = (el) => (el?.getAttribute('aria-label') || el?.getAttribute('title') ||
    (el?.labels ? [...el.labels].map(l => l.innerText).join(' ') : '') ||
    (el?.matches('input[type=submit],input[type=button],input[type=reset]') ? el.value : '') ||
    el?.innerText || el?.getAttribute('placeholder') || el?.getAttribute('name') || '').trim();
  const roleOf = (el) => el?.getAttribute('role') ||
    (el?.matches('textarea') || el?.isContentEditable ? 'textbox' :
    el?.matches('input:not([type=submit]):not([type=button]):not([type=reset])') ?
      (['checkbox','radio'].includes(el.type) ? el.type : el.type === 'search' ? 'searchbox' : 'textbox') :
    el?.matches('select') ? 'combobox' : el?.matches('button,input') ? 'button' : el?.matches('a') ? 'link' : '');
  const describe = (el) => {
    const form = el?.form || el?.closest('form');
    const name = nameOf(el);
    const role = roleOf(el);
    const controls = form ? [...form.querySelectorAll('button,input[type=submit],input[type=button],[role=button]')] : [];
    // Only submit buttons decide what submitting does; reset and type=button controls (비밀번호 초기화) are judged when clicked.
    const unsafeForm = controls.some(b => b.type === 'submit' && !allowed('click', { role: 'button', name: nameOf(b) }));
    const queryName = (name) => /검색|조회|\\b(search|query)\\b/i.test(name);
    const searchForm = !unsafeForm && controls.some(b => b.type === 'submit' && queryName(nameOf(b)));
    const search = role === 'searchbox' || (['textbox','button'].includes(role) && queryName(name)) ||
      (['textbox','searchbox','combobox','spinbutton'].includes(role) && searchForm);
    return { role, name, search, unsafeForm, login: !!form?.querySelector('input[type=password]'),
      navigates: !!(el?.matches('a[href]') && el.getAttribute('href') && !el.getAttribute('href').startsWith('#') && /^https?:/i.test(el.href)),
      submit: !!form && ['submit','image'].includes(el?.type),
      reset: el?.type === 'reset',
      multiline: el?.matches('textarea') || el?.isContentEditable || false };
  };

  const commitName = (el) => {
    if (!['button', 'link', 'menuitem'].includes(roleOf(el))) return null;
    const name = nameOf(el).replace(/\\s/g, '');
    if (/삭제|제거|초기화|결제|구매|주문|해지|탈퇴|delete|remove|reset|purchase|checkout/i.test(name)) return null;
    const match = name.match(/(임시저장|승인요청|저장|등록|제출|(?<!내)보내기|전송|발송)(?:하기|버튼)?[.!…]*$/);
    return !match ? null : /보내기|전송|발송/.test(match[1]) ? '보내기' : match[1];
  };
  const fingerprint = () => JSON.stringify([location.href, document.title,
    [...document.querySelectorAll('input,textarea,select,[contenteditable=true]')].map(el =>
      [el.tagName, el.id, el.name, el.type, el.value, el.checked, el.selectedIndex,
       el.isContentEditable ? el.innerText : null])]);
  const valid = (entry) => entry && entry.el.isConnected && !entry.el.disabled && nameOf(entry.el) === entry.name && roleOf(entry.el) === entry.role && entry.expires > Date.now() && entry.fingerprint === fingerprint();
`;

/** Keep the actual DOM node and input state on the page; never return field values to the model. */
export function prepareBrowserActionApproval(scope: string, id: string, action: BrowserCommitAction | 'confirm', pendingOnly = false): string {
  return `(() => {
    ${BROWSER_ACTION_DOM}
    const key = Symbol.for('xgen.browserActionApproval');
    const state = window[key] || (window[key] = {});
    state.approval = null;
    const scope = ${JSON.stringify(scope)};
    state.baseline = { id: ${JSON.stringify(id)}, scope, fingerprint: fingerprint(), expires: Date.now() + 120000 };
    let el;
    if (${JSON.stringify(action)} === 'confirm') {
      const pending = state.pending;
      if (pending?.scope === scope && valid(pending) && commitName(pending.el)) el = pending.el;
    } else {
      const candidates = [...document.querySelectorAll('button,input,a,[role=button],[role=menuitem]')]
        .filter(el => !el.disabled && el.getClientRects().length && commitName(el) === ${JSON.stringify(action)});
      if (candidates.length === 1) el = candidates[0];
    }
    state.pending = null;
    if (!el) return false;
    const entry = { scope, id: ${JSON.stringify(id)}, el, name: nameOf(el), role: roleOf(el), fingerprint: fingerprint(), expires: Date.now() + 120000 };
    if (${pendingOnly}) state.pending = entry;
    else state.approval = entry;
    return true;
  })()`;
}

const CHECK_BROWSER_APPROVAL_BASELINE = (scope: string, id: string) => `(() => {
  ${BROWSER_ACTION_DOM}
  const baseline = window[Symbol.for('xgen.browserActionApproval')]?.baseline;
  return !!baseline && baseline.id === ${JSON.stringify(id)} && baseline.scope === ${JSON.stringify(scope)} &&
    baseline.expires > Date.now() && baseline.fingerprint === fingerprint();
})()`;

export async function validateBrowserApproval(frames: Frame[], scope: string, id: string): Promise<boolean> {
  try { return (await Promise.all(frames.map(frame => guardScript(frame, CHECK_BROWSER_APPROVAL_BASELINE(scope, id))))).every(result => result === true); }
  catch { return false; }
}

export type BrowserCommandApproval = {
  scope: string;
  id?: string;
  instruction?: string;
  signal?: AbortSignal;
  onBlocked?: (action: BrowserCommitAction | null) => void;
  onConsumed?: () => void;
};

function installBrowserActionGuard(options?: BrowserCommandApproval): string {
  return `(() => {
  const key = Symbol.for('xgen.browserActionGuard');
  window[key]?.off();
  ${BROWSER_ACTION_DOM}
  const options = ${JSON.stringify(options ? { scope: options.scope, id: options.id, instruction: options.instruction } : {})};
  const sharedKey = Symbol.for('xgen.browserActionApproval');
  const shared = window[sharedKey] || (window[sharedKey] = {});
  const approval = shared.approval?.id === options.id && shared.approval?.scope === options.scope ? shared.approval : null;
  const state = { blocked: false, consumed: false };
  let activated = false, clicked = false, submitted = false, pendingRecorded = false;
  const authorized = (operation, el, eventType) => {
    if (!approval || (!activated && !valid(approval))) return false;
    if (operation === 'submit') {
      if (!activated || submitted || el !== approval.el.form) return false;
      submitted = true;
      return true;
    }
    if (operation !== 'click' || el !== approval.el || clicked) return false;
    // One activation may emit pointer/mouse events followed by its form submission.
    activated = true;
    state.consumed = true;
    shared.approval = null;
    if (eventType === 'click' || eventType === 'auxclick' || eventType === 'dblclick') clicked = true;
    return true;
  };
  const block = (el, event) => {
    state.blocked = true;
    if (options.scope && !pendingRecorded) {
      pendingRecorded = true;
      shared.pending = commitName(el) ? { scope: options.scope, el, name: nameOf(el), role: roleOf(el), fingerprint: fingerprint(), expires: Date.now() + 120000 } : null;
    }
    event?.preventDefault();
    event?.stopImmediatePropagation();
  };
  const handler = (event) => {
    const path = event.composedPath();
    const control = path.find(n => n?.matches?.('button,input,select,textarea,a,[role],[contenteditable]:not([contenteditable=false]),label,[onclick],[tabindex]'));
    // Opening a menu on mousedown can retarget click to body; page text is not a button label.
    const operation = event.type === 'submit' ? 'submit' : event.type.startsWith('key') ? 'keypress' : 'click';
    const doc = event.target.ownerDocument || event.target;
    if (operation === 'click' && !control && (event.target === doc.body || event.target === doc.documentElement)) return;
    let el = control || event.target;
    if (el?.matches('label') && el.control) el = el.control;
    let target = describe(el);
    if (operation === 'submit') {
      const active = event.target.ownerDocument.activeElement;
      target = { ...describe(event.submitter), unsafeForm: describe(event.target).unsafeForm, login: describe(event.target).login,
        search: event.submitter ? describe(event.submitter).search : active?.form === event.target && describe(active).search };
      el = event.target;
    }
    const chord = (event.ctrlKey ? 'Control+' : '') + (event.metaKey ? 'Meta+' : '') +
      (event.altKey ? 'Alt+' : '') + (event.shiftKey ? 'Shift+' : '') + (event.key === ' ' ? 'Space' : event.key || '');
    if (allowed(operation, target, chord, options.instruction || '')) return;
    if (authorized(operation, el, event.type)) return;
    block(operation === 'submit' ? event.submitter : el, event);
  };
  const events = ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','auxclick','keydown','keyup','keypress','submit'];
  for (const event of events) window.addEventListener(event, handler, true);
  const originalSubmit = HTMLFormElement.prototype.submit;
  const guardedSubmit = function () {
    const target = describe(this);
    const active = this.ownerDocument.activeElement;
    target.search = this.matches('[role=search]') || active?.form === this && describe(active).search;
    if (allowed('submit', target) || authorized('submit', this, 'submit')) return originalSubmit.call(this);
    block(null);
  };
  HTMLFormElement.prototype.submit = guardedSubmit;
  window[key] = { state, off: () => {
    clearTimeout(timer);
    if (HTMLFormElement.prototype.submit === guardedSubmit) HTMLFormElement.prototype.submit = originalSubmit;
    for (const event of events) window.removeEventListener(event, handler, true);
    delete window[key];
  } };
  const timer = setTimeout(() => window[key]?.off(), 125000);
  return true;
})()`;
}

// Installed only while an automation command runs, including in child frames.
export const INSTALL_BROWSER_ACTION_GUARD = installBrowserActionGuard();
export const REMOVE_BROWSER_ACTION_GUARD = `(() => {
  const guard = window[Symbol.for('xgen.browserActionGuard')];
  if (!guard) return false;
  const blocked = guard.state.blocked;
  guard.off();
  return blocked;
})()`;

const READ_BROWSER_PENDING_ACTION = `(() => { ${BROWSER_ACTION_DOM} return commitName(window[Symbol.for('xgen.browserActionApproval')]?.pending?.el); })()`;

const READ_BROWSER_ACTION_CONSUMED = `Boolean(window[Symbol.for('xgen.browserActionGuard')]?.state.consumed)`;

type Frame = { executeJavaScript(code: string): Promise<unknown>; detached?: boolean };

async function guardScript(frame: Frame, code: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.executeJavaScript(code),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('browser_denied: 브라우저 동작 안전 검사 시간 초과.')),
          1_500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareBrowserApproval(frames: Frame[], scope: string, id: string, action: BrowserCommitAction | 'confirm', pendingOnly = false): Promise<boolean> {
  try {
    const results = await Promise.all(frames.map(frame => guardScript(frame, prepareBrowserActionApproval(scope, id, action, pendingOnly))));
    return results.filter(result => result === true).length === 1;
  } catch { return false; }
}

/** A failed inspection must never let the automation proceed unguarded. */
export async function guardBrowserCommand<T>(frames: Frame[], run: () => Promise<T>, options?: BrowserCommandApproval): Promise<T> {
  if (!frames.length) throw new Error('browser_denied: 검사할 브라우저 프레임이 없습니다.');
  const armed: Frame[] = [];
  try {
    for (const frame of frames) {
      armed.push(frame);
      if ((await guardScript(frame, options ? installBrowserActionGuard(options) : INSTALL_BROWSER_ACTION_GUARD)) !== true)
        throw new Error('browser_denied: 브라우저 동작 안전 검사를 준비하지 못했습니다.');
    }
    if (options?.signal?.aborted) throw new Error('Browser action cancelled.');
    return await run();
  } finally {
    const blocked = await Promise.all(
      armed.map(async (frame) => {
        if (frame.detached) return false;
        try {
          let action: BrowserCommitAction | null = null;
          let blocked: unknown;
          try {
            if (options && await guardScript(frame, READ_BROWSER_ACTION_CONSUMED)) options.onConsumed?.();
            action = options ? await guardScript(frame, READ_BROWSER_PENDING_ACTION) as BrowserCommitAction | null : null;
          } finally { blocked = await guardScript(frame, REMOVE_BROWSER_ACTION_GUARD); }
          if (blocked === true) options?.onBlocked?.(action);
          return blocked;
        } catch (error) {
          if (frame.detached) return false;
          throw error;
        }
      }),
    );
    if (blocked.some((value) => value === true)) {
      throw new Error(`browser_denied: ${BROWSER_ACTION_BLOCKED}`);
    }
  }
}
