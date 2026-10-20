const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { guardBrowserCommand } = require('../src/main/browser-action-guard.ts');
const { BrowserRuntime } = require('../src/main/browser-runtime.ts');
const { BrowserToolProvider, BROWSER_INTERACT_TOOL } = require('../src/main/browser-tools.ts');

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const contents = window.webContents;
  const js = (code) => contents.executeJavaScript(code);
  const guarded = (code) => guardBrowserCommand(contents.mainFrame.framesInSubtree, () => js(code));
  try {
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
      <button id="save" type="button" onclick="window.saved++"><span>임시저장</span></button>
      <button id="register" type="button" onclick="window.saved++">등록</button>
      <button id="approve" type="button" onclick="window.saved++">승인요청</button>
      <button id="preview" type="button" onclick="window.previewed++">미리보기</button>
      <button id="delete" type="button" onmouseup="window.saved++" onclick="window.saved++">삭제</button>
      <input id="name" aria-label="상품명">
      <textarea id="detail" aria-label="상품상세"></textarea>
      <a id="navigate" href="https://example.test/register" onclick="event.preventDefault();window.navigated++">상품 등록</a>
      <form id="business" onsubmit="event.preventDefault();window.saved++">
        <input id="businessQuery" type="search" aria-label="검색">
        <button id="generic">확인</button><button id="formSave">저장</button>
      </form>
      <form id="searchForm" onsubmit="event.preventDefault();window.searched++">
        <input id="search" name="entrNm"><button id="searchReset" type="reset">초기화</button><button id="searchButton">조회</button>
      </form>
      <button id="icon" type="button" onclick="window.toggled++"><svg width="8" height="8"></svg></button>
      <button id="send" type="button" onclick="window.sent++">보내기</button>
      <button id="export" type="button" onclick="window.exported++">엑셀 내보내기</button>
      <form id="login" onsubmit="event.preventDefault();window.loggedIn++">
        <input id="loginId" aria-label="아이디"><input id="loginPw" type="password" aria-label="비밀번호"><button id="resetPw" type="button">비밀번호 초기화</button><button id="loginButton">로그인</button>
      </form>
      <iframe id="child" srcdoc="<input id='childName' value='A'><button type='button' onclick='parent.saved++'>등록</button>"></iframe>
      <script>
        window.saved = 0; window.searched = 0; window.navigated = 0; window.previewed = 0;
        window.toggled = 0; window.sent = 0; window.exported = 0; window.loggedIn = 0;
        window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') window.saved++; });
        document.querySelector('#businessQuery').addEventListener('keyup', e => { if (e.key === 'Enter') window.saved++; });
      </script>
    `)}`,
    );
    for (const id of ['save', 'register', 'approve', 'delete', 'generic']) {
      await assert.rejects(guarded(`document.querySelector('#${id}').click()`), /browser_denied/);
      assert.equal(await js('window.saved'), 0, id);
    }
    await assert.rejects(
      guarded(
        `document.querySelector('#delete').dispatchEvent(new MouseEvent('mouseup', {bubbles:true,cancelable:true}))`,
      ),
      /browser_denied/,
    );
    await guarded(
      `document.querySelector('#name').value = '삭제 금지 상품';document.querySelector('#name').dispatchEvent(new Event('input',{bubbles:true}))`,
    );
    assert.equal(await js(`document.querySelector('#name').value`), '삭제 금지 상품');
    await guarded(`document.querySelector('#navigate').click()`);
    assert.equal(await js('window.navigated'), 1);
    await guarded(`document.querySelector('#searchButton').click()`);
    assert.equal(await js('window.searched'), 1);
    await guarded(`document.querySelector('#search').focus();document.querySelector('#searchForm').requestSubmit(document.querySelector('#searchButton'))`);
    assert.equal(await js('window.searched'), 2);
    await assert.rejects(guarded(`document.querySelector('#searchReset').click()`), /browser_denied/);
    await assert.rejects(
      guarded(`document.querySelector('#business').requestSubmit()`),
      /browser_denied/,
    );
    await assert.rejects(guarded(`document.querySelector('#business').submit()`), /browser_denied/);
    for (const id of ['name', 'businessQuery']) {
      await assert.rejects(
        guarded(
          `document.querySelector('#${id}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
        ),
        /browser_denied/,
      );
    }
    await assert.rejects(
      guarded(
        `document.querySelector('#businessQuery').dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,cancelable:true}))`,
      ),
      /browser_denied/,
    );
    for (const id of ['search', 'detail']) {
      await guarded(
        `document.querySelector('#${id}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`,
      );
    }
    await assert.rejects(
      guarded(
        `document.querySelector('#detail').dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true}))`,
      ),
      /browser_denied/,
    );
    await assert.rejects(
      guarded(
        `document.querySelector('#register').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))`,
      ),
      /browser_denied/,
    );
    await assert.rejects(
      guarded(`document.querySelector('#child').contentDocument.querySelector('button').click()`),
      /browser_denied/,
    );
    assert.equal(await js('window.saved'), 0);
    // MUI menus open on mousedown; the subsequent click may target body with every action label in it.
    await guarded(`document.body.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true}))`);
    await guarded(`document.body.dispatchEvent(new MouseEvent('mouseup', {bubbles:true,cancelable:true}))`);
    // Only the page root is skipped — a scripted div labelled 저장 is still a save button.
    await assert.rejects(
      guarded(`const d=document.createElement('div');d.textContent='저장';d.onclick=()=>window.saved++;document.body.append(d);d.click()`),
      /browser_denied/,
    );
    assert.equal(await js('window.saved'), 0);
    // Unnamed icon buttons, export and a login form are ordinary actions; 보내기 needs approval.
    await guarded(`document.querySelector('#icon').click()`);
    await guarded(`document.querySelector('#export').click()`);
    await guarded(`document.querySelector('#loginButton').click()`);
    await guarded(`document.querySelector('#loginPw').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await guarded(`document.querySelector('#login').requestSubmit()`);
    assert.deepEqual(await js('[window.toggled, window.exported, window.loggedIn]'), [1, 1, 2]);
    await assert.rejects(guarded(`document.querySelector('#send').click()`), /browser_denied/);
    assert.equal(await js('window.sent'), 0);
    assert.equal(await js(`!!window[Symbol.for('xgen.browserActionGuard')]`), false);
    // Exercise the legacy tool path, replacing only the external CLI with a DOM click.
    const runtime = new BrowserRuntime();
    runtime.enabled = true;
    runtime.accountPartition = 'test';
    const page = {
      pageId: 'guard-smoke',
      workflowId: 'guard-smoke',
      mode: 'shared',
      generation: 1,
    };
    runtime.activeByWorkflow.set(page.workflowId, page.pageId);
    runtime.pages.set(page.pageId, { info: page, contents, proxy: null, automationReset: null });
    runtime.runner.run = async (_id, _proxy, command) => {
      if (command[0] === 'snapshot') return { success: true, data: { snapshot: '- button 임시저장 [ref=e1]', refs: { e1: { role: 'button', name: '임시저장' } } } };
      if (command[0] === 'get' && command[1] === 'text') return { success: true, data: { text: await js('document.body.innerText') } };
      if (command[0] === 'eval') await js(command[1]);
      else {
        assert.equal(command[0], 'click');
        await js(`document.querySelector(${JSON.stringify(command[1] === '@e1' ? '#save' : command[1])}).click()`);
      }
      return { success: true };
    };
    const provider = new BrowserToolProvider(runtime);
    provider.configure(true);
    const listed = await provider.callTool('BrowserTabs', { action: 'list' }, { workflowId: page.workflowId });
    assert.equal(JSON.parse(listed.content[0].text).result[0].active, true);
    await assert.rejects(
      provider.callTool(
        BROWSER_INTERACT_TOOL,
        {
          action: 'click',
          page_id: page.pageId,
          ref: '#save',
          confirmed: true,
        },
        { workflowId: page.workflowId },
      ),
      /browser_denied/,
    );
    assert.equal(await js('window.saved'), 0);
    const results = await Promise.allSettled(
      ['#save', '#generic', '#navigate'].map((ref) =>
        provider.callTool(
          BROWSER_INTERACT_TOOL,
          { action: 'click', page_id: page.pageId, ref },
          { workflowId: page.workflowId },
        ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected', 'fulfilled'],
    );
    assert.equal(await js('window.saved'), 0);
    assert.equal(await js('window.navigated'), 2);
    const context = { workflowId: page.workflowId, interactionId: 'approval-chat' };
    const user = (text, signal = new AbortController().signal) =>
      runtime.prepareUserBrowserAction(page.workflowId, context.interactionId, text, signal);
    const click = (ref, ctx = context) => provider.callTool(BROWSER_INTERACT_TOOL,
      { action: 'click', page_id: page.pageId, ref, confirmed: true }, ctx);
    let expected = 0;
    const saved = async () => assert.equal(await js('window.saved'), expected);
    const blocked = async (ref, ctx) => { await assert.rejects(click(ref, ctx), /browser_denied/); await saved(); };
    runtime.noteBrowserActionReply(page.workflowId, context.interactionId, '현재 상품을 임시저장할까요?');
    await user('네');
    await click('#save'); expected++; await saved(); // Ask before attempting any mutation.
    runtime.noteBrowserActionReply(page.workflowId, context.interactionId, '현재 상품을 임시저장할까요?');
    await runtime.pendingQuestions.get(JSON.stringify([page.workflowId, context.interactionId]));
    await js("document.querySelector('#name').value = '확인 질문 뒤 변경된 상품'");
    await user('네');
    await blocked('#save');
    await user('임시저장해줘');
    await blocked('#approve');
    await click('#save'); expected++; await saved();
    await blocked('#save'); // The first successful execution consumed approval.
    await user('승인요청해줘');
    await blocked('#approve', { ...context, interactionId: 'other-chat' });
    await click('#approve'); expected++; await saved();
    await user('임시저장해줘');
    await js("document.querySelector('#name').value = '다른 상품'");
    await blocked('#save'); // Changed input needs fresh approval.
    await user('임시저장해줘');
    await js("document.querySelector('#save').replaceWith(document.querySelector('#save').cloneNode(true))");
    await blocked('#save'); // Same text on a replaced DOM node is a different target.
    await user('임시저장해줘');
    await js("window[Symbol.for('xgen.browserActionApproval')].approval.expires = Date.now() - 1");
    await blocked('#save');
    await user('임시저장해줘');
    await user('저장하지 마');
    await blocked('#save');
    await user('네');
    await blocked('#save'); // An unrelated yes is not approval.
    runtime.noteBrowserActionReply(page.workflowId, context.interactionId, '현재 상품을 임시저장할까요?');
    await user('네');
    await click('#save'); expected++; await saved(); // Confirmation of the exact pending button.
    await user('저장해줘');
    await click('#formSave'); expected++; await saved(); // The same activation can submit its own form.
    await blocked('#formSave');
    await user('임시저장해줘');
    await assert.rejects(runtime.runAgentCommand(page.workflowId, page.pageId,
      ['eval', "document.querySelector('#save').click()"], 5000, undefined, context), /browser_denied/);
    await saved(); // Approval cannot be rerouted through eval.
    const controller = new AbortController();
    await user('임시저장해줘', controller.signal); controller.abort();
    await blocked('#save');
    await user('임시저장해줘');
    await click('#save'); expected++; await saved();
    await user('임시저장해줘');
    await js("document.querySelector('#child').contentDocument.querySelector('#childName').value = 'B'");
    await blocked('#save'); // Changes in another frame invalidate the page approval too.
    await user('임시저장해줘');
    await js("document.querySelector('#save').textContent = '등록'");
    await blocked('#save'); // A renamed control cannot reuse the old node's approval.
    await js("document.querySelector('#save').textContent = '임시저장'");
    await user('등록해줘');
    await blocked('#register'); // Two visible registration buttons are ambiguous.
    runtime.noteBrowserActionReply(page.workflowId, context.interactionId, '현재 상품을 등록할까요?');
    await user('네');
    await click('#register'); expected++; await saved();
    const sent = async (n) => assert.equal(await js('window.sent'), n);
    await assert.rejects(click('#send'), /browser_denied/); await sent(0);
    await user('메일 보내줘');
    await click('#send'); await sent(1);
    await assert.rejects(click('#send'), /browser_denied/); await sent(1);
    runtime.noteBrowserActionReply(page.workflowId, context.interactionId, '작성한 메일을 보낼까요?');
    await user('응');
    await click('#send'); await sent(2);
    const post = async body => Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
      { choice: 'e1', probabilities: Object.fromEntries(Object.keys(question.criteria).map(ref => [ref, ref === 'e1' ? 0.99 : 0.01])) }]));
    provider.configure(true, () => [], () => {}, () => post);
    page.title = '메일쓰기 : 네이버 메일';
    await user('지금 보이는 네이버 메일에서 임시 저장 눌러줘');
    await assert.rejects(runtime.runAgentCommand(page.workflowId, page.pageId,
      ['click', '#preview'], 5000, undefined, { ...context, instruction: '현재 메일 작성 화면에서 임시저장 버튼을 누르기' }), /browser_denied/);
    assert.equal(await js('window.previewed'), 0);
    await click('#save'); expected++; await saved();
    await js("document.querySelector('#save').onclick = () => { window.saved++; document.querySelector('#name').insertAdjacentHTML('afterend', '<p>단계 임시저장 완료</p>'); }; void 0");
    await user('임시저장해줘');
    const stepped = await provider.callTool(BROWSER_INTERACT_TOOL, {
      action: 'step', operation: 'click', page_id: page.pageId, instruction: '임시저장 클릭',
      expect: [{ kind: 'text', value: '단계 임시저장 완료' }],
    }, context);
    assert.match(JSON.stringify(stepped), /completed/);
    expected++; await saved();
    await blocked('#save');
    await user('임시저장해줘');
    const unverified = await provider.callTool(BROWSER_INTERACT_TOOL, {
      action: 'step', operation: 'click', page_id: page.pageId, instruction: '임시저장 클릭',
      expect: [{ kind: 'text', value: '임시저장' }],
    }, context);
    assert.equal(unverified.isError, true);
    assert.match(JSON.stringify(unverified), /needs_replan/);
    expected++; await saved();
    runtime.pages.set('other-page', { info: { ...page, pageId: 'other-page' }, contents, proxy: null, automationReset: null });
    await user('승인요청해줘');
    await assert.rejects(provider.callTool(BROWSER_INTERACT_TOOL,
      { action: 'click', page_id: 'other-page', ref: '#approve' }, context), /browser_denied/);
    await saved();
    // Once automation ends, the user's own action remains available.
    await js(`document.querySelector('#save').click()`);
    expected++; await saved();
    process.stdout.write(
      'browser action guard smoke passed: input, navigation, search, commit/delete, submit, keys, child frame, explicit approval, one-shot scope, changed inputs/node, expiry, cancellation, cleanup\n',
    );
  } finally {
    window.destroy();
    app.quit();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
