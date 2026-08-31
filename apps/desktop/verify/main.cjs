// Headless (offscreen) screenshot harness for visual verification.
// Loads the built renderer with a mock bridge and captures PNGs of each screen.
const { app, BrowserWindow, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// xgenavatar:// asset proxy stand-in — serve a small colored PNG for every
// request so image thumbnails/pixi textures resolve in the avatar stage.
protocol.registerSchemesAsPrivileged([
  { scheme: 'xgenavatar', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const OUT = process.env.SHOTS_DIR || '/tmp/shots';
const STAGE = process.env.VERIFY_STAGE || 'workspace';
const W = Number(process.env.VERIFY_W) || 1280;
const H = Number(process.env.VERIFY_H) || 820;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snap(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('shot:', name);
}

// Drive a React-controlled input/textarea: set value via the native setter then
// dispatch an 'input' event so React's onChange fires.
const DRIVE = `
function setNativeValue(el, value){
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsBeGMEyjAWRkoEP2Xmevc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0BIpMCd6N+QvsAAAAASUVORK5CYII=',
    'base64',
  );
  protocol.handle('xgenavatar', () => new Response(TINY_PNG, { headers: { 'Content-Type': 'image/png' } }));

  // Overlay stage: capture the floating avatar window on a "desktop" backdrop.
  if (STAGE === 'overlay') {
    const ov = new BrowserWindow({
      width: 320, height: 460, show: false,
      backgroundColor: '#2f3d57', // stand-in wallpaper so the floating avatar is visible
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
    });
    ov.webContents.setFrameRate(30);
    await ov.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'overlay.html'));
    // The full reply bursts at ~150ms; the typewriter throttles it. Two frames
    // show the reveal progressing (proving the burst isn't dumped all at once).
    await sleep(900);
    await snap(ov, 'sub-partial.png');
    await sleep(1600);
    await snap(ov, 'sub-more.png');
    // Unlock → resize frame (dashed outline) + bar (chat/settings/eye/lock/close)
    await ov.webContents.executeJavaScript(`(() => { const b = document.querySelector('.ov-lockchip button'); if (b) b.click(); return !!b; })()`);
    await sleep(400);
    await snap(ov, 'overlay-unlocked.png');
    // "아바타 숨기기" → hide the orb, keep the floating window + speech bubble
    await ov.webContents.executeJavaScript(`(() => { const b = document.querySelector('.ov-bar button[title="아바타 숨기기"]'); if (b) b.click(); return !!b; })()`);
    await sleep(500);
    await snap(ov, 'avatar-hidden.png');
    app.quit();
    return;
  }

  // Quick-chat stage: the Spotlight-style bar (mock auto-summons it).
  if (STAGE === 'quickchat') {
    const qc = new BrowserWindow({
      width: 600, height: 176, show: false,
      backgroundColor: '#2f3d57',
      webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
    });
    qc.webContents.setFrameRate(30);
    await qc.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'quickchat.html'));
    await sleep(700);
    await qc.webContents.executeJavaScript(`(() => { const ta = document.querySelector('.qc-input'); if (ta) { const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; set.call(ta,'제주 관광지 추천해줘'); ta.dispatchEvent(new Event('input',{bubbles:true})); } return !!ta; })()`);
    await sleep(300);
    await snap(qc, 'quickchat.png');
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: {
      offscreen: true,
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.webContents.setFrameRate(30);
  await win.loadFile(path.join(__dirname, '..', 'out', 'renderer', 'index.html'));
  await win.webContents.executeJavaScript(DRIVE + 'true');
  await sleep(1200); // fonts + restore

  if (STAGE === 'avatar') {
    // 아바타 설정 뷰: 사이드바 헤더 버튼 → 설정 탭 → 스토어 탭
    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.sidebar-head-actions .icon-btn')].find((b) => b.title === '아바타 설정');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(1200);
    await snap(win, 'avatar-settings.png');
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.avset-header .seg button')].find((b) => b.textContent.includes('스토어'));
      if (t) t.click();
      return !!t;
    })()`);
    await sleep(1000);
    await snap(win, 'avatar-store.png');
    // 이름 변경 모달
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.avset-header .seg button')].find((b) => b.textContent.includes('설정'));
      if (t) t.click();
      return !!t;
    })()`);
    await sleep(600);
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.avset-item .icon-btn[title="이름 변경"]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(900);
    await snap(win, 'avatar-rename.png');
    app.quit();
    return;
  }

  if (STAGE === 'login') {
    await snap(win, 'login.png');
    app.quit();
    return;
  }

  // workspace lands with an agent auto-selected → empty chat (header alignment + input)
  await snap(win, 'workspace-empty.png');

  // Drive a chat turn
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.composer-input');
    if (ta) { setNativeValue(ta, '안녕하세요!'); }
    return !!ta;
  })()`);
  await sleep(150);
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('.composer-input');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(1900); // let the scripted stream finish
  await snap(win, 'chat.png');

  // Collapse the sidebar
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sidebar-head-actions .icon-btn')].find((b) => b.title.includes('접기'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(400);
  await snap(win, 'collapsed.png');

  // Expand again (toggle in the chat header)
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.chat-title .sidebar-toggle');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(300);

  // History tab
  await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.side-tab')];
    const h = tabs.find((t) => t.textContent.includes('대화 기록'));
    if (h) h.click();
    return !!h;
  })()`);
  await sleep(500);
  await snap(win, 'history.png');

  // Open a past conversation → loads its turns
  await win.webContents.executeJavaScript(`(() => {
    const it = document.querySelector('.conv-item');
    if (it) it.click();
    return !!it;
  })()`);
  await sleep(900);
  await snap(win, 'resumed.png');

  // Settings modal
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sidebar-head-actions .icon-btn')].find((b) => b.title === '설정');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  await snap(win, 'settings.png');

  // Local MCP manager modal
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.field-row')];
    const row = rows.find((r) => (r.textContent||'').includes('로컬 MCP'));
    const btn = row && row.querySelector('button');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  await snap(win, 'mcp.png');

  app.quit();
});
