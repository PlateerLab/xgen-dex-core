import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  allowsBrowserAction,
  requestedBrowserCommit,
  browserCommitConfirmationAsked,
  guardBrowserCommand,
  INSTALL_BROWSER_ACTION_GUARD,
  REMOVE_BROWSER_ACTION_GUARD,
} from '../src/main/browser-action-guard';

test('values containing action words are data, quoted action buttons remain blocked', () => {
  for (const value of ['삭제 금지 상품', '등록 완료', 'remove stains', '승인요청']) {
    assert.equal(
      allowsBrowserAction(
        'fill',
        { role: 'textbox', name: '상품명' },
        '',
        `상품명에 「${value}」 입력해줘`,
      ),
      true,
    );
    assert.equal(
      allowsBrowserAction(
        'click',
        { role: 'combobox', name: '처리상태' },
        '',
        `처리상태를 「${value}」로 지정해줘`,
      ),
      true,
    );
  }
  for (const name of [
    '삭제',
    '저장',
    '임시 저장',
    '등록',
    '상품 등록',
    '승인 요청',
    'Save draft',
    'Submit',
    'Request approval',
  ]) {
    assert.equal(allowsBrowserAction('click', { role: 'button', name }), false, name);
    assert.equal(
      allowsBrowserAction('click', { role: 'button', name: '확인' }, '', `「${name}」 버튼 눌러줘`),
      false,
      name,
    );
  }
  assert.equal(
    allowsBrowserAction('click', { role: 'button', name: '확인' }, '', '모두 삭제해'),
    false,
  );
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '미리보기' }, '',
    '현재 메일 작성 화면에서 임시저장 버튼을 누르기'), false);
  assert.equal(
    allowsBrowserAction(
      'click',
      { role: 'textbox', name: '상품명' },
      '',
      '상품명에 「삭제 버튼 눌러줘」 입력해줘',
    ),
    true,
  );
});

test('navigation, field labels and ordinary controls remain available', () => {
  assert.equal(allowsBrowserAction('click', { role: 'link', name: '상품 등록' }), true);
  assert.equal(
    allowsBrowserAction('click', { role: 'link', name: '상품 등록', navigates: false }),
    false,
  );
  assert.equal(
    allowsBrowserAction(
      'click',
      { role: 'link', name: '상품 등록', navigates: true },
      '',
      '상품 등록 페이지로 이동해줘',
    ),
    true,
  );
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '상품 등록 페이지' }), true);
  assert.equal(allowsBrowserAction('fill', { role: 'textbox', name: '등록일' }), true);
  assert.equal(allowsBrowserAction('click', { role: 'checkbox', name: '삭제 금지' }), true);
  assert.equal(allowsBrowserAction('click', { role: 'option', name: '등록' }), true);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '조회' }), true);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '조회', submit: true, search: true }), true);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '조회', submit: true, search: true, unsafeForm: true }), false);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '확인', submit: true }), false);
  assert.equal(
    allowsBrowserAction('click', { role: 'link', name: '삭제', navigates: true }),
    false,
  );
  assert.equal(
    allowsBrowserAction('click', { role: 'link', name: '저장', navigates: true }),
    false,
  );
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '확인', reset: true }), false);
  // Unnamed icon buttons and section toggles (BO accordion) are ordinary controls.
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '' }), true);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '엑셀 내보내기' }), true);
});

test('sending needs approval like saving', () => {
  for (const name of ['보내기', '메일 보내기', '전송', '발송하기'])
    assert.equal(allowsBrowserAction('click', { role: 'button', name }), false, name);
  for (const text of ['메일 보내줘', '보내기 눌러줘', '전송해줘'])
    assert.equal(allowsBrowserAction('click', { role: 'button', name: '확인' }, '', text), false, text);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '확인' }, '', '엑셀 내보내기 눌러줘'), true);
  for (const text of ['메일 보내줘', '이 메일을 보내 주세요', '보내기 눌러줘', '전송해줘', '발송해줘'])
    assert.equal(requestedBrowserCommit(text), '보내기', text);
  for (const text of ['엑셀 내보내기 해줘', '메일 보내지 마', '다른 메일 보내줘'])
    assert.equal(requestedBrowserCommit(text), null, text);
  assert.equal(browserCommitConfirmationAsked('작성한 메일을 보낼까요?', '보내기'), true);
  assert.equal(browserCommitConfirmationAsked('메일을 전송할까요?', '보내기'), true);
  assert.equal(browserCommitConfirmationAsked('엑셀로 내보낼까요?', '보내기'), false);
});

test('Enter needs a known safe field; save shortcuts and business form submission are blocked', () => {
  for (const key of ['Control+s', 'Meta+S', 'Control+Shift+s', 'Cmd+s'])
    assert.equal(allowsBrowserAction('keypress', { role: 'textbox' }, key), false, key);
  assert.equal(allowsBrowserAction('keypress', {}, 'Enter'), false);
  assert.equal(allowsBrowserAction('keypress', { role: 'textbox' }, 'Enter'), false);
  assert.equal(allowsBrowserAction('keypress', { role: 'searchbox', search: true }, 'Enter'), true);
  assert.equal(
    allowsBrowserAction('keypress', { role: 'searchbox', search: true, unsafeForm: true }, 'Enter'),
    false,
  );
  assert.equal(
    allowsBrowserAction('keypress', { role: 'textbox', multiline: true }, 'Enter'),
    true,
  );
  assert.equal(
    allowsBrowserAction('keypress', { role: 'textbox', multiline: true }, 'Control+Enter'),
    false,
  );
  assert.equal(allowsBrowserAction('keypress', { role: 'textbox' }, 'Backspace'), true);
  assert.equal(allowsBrowserAction('keypress', {}, 'Delete'), false);
  assert.equal(allowsBrowserAction('keypress', { role: 'button', name: '등록' }, 'Space'), false);
  assert.equal(allowsBrowserAction('keypress', { role: 'textbox' }, ' '), true);
  assert.equal(allowsBrowserAction('submit', { search: true }), true);
  assert.equal(allowsBrowserAction('submit', { search: true, unsafeForm: true }), false);
  assert.equal(allowsBrowserAction('submit', {}), false);
  // Login: a password form without save-like buttons submits by button, form submit or Enter.
  assert.equal(allowsBrowserAction('submit', { login: true }), true);
  assert.equal(allowsBrowserAction('click', { role: 'button', name: '로그인', submit: true, login: true }), true);
  assert.equal(allowsBrowserAction('keypress', { role: 'textbox', login: true }, 'Enter'), true);
  assert.equal(allowsBrowserAction('submit', { login: true, unsafeForm: true }), false);
});

test('guard scripts install and remove with no transpiler-only dependencies', () => {
  const listeners = new Set();
  const context = {
    window: {
      addEventListener: (event: string) => listeners.add(event),
      removeEventListener: (event: string) => listeners.delete(event),
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    HTMLFormElement: { prototype: { submit: () => {} } },
  };
  const submit = context.HTMLFormElement.prototype.submit;
  assert.equal(runInNewContext(INSTALL_BROWSER_ACTION_GUARD, context), true);
  assert.notEqual(context.HTMLFormElement.prototype.submit, submit);
  assert.ok(listeners.has('submit'));
  assert.equal(runInNewContext(REMOVE_BROWSER_ACTION_GUARD, context), false);
  assert.equal(listeners.size, 0);
  assert.equal(context.HTMLFormElement.prototype.submit, submit);
});

test('execution guards every frame and returns a block instead of command success', async () => {
  const calls: string[] = [];
  const frames = ['top', 'child'].map((name) => ({
    executeJavaScript: async (code: string) => {
      calls.push(`${name}:${code === INSTALL_BROWSER_ACTION_GUARD ? 'install' : 'remove'}`);
      return code === INSTALL_BROWSER_ACTION_GUARD || name === 'child';
    },
  }));
  await assert.rejects(
    guardBrowserCommand(frames, async () => {
      calls.push('run');
    }),
    /browser_denied.*사용자/,
  );
  assert.deepEqual(calls, ['top:install', 'child:install', 'run', 'top:remove', 'child:remove']);
});

test('a failed installation does not execute; command failures still remove guards', async () => {
  let ran = false;
  let removed = 0;
  const frame = {
    executeJavaScript: async (code: string) => {
      if (code === REMOVE_BROWSER_ACTION_GUARD) removed++;
      return false;
    },
  };
  await assert.rejects(
    guardBrowserCommand([frame], async () => {
      ran = true;
    }),
    /준비하지 못/,
  );
  assert.equal(ran, false);
  assert.equal(removed, 1);
  frame.executeJavaScript = async (code) => {
    if (code === REMOVE_BROWSER_ACTION_GUARD) removed++;
    return code === INSTALL_BROWSER_ACTION_GUARD;
  };
  await assert.rejects(
    guardBrowserCommand([frame], async () => {
      throw new Error('command failed');
    }),
    /command failed/,
  );
  assert.equal(removed, 2);
  await assert.rejects(
    guardBrowserCommand([], async () => {
      ran = true;
    }),
    /프레임/,
  );
  assert.equal(ran, false);
});

test('an unresponsive page inspection times out before any action', async () => {
  let ran = false;
  const frame = {
    executeJavaScript: (code: string) =>
      code === INSTALL_BROWSER_ACTION_GUARD ? new Promise<never>(() => {}) : Promise.resolve(false),
  };
  await assert.rejects(
    guardBrowserCommand([frame], async () => {
      ran = true;
    }),
    /시간 초과/,
  );
  assert.equal(ran, false);
});


test('only explicit user execution requests or a pending confirmation confer commit intent', () => {
  for (const [text, action] of [
    ['이 상품 저장해줘', '저장'], ['「임시 저장」 버튼 눌러줘', '임시저장'],
    ['승인 요청해 주세요', '승인요청'], ['등록해줘', '등록'], ['제출해주세요', '제출'], ['네', 'confirm'],
    ['<xgen_browser_context>저장하지 마세요</xgen_browser_context>\n저장해줘', '저장'],
  ]) assert.equal(requestedBrowserCommit(text), action, text);
  for (const text of ['상품 정보를 입력해줘', '저장하지 마', '저장 안 해줘', '저장 전에 확인해줘',
    '저장해줘?', '저장 버튼까지 테스트해줘', '저장하고 승인요청해줘', '상품명에 「삭제」 입력해줘',
    '상품명에 \'저장해줘\' 입력해줘', '상품 등록 페이지 열어줘', '저장할 수 있어?', '저장했어', '삭제해줘', '다른 상품 저장해줘', '상품 B 저장해줘'])
    assert.equal(requestedBrowserCommit(text), null, text);
  assert.equal(requestedBrowserCommit([{ type: 'text', text: '저장해줘' }]), '저장');
});

test('explicit save requests may name the currently visible service, but not another page', () => {
  const title = '메일쓰기 : 네이버 메일';
  for (const text of ['네이버에서 임시저장 눌러줘', '지금 보이는 네이버 메일에서 임시 저장 눌러줘',
    '현재 화면에서 임시저장 버튼을 클릭해줘', '메일 작성 화면에서 임시저장해줘'])
    assert.equal(requestedBrowserCommit(text, title), '임시저장', text);
  for (const text of ['구글에서 임시저장해줘', '다른 네이버 메일에서 임시저장해줘',
    '네이버에서 다른 상품 저장해줘', '네이버에서 임시저장하지 마', '네이버에서 저장 전에 확인해줘'])
    assert.equal(requestedBrowserCommit(text, title), null, text);
  assert.equal(requestedBrowserCommit('네이버에서 임시저장해줘'), null);
});


test('confirmation needs a question naming the exact pending action', () => {
  assert.equal(browserCommitConfirmationAsked('현재 상품을 임시저장할까요?', '임시저장'), true);
  assert.equal(browserCommitConfirmationAsked('저장해도 될까요?', '저장'), true);
  for (const reply of ['저장했습니다.', '계속 진행할까요?', '승인요청할까요?', '저장하고 승인요청할까요?'])
    assert.equal(browserCommitConfirmationAsked(reply, '저장'), false, reply);
});

test('앞 문장의 사정 설명은 요청을 막지 않고, "임시저장 … 저장할까요?" 는 임시저장 하나를 묻는다', () => {
  assert.equal(requestedBrowserCommit('전시여부가 전시 안함이니까 안 뜨는게 맞아. 임시 저장해줘'), '임시저장');
  assert.equal(requestedBrowserCommit('임시저장해줘. 아니 하지 마'), null);
  assert.equal(requestedBrowserCommit('확인했어. 저장하지 마'), null);
  assert.equal(browserCommitConfirmationAsked('현재 상품을 **「임시저장」** 버튼으로 저장할까요?', '임시저장'), true);
  assert.equal(browserCommitConfirmationAsked('차단되어 저장되지 않았습니다. **현재 003 상품을 「임시저장」 버튼으로 저장할까요?**', '임시저장'), true);
  assert.equal(browserCommitConfirmationAsked('저장하고 승인요청할까요?', '저장'), false);
});
