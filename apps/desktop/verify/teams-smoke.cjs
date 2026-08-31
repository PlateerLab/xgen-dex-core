/**
 * Agent ↔ Teams 다리 — 실제 렌더러를 띄워 **경계를 건너간 값**을 검증한다.
 *
 * 단위 테스트(`test/teams-bridge.test.ts`)는 형식이 맞는지 본다. 여기서 보는 것은
 * 그 형식이 **화면의 실제 조작으로 정말 만들어지는가** 다. 이 둘 사이에서 조용히
 * 깨지는 것들이 있다: 칩은 떴는데 봉투가 안 붙거나, 칩을 껐는데도 붙거나,
 * 답장 버튼은 눌리는데 replyToId 가 안 실리거나.
 *
 * 서버는 필요 없다 — `teams-preload.cjs` 가 브릿지를 목으로 대체하고 모든 호출을
 * 기록하며, 이 스크립트는 빌드된 렌더러를 조작한 뒤 그 기록을 확인한다.
 *
 *   실행:  npm run verify:teams
 *   (out/ 이 최신이어야 한다 — 먼저 npm run build)
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const OUT = process.env.SHOTS_DIR || path.join(__dirname, '..', 'out', 'verify-teams');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let checks = 0;

function ok(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  ✖ ${label}`);
  if (detail !== undefined)
    console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return false;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

/**
 * React 가 제어하는 input/textarea 에 값을 넣는다. value 를 그냥 대입하면
 * React 는 변화를 모른다 — 네이티브 setter 로 넣고 input 이벤트를 쏴야 onChange
 * 가 돈다 (verify/main.cjs 와 같은 이유·같은 방법).
 */
const DRIVE = `
window.__setValue = function (el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
/**
 * **보이는** 요소만 고른다. 사이드 패널 세 개(Agent/탐색기/Teams)는 전환할 때
 * 언마운트되지 않고 display:none 으로 숨는다 — 목록 스크롤과 상태를 유지하려는
 * 의도적 설계다. 그래서 셀렉터를 그냥 쓰면 숨어 있는 패널이 먼저 잡힌다.
 */
window.__vis = function (selector) {
  return [...document.querySelectorAll(selector)].filter(
    (n) => n.offsetParent !== null || n.getClientRects().length > 0,
  );
};
window.__click = function (selector, text) {
  const list = window.__vis(selector);
  const match = (n) =>
    (n.textContent || '').includes(text) ||
    (n.title || '').includes(text) ||
    (n.getAttribute('aria-label') || '').includes(text);
  const el = text === undefined ? list[0] : list.find(match);
  if (!el) return false;
  el.click();
  return true;
};
window.__text = function (selector) {
  const el = window.__vis(selector)[0];
  return el ? el.textContent || '' : null;
};
window.__count = function (selector) {
  return window.__vis(selector).length;
};
window.__enter = function (selector) {
  const el = window.__vis(selector)[0];
  if (!el) return false;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
};
true;
`;

app
  .whenReady()
  .then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const win = new BrowserWindow({
      width: 1360,
      height: 900,
      show: false,
      webPreferences: {
        offscreen: true,
        preload: path.join(__dirname, 'teams-preload.cjs'),
        contextIsolation: true,
        sandbox: false,
      },
    });
    win.webContents.setFrameRate(30);

    const js = (code) => win.webContents.executeJavaScript(code, true);
    const calls = () => js('window.__verify.calls()');
    const clearCalls = () => js('window.__verify.clear()');
    // 오프스크린 캡처는 환경에 따라 실패한다(UnknownVizError). 검증의 본체는
    // 기록된 호출값이므로, 그림을 못 남겼다고 멈추지 않는다.
    let shotsOk = true;
    const snap = async (name) => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, name), img.toPNG());
      } catch (e) {
        if (shotsOk) console.log(`  (스크린샷 비활성: ${String(e).slice(0, 60)})`);
        shotsOk = false;
      }
    };
    // 렌더러 오류를 삼키지 않는다 — 목이 부족해 컴포넌트가 죽으면 그게 원인이다.
    const pageErrors = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) pageErrors.push(message);
    });

    await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'));
    await js(DRIVE);
    await sleep(1200);

    // ── 1. Teams 뷰가 세 번째 자리에 있다 ─────────────────────────
    section('1. [Teams] 사이드 뷰');
    ok('액티비티바에 Teams 버튼이 있다', await js(`window.__click('.ab-btn', 'Teams')`));
    await sleep(700);
    const roomList = await js(`window.__text('.agent-list')`);
    ok('방 목록에 방 이름이 뜬다', /3팀 개발방/.test(roomList || ''), roomList);
    await snap('01-teams-panel.png');

    ok('삭제 전 두 번째 방이 보인다', /공지방/.test(roomList || ''));
    ok(
      '삭제될 방을 탭으로 열 수 있다',
      await js(`window.__click('.agent-list .teams-room-open', '공지방')`),
    );
    await sleep(350);
    await js(`window.__verify.removeRoom('room-2')`);
    await sleep(350);
    ok(
      '삭제 이벤트 직후 새로고침 없이 목록에서 사라진다',
      !/공지방/.test((await js(`window.__text('.agent-list')`)) || ''),
    );
    ok(
      '삭제된 방의 열린 탭도 즉시 닫힌다',
      !/공지방/.test((await js(`window.__text('.tab-strip')`)) || ''),
    );

    // ── 1b. 사이드바 인라인 폼도 바깥 클릭/Esc 로 닫힌다 ─────────
    section('1b. 사이드바 폼 닫기');
    ok('[1:1 대화 시작] 을 누른다', await js(`window.__click('.icon-btn', '1:1 대화 시작')`));
    await sleep(400);
    ok('폼이 펼쳐진다', (await js(`window.__count('.teams-form')`)) === 1);
    ok(
      '[닫기] 버튼은 없어졌다',
      !(await js(
        `(()=>{const f=window.__vis('.teams-form')[0];return f?[...f.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='닫기'):false;})()`,
      )),
    );
    ok('닫는 법을 안내한다', /Esc/.test((await js(`window.__text('.teams-form')`)) || ''));
    await js(
      `(()=>{document.querySelector('.agent-list').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));})()`,
    );
    await sleep(350);
    ok('바깥을 누르면 닫힌다', (await js(`window.__count('.teams-form')`)) === 0);

    ok('다시 연다', await js(`window.__click('.icon-btn', '1:1 대화 시작')`));
    await sleep(350);
    ok('열렸다', (await js(`window.__count('.teams-form')`)) === 1);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(300);
    ok('Esc 로도 닫힌다', (await js(`window.__count('.teams-form')`)) === 0);

    // 여는 버튼이 '바깥' 으로 잡히면 한 번 눌러서는 절대 안 열린다 — 그 회귀를 막는다.
    ok('토글 버튼은 한 번에 열린다', await js(`window.__click('.icon-btn', '새 대화 만들기')`));
    await sleep(350);
    ok('새 대화 폼이 열렸다', (await js(`window.__count('.teams-form')`)) === 1);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(300);

    // ── 2. 방을 탭으로 열고 메시지를 그린다 ───────────────────────
    section('2. 방 탭 · 메시지 렌더');
    ok(
      '방을 클릭해 탭으로 연다',
      await js(`window.__click('.agent-list .teams-room-open', '3팀 개발방')`),
    );
    await sleep(900);
    const log = await js(`window.__text('.chat-log')`);
    ok('남의 메시지가 보인다', /결제 모듈 타임아웃/.test(log || ''), log);
    ok('발신자 이름이 보인다', /김철수/.test(log || ''));
    ok(
      '탭 제목이 방 이름이다',
      /3팀 개발방/.test((await js(`window.__text('.tab-item.active')`)) || ''),
    );
    await snap('02-teams-room.png');

    // ── 2b. 현재 멤버 목록 · 초대 직후 인원수 ─────────────────────
    section('2b. 멤버 목록 · 초대 즉시 반영');
    ok('헤더의 [멤버 2]를 누른다', await js(`window.__click('.teams-members-button', '멤버 2')`));
    await sleep(350);
    const membersBefore = await js(`window.__text('.teams-members-modal')`);
    ok('멤버 목록 모달이 열린다', (await js(`window.__count('.teams-members-modal')`)) === 1);
    ok(
      '현재 멤버 이름을 확인할 수 있다',
      /관리자/.test(membersBefore || '') && /김철수/.test(membersBefore || ''),
    );
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(250);

    await clearCalls();
    ok('초대창을 연다', await js(`window.__click('.chat-header-actions button', '초대')`));
    await sleep(250);
    await js(`window.__setValue(document.querySelector('.teams-invite input'), '이영희')`);
    await sleep(500);
    ok(
      '검색한 사용자를 초대한다',
      await js(`window.__click('.teams-invite .agent-item', '이영희')`),
    );
    await sleep(500);
    const inviteCall = (await calls()).find((c) => c.name === 'teams.addMember');
    ok(
      'addMember 가 선택한 사용자로 호출된다',
      inviteCall && inviteCall.args.userId === 3,
      inviteCall,
    );
    ok(
      '초대 직후 헤더 인원수가 3명으로 바뀐다',
      /멤버 3명/.test((await js(`window.__text('.chat-title-text .agent-meta')`)) || ''),
    );
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(250);
    ok('멤버 목록을 다시 연다', await js(`window.__click('.teams-members-button', '멤버 3')`));
    await sleep(300);
    ok(
      '초대한 사람이 목록에 즉시 보인다',
      /이영희/.test((await js(`window.__text('.teams-members-modal')`)) || ''),
    );
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(250);

    // ── 3. 답장 — replyToId 가 실제로 실리는가 ────────────────────
    section('3. 답장');
    await clearCalls();
    ok('메시지의 [답장] 버튼을 누른다', await js(`window.__click('.teams-react-btn', '답장')`));
    await sleep(300);
    const replyBar = await js(`window.__text('.teams-reply-bar')`);
    ok('답장 인용 배너가 뜬다', /김철수/.test(replyBar || ''), replyBar);
    await snap('03-reply-bar.png');
    await js(
      `window.__setValue(document.querySelector('.composer-input'), '커넥션 풀 확인해볼게요')`,
    );
    await sleep(150);
    await js(`window.__enter('.composer-input')`);
    await sleep(700);
    let sendCall = (await calls()).find((c) => c.name === 'teams.send');
    ok('teams.send 가 호출됐다', !!sendCall, await calls());
    ok(
      'replyToId 에 원본 메시지 id 가 실렸다',
      sendCall && sendCall.args.replyToId === 'm1',
      sendCall && sendCall.args,
    );
    ok('본문이 그대로 실렸다', sendCall && sendCall.args.content === '커넥션 풀 확인해볼게요');
    ok('전송 후 답장 배너가 사라진다', (await js(`window.__count('.teams-reply-bar')`)) === 0);

    // ── 4. 첨부 — 추출 텍스트까지 통과하는가 ──────────────────────
    section('4. 파일 첨부');
    await clearCalls();
    ok('[파일 첨부] 를 누른다', await js(`window.__click('.composer-shot', '파일 첨부')`));
    await sleep(500);
    const staged = await js(`window.__text('.teams-staged')`);
    ok('올린 파일이 대기 목록에 뜬다', /로그분석\.xlsx/.test(staged || ''), staged);
    await snap('04-staged-attachment.png');
    await js(`window.__setValue(document.querySelector('.composer-input'), '로그 붙입니다')`);
    await sleep(150);
    await js(`window.__enter('.composer-input')`);
    await sleep(700);
    sendCall = (await calls()).find((c) => c.name === 'teams.send');
    ok(
      '첨부가 함께 전송된다',
      sendCall &&
        Array.isArray(sendCall.args.attachments) &&
        sendCall.args.attachments.length === 1,
      sendCall && sendCall.args,
    );
    ok(
      '서버가 추출한 본문(extractedText)이 버려지지 않는다',
      sendCall && /커넥션 풀 고갈 추정/.test(JSON.stringify(sendCall.args.attachments)),
      sendCall && sendCall.args.attachments,
    );
    ok('전송 후 대기 목록이 비워진다', (await js(`window.__count('.teams-staged')`)) === 0);
    const afterSend = await js(`window.__text('.chat-log')`);
    ok('보낸 메시지에 첨부 카드가 그려진다', /로그분석\.xlsx/.test(afterSend || ''));
    await snap('05-sent-attachment.png');

    // ── 5. 편집 ───────────────────────────────────────────────────
    section('5. 내 메시지 편집');
    await clearCalls();
    // 방금 보낸 답장을 고친다 — 편집이 답장 인용을 지워 버리지 않는지 함께 본다.
    const quoteBefore = await js(`window.__count('.teams-quote')`);
    ok('답장 인용이 화면에 있다', quoteBefore >= 1, quoteBefore);
    ok('내 메시지의 [편집] 이 있다', await js(`window.__click('.teams-react-btn', '편집')`));
    await sleep(300);
    ok('편집 상자가 열린다', (await js(`window.__count('.teams-edit textarea')`)) === 1);
    await js(
      `window.__setValue(document.querySelector('.teams-edit textarea'), '로그 붙입니다 (수정)')`,
    );
    await sleep(150);
    await js(`window.__enter('.teams-edit textarea')`);
    await sleep(600);
    const editCall = (await calls()).find((c) => c.name === 'teams.edit');
    ok(
      'teams.edit 이 새 본문으로 호출된다',
      editCall && editCall.args.content === '로그 붙입니다 (수정)',
      editCall && editCall.args,
    );
    ok('편집 상자가 닫힌다', (await js(`window.__count('.teams-edit textarea')`)) === 0);
    ok('본문이 바뀐다', /수정/.test((await js(`window.__text('.chat-log')`)) || ''));
    ok('편집됨 표시가 붙는다', /편집됨/.test((await js(`window.__text('.chat-log')`)) || ''));
    // ⭐ 편집을 "교체" 로 다루면 서버 응답에 없는 필드(답장 스냅샷·첨부)가 지워진다.
    ok(
      '편집해도 답장 인용이 남아 있다',
      (await js(`window.__count('.teams-quote')`)) >= quoteBefore,
      { before: quoteBefore, after: await js(`window.__count('.teams-quote')`) },
    );

    // ── 5b. 방 관리 — 이름 · 알림 · 나가기 ───────────────────────
    section('5b. 방 관리 (이름/알림/나가기)');
    await clearCalls();
    ok(
      '헤더에서 방 메뉴가 제거됐다',
      (await js(`window.__count('.chat-header .teams-menu-wrap')`)) === 0,
    );
    ok(
      '목록 행의 설정 버튼으로 방 메뉴를 연다',
      await js(`window.__click('.teams-room-menu-trigger', '대화방 설정')`),
    );
    await sleep(300);
    const menu = await js(`window.__text('.teams-menu')`);
    ok('이름 바꾸기가 있다', /이름 바꾸기/.test(menu || ''), menu);
    ok('알림 끄기가 있다', /알림 끄기/.test(menu || ''));
    ok('나가기가 있다', /나가기/.test(menu || ''));
    ok('방장에게도 별도 삭제 동작은 보이지 않는다', !/대화방 삭제/.test(menu || ''));
    await snap('13-room-menu.png');

    ok('[이름 바꾸기] 를 누른다', await js(`window.__click('.teams-menu button', '이름 바꾸기')`));
    await sleep(400);
    ok('이름 입력창이 열린다', (await js(`window.__count('.modal.modal-sm')`)) === 1);
    await js(`window.__setValue(window.__vis('.modal.modal-sm input')[0], '3팀 개발방 (수정)')`);
    await sleep(150);
    ok(
      '[이름 바꾸기] 확정',
      await js(`window.__click('.modal.modal-sm .modal-actions button', '이름 바꾸기')`),
    );
    await sleep(600);
    const renameCall = (await calls()).find((c) => c.name === 'teams.updateRoom');
    ok(
      'updateRoom 이 새 이름으로 호출된다',
      renameCall && renameCall.args.patch.name === '3팀 개발방 (수정)',
      renameCall && renameCall.args,
    );
    ok('탭 제목이 바뀐다', /수정/.test((await js(`window.__text('.tab-item.active')`)) || ''));

    await clearCalls();
    ok(
      '목록 행에서 방 메뉴를 다시 연다',
      await js(`window.__click('.teams-room-menu-trigger', '대화방 설정')`),
    );
    await sleep(250);
    ok('[알림 끄기] 를 누른다', await js(`window.__click('.teams-menu button', '알림 끄기')`));
    await sleep(400);
    // 공통 알림 프로필의 방 단위 scope 로 저장돼야 한다.
    const muteSave = (await calls()).find(
      (c) =>
        c.name === 'notifications.update' &&
        c.args &&
        c.args.kind === 'scope' &&
        c.args.scope === 'teamsRoom',
    );
    ok(
      '음소거가 계정별 방 scope 로 저장된다',
      muteSave && muteSave.args.id === 'room-1' && muteSave.args.muted === true,
      muteSave && muteSave.args,
    );
    ok(
      'teams 설정을 통째로 덮어쓰지 않는다',
      !(await calls()).some((c) => c.name === 'config.set' && c.args && c.args.teams),
      (await calls()).filter((c) => c.name === 'config.set').map((c) => c.args),
    );
    ok(
      '메뉴를 다시 열면 [알림 켜기] 로 바뀐다',
      (await js(`window.__click('.teams-room-menu-trigger', '대화방 설정')`)) && true,
    );
    await sleep(250);
    ok('토글 라벨이 반영된다', /알림 켜기/.test((await js(`window.__text('.teams-menu')`)) || ''));
    await js(`window.__click('.teams-menu-scrim')`);
    await sleep(200);

    // ── 5c. 모달은 Esc 로도 닫힌다 ───────────────────────────────
    section('5c. 모달 닫기 (바깥 클릭 · Esc)');
    ok('초대창을 연다', await js(`window.__click('.chat-header-actions button', '초대')`));
    await sleep(400);
    ok('초대창이 열렸다', (await js(`window.__count('.modal.teams-invite')`)) === 1);
    ok(
      '[닫기] 버튼은 없어졌다',
      !/닫기<\/button>/.test((await js(`window.__text('.modal.teams-invite')`)) || '') &&
        !(await js(
          `(()=>{const m=window.__vis('.modal.teams-invite')[0];return m?[...m.querySelectorAll('button')].some(b=>(b.textContent||'').trim()==='닫기'):false;})()`,
        )),
    );
    ok('닫는 법을 안내한다', /Esc/.test((await js(`window.__text('.modal.teams-invite')`)) || ''));
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await sleep(350);
    ok('Esc 로 닫힌다', (await js(`window.__count('.modal.teams-invite')`)) === 0);
    ok('다시 연다', await js(`window.__click('.chat-header-actions button', '초대')`));
    await sleep(350);
    await js(
      `(()=>{const b=window.__vis('.modal-backdrop')[0];b.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`,
    );
    await sleep(350);
    ok('바깥 클릭으로도 닫힌다', (await js(`window.__count('.modal.teams-invite')`)) === 0);

    // ── 6. ⭐ 자동 컨텍스트 — 봉투가 실제로 실리는가 ──────────────
    section('6. Teams 문맥 → Agent (자동 칩)');
    ok('Agent 뷰로 전환', await js(`window.__click('.ab-btn', 'Agent')`));
    await sleep(500);
    ok(
      '에이전트를 골라 대화를 만든다',
      await js(`window.__click('.agent-list .agent-item', '사내문서 QA')`),
    );
    await sleep(700);
    // 에이전트를 고르면 세션이 생기고 탭이 붙는다. 사이드 뷰를 바꾸는 것만으로는
    // **메인 탭이 바뀌지 않는다** — 사용자가 그 탭을 눌러야 한다 (탭이 곧 화면이다).
    ok('생긴 대화 탭으로 전환한다', await js(`window.__click('.tab-item', '사내문서 QA')`));
    await sleep(900);
    ok(
      '에이전트 대화가 활성 탭이다',
      /사내문서 QA/.test((await js(`window.__text('.tab-item.active')`)) || ''),
      await js(`window.__text('.tab-item.active')`),
    );
    // ⭐ 자동 부착은 **없어야 한다** — 방을 본 것만으로 문맥이 되면 사용자가
    // 고른 적 없는 남의 대화가 나간다.
    ok('아무것도 저절로 붙어 있지 않다', (await js(`window.__count('.teams-ctx')`)) === 0);
    ok('대신 [Teams 대화 붙이기] 가 있다', (await js(`window.__count('.teams-ctx-add')`)) === 1);
    ok('붙이기를 누른다', await js(`window.__click('.teams-ctx-add')`));
    await sleep(600);
    ok('방 선택 창이 열린다', (await js(`window.__count('.modal.teams-share')`)) === 1);
    ok('방을 고른다', await js(`window.__click('.modal.teams-share .agent-item', '3팀 개발방')`));
    await sleep(600);
    ok('고르면 창이 닫힌다', (await js(`window.__count('.modal.teams-share')`)) === 0);
    const chip = await js(`window.__text('.teams-ctx')`);
    ok('고른 방이 칩으로 붙는다', /3팀 개발방/.test(chip || ''), chip);
    ok('칩이 함께 전달된다는 사실을 적어 둔다', /에이전트에게 함께 전달/.test(chip || ''));
    await snap('06-context-chip.png');

    await clearCalls();
    await js(`window.__setValue(document.querySelector('.composer-input'), '이 대화 요약해줘')`);
    await sleep(150);
    await js(`window.__enter('.composer-input')`);
    await sleep(800);
    const confirmText = await js(`window.__text('.teams-ctx-confirm')`);
    ok('첫 전송에서 확인창이 뜬다', !!confirmText, confirmText);
    // 고정 숫자를 기대하지 않는다 — 이 스모크가 앞 단계에서 방에 메시지를 더
    // 보냈으므로 건수는 진행에 따라 달라진다. 지켜야 하는 것은 숫자 자체가
    // 아니라 **고지한 수와 실제로 나간 수가 같다**는 것이고, 아래에서 그걸 본다.
    const declared = /(\d+)건/.exec(confirmText || '');
    ok('몇 건이 나가는지 숫자로 밝힌다', !!declared, confirmText);
    ok('어느 방인지 밝힌다', /3팀 개발방/.test(confirmText || ''));
    ok('아직 전송되지 않았다', !(await calls()).some((c) => c.name === 'chat.stream'));
    await snap('07-consent-dialog.png');

    ok(
      '[보내기] 를 누른다',
      await js(`window.__click('.teams-ctx-confirm .modal-actions button', '보내기')`),
    );
    await sleep(900);
    let streamCall = (await calls()).find((c) => c.name === 'chat.stream');
    ok('chat.stream 이 호출된다', !!streamCall, await calls());
    const input1 = streamCall ? String(streamCall.args.input) : '';
    ok('입력에 Teams 봉투가 붙었다', input1.includes('<xgen_teams_context>'), input1.slice(0, 200));
    ok('봉투 안에 방 대화가 들어 있다', input1.includes('결제 모듈 타임아웃'));
    ok('봉투 안에 방 이름이 들어 있다', input1.includes('3팀 개발방'));
    ok(
      '사용자가 친 문장이 끝에 그대로 남는다',
      input1.trimEnd().endsWith('이 대화 요약해줘'),
      input1.slice(-80),
    );
    // ⭐ 동의의 정직성 — 확인창이 말한 건수와 봉투에 실제로 담긴 건수가 같아야
    // 한다. 어긋나면 사용자는 30건을 승인하고 200건을 보낸 셈이 된다.
    const envelope = /<xgen_teams_context>\s*([\s\S]*?)\s*<\/xgen_teams_context>/.exec(input1);
    let parsed = null;
    try {
      parsed = envelope ? JSON.parse(envelope[1]) : null;
    } catch (e) {
      parsed = null;
    }
    ok('봉투가 파싱 가능한 JSON 이다', !!parsed, envelope && envelope[1].slice(0, 120));
    ok(
      '고지한 건수와 실제로 실린 건수가 같다',
      !!parsed && !!declared && parsed.count === Number(declared[1]),
      { 고지: declared && declared[1], 실제: parsed && parsed.count },
    );
    ok('봉투에 발신자 종류가 함께 실린다', !!parsed && parsed.messages.every((m) => !!m.role));
    ok(
      '화면에는 봉투가 보이지 않는다',
      !/xgen_teams_context/.test((await js(`window.__text('.chat-log')`)) || ''),
    );
    await snap('08-agent-answer.png');

    // ── 7. 같은 방·같은 범위는 다시 묻지 않는다 ───────────────────
    section('7. 재확인 없이 이어 보내기');
    await clearCalls();
    await js(`window.__setValue(document.querySelector('.composer-input'), '한 줄 더')`);
    await sleep(150);
    await js(`window.__enter('.composer-input')`);
    await sleep(700);
    ok('확인창이 다시 뜨지 않는다', (await js(`window.__count('.teams-ctx-confirm')`)) === 0);
    streamCall = (await calls()).find((c) => c.name === 'chat.stream');
    ok(
      '문맥은 계속 붙는다',
      streamCall && String(streamCall.args.input).includes('<xgen_teams_context>'),
    );

    // ── 8. ⭐ 칩을 끄면 정말 안 나가는가 ──────────────────────────
    section('8. 칩 끄기 (유출 방지)');
    ok('칩의 [×] 를 누른다', await js(`window.__click('.teams-ctx-off')`));
    await sleep(300);
    ok('칩이 사라진다', (await js(`window.__count('.teams-ctx')`)) === 0);
    ok('다시 붙이기 버튼이 대신 뜬다', (await js(`window.__count('.teams-ctx-add')`)) === 1);
    await clearCalls();
    await js(`window.__setValue(document.querySelector('.composer-input'), '문맥 없이 질문')`);
    await sleep(150);
    await js(`window.__enter('.composer-input')`);
    await sleep(700);
    streamCall = (await calls()).find((c) => c.name === 'chat.stream');
    ok('전송된다', !!streamCall);
    ok(
      '봉투가 붙지 않는다',
      streamCall && !String(streamCall.args.input).includes('<xgen_teams_context>'),
      streamCall && String(streamCall.args.input).slice(0, 160),
    );
    ok(
      '방 대화가 새지 않는다',
      streamCall && !String(streamCall.args.input).includes('결제 모듈 타임아웃'),
    );
    await snap('09-chip-off.png');

    // ── 9. 산출물 공유 — 출처 표식이 실리는가 ─────────────────────
    section('9. Agent 답변 → Teams 공유');
    await clearCalls();
    ok(
      '답변의 [Teams로 공유] 를 누른다',
      await js(`window.__click('.msg-actions button', 'Teams로 공유')`),
    );
    await sleep(600);
    ok('공유 모달이 열린다', (await js(`window.__count('.modal.teams-share')`)) === 1);
    const preview = await js(`window.__text('.teams-share-preview')`);
    ok('방에 올라갈 내용을 미리 보여 준다', /커넥션 풀/.test(preview || ''), preview);
    ok('미리보기에 출처 문장이 있다', /에이전트 답변 공유/.test(preview || ''));
    ok(
      '대상 방을 고른다',
      await js(`window.__click('.modal.teams-share .agent-item', '3팀 개발방')`),
    );
    await sleep(300);
    await snap('10-share-modal.png');
    ok(
      '[공유] 를 누른다',
      await js(`window.__click('.modal.teams-share .modal-actions button', '공유')`),
    );
    await sleep(900);
    const shareCall = (await calls()).find((c) => c.name === 'teams.send');
    ok('teams.send 로 방에 나간다', !!shareCall, await calls());
    const shared = shareCall ? String(shareCall.args.content) : '';
    ok(
      '첫 줄에 기계용 출처 태그가 있다',
      /^[^\n]*⟨xgen:[^⟩]+⟩/.test(shared),
      shared.split('\n')[0],
    );
    ok(
      '출처 태그에 원본 대화 좌표가 실렸다',
      /w=wf1/.test(shared) && /i=/.test(shared),
      shared.split('\n')[0],
    );
    ok(
      '사람이 읽을 출처 문장도 함께 있다',
      /사내문서 QA/.test(shared) && /에이전트 답변 공유/.test(shared),
    );
    ok('본문이 그대로 실렸다', /커넥션 풀 고갈/.test(shared), shared);
    ok('공유 후 모달이 닫힌다', (await js(`window.__count('.modal.teams-share')`)) === 0);

    // ── 10. 방에서 공유 메시지가 카드로 그려지는가 ────────────────
    section('10. 방에서 본 공유 메시지');
    ok('Teams 탭으로 돌아간다', await js(`window.__click('.tab-item', '3팀 개발방')`));
    await sleep(900);
    const roomLog = await js(`window.__text('.chat-log')`);
    ok(
      '공유 출처 카드가 그려진다',
      (await js(`window.__count('.teams-share-card')`)) >= 1,
      roomLog,
    );
    ok(
      '카드에 에이전트 이름이 있다',
      /사내문서 QA/.test((await js(`window.__text('.teams-share-card')`)) || ''),
    );
    ok(
      '[원본 대화 보기] 가 있다',
      /원본 대화 보기/.test((await js(`window.__text('.teams-share-card')`)) || ''),
    );
    ok('기계용 태그는 화면에 노출되지 않는다', !/⟨xgen:/.test(roomLog || ''), roomLog);
    await snap('11-shared-in-room.png');

    // ── 11. [원본 대화 보기] 로 돌아가는가 ────────────────────────
    section('11. 원본 대화로 점프');
    ok(
      '[원본 대화 보기] 를 누른다',
      await js(`window.__click('.teams-share-card .link', '원본 대화 보기')`),
    );
    await sleep(900);
    ok(
      '에이전트 대화 탭이 활성화된다',
      /사내문서 QA/.test((await js(`window.__text('.tab-item.active')`)) || ''),
      await js(`window.__text('.tab-item.active')`),
    );
    await snap('12-jumped-back.png');

    // ── 11b. 방 종료 동작은 나가기 하나뿐이다 ────────────────────
    section('11b. 대화방 나가기');
    await clearCalls();
    ok('Teams 뷰로 전환', await js(`window.__click('.ab-btn', 'Teams')`));
    await sleep(300);
    ok(
      '목록 행에서 설정 메뉴를 연다',
      await js(`window.__click('.teams-room-menu-trigger', '대화방 설정')`),
    );
    await sleep(200);
    ok('별도 삭제 메뉴가 없다', !/삭제/.test((await js(`window.__text('.teams-menu')`)) || ''));
    ok('[대화방 나가기]를 누른다', await js(`window.__click('.teams-menu button', '나가기')`));
    await sleep(350);
    const leaveCall = (await calls()).find((call) => call.name === 'teams.leaveRoom');
    ok('teams.leaveRoom 하나로 처리된다', leaveCall && leaveCall.args.roomId === 'room-1');
    ok(
      '나간 방은 목록에서 즉시 사라진다',
      !/3팀 개발방/.test((await js(`window.__text('.agent-list')`)) || ''),
    );

    // ── 12. 렌더러 오류 없음 ──────────────────────────────────────
    section('12. 렌더러 오류');
    ok('콘솔에 오류가 없다', pageErrors.length === 0, pageErrors.slice(0, 5));

    console.log(`\n${'═'.repeat(64)}`);
    console.log(`검증 ${checks}건 중 ${checks - failures}건 통과, ${failures}건 실패`);
    console.log(`스크린샷: ${OUT}`);
    console.log('═'.repeat(64));
    app.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('smoke 실패:', e);
    app.exit(1);
  });
