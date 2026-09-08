/**
 * 아티팩트 격리 프레임 — 실제 Electron 에서 확인한다.
 *
 * 왜 단위 테스트로 안 되나: 확인해야 하는 것이 전부 **브라우저 엔진의 규칙**이다.
 * CSP 가 응답 헤더로 정말 붙는지, 그 아래에서 인라인 스크립트와 eval 이 정말
 * 도는지, 프레임이 정말 오리진 없이 뜨는지 — 어느 것도 jsdom 이나 타입체커가
 * 답해 주지 않는다. 하나라도 틀리면 아티팩트가 아무 말 없이 빈 화면이 되거나,
 * 에이전트가 쓴 코드가 이 앱의 다리(window.xgen)에 닿는다.
 *
 * 확인하는 것:
 *   1. 프레임이 뜨고 아티팩트가 **실제로 렌더된다** (JSX 변환 → React 마운트).
 *   2. 프레임에 **오리진이 없다**(`window.origin === 'null'`).
 *   3. 프레임이 부모 창에 **닿지 못한다**.
 *   4. 프레임에 **네트워크가 없다** (CSP connect-src 'none').
 *   5. `xgen.fetch(alias)` 는 호스트를 거쳐서만 돌아온다.
 *
 * ── 이 테스트가 **증명하지 못하는 것** (실측하고 알게 된 것) ──────────────
 * 3번은 sandbox 속성을 빼도 통과한다. 프레임 문서가 `xgenartifact://` 라 부모와
 * 스킴부터 다르고, 교차 오리진 규칙만으로 이미 막히기 때문이다 — 즉 **다리를
 * 지키는 것은 스킴 분리이지 sandbox 속성이 아니다.**
 *
 * 2번은 더 예민하다: `standard: true` 로 등록하고 **동시에** iframe 에
 * `allow-same-origin` 을 주면 그때만 프레임이 오리진을 되찾는다(그 조합에서만
 * document.cookie 가 열리는 것을 확인했다). 둘 중 하나만 틀리면 2번도 통과한다.
 *
 * 그래서 "allow-same-origin 을 쓰지 않는다"와 "standard 를 켜지 않는다"는
 * **소스 계약 테스트**(test/artifact-isolation.test.ts)가 따로 지킨다. 여기서
 * 잡히지 않는 회귀라는 것을 알기 때문이다.
 *
 * 실행: npm --prefix apps/desktop run verify:artifact
 *   (리눅스에서 SUID 샌드박스가 없으면 `--no-sandbox` 를 함께 준다)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');

const FRAME_HTML = fs.readFileSync(path.join(__dirname, '../src/main/artifact-frame.html'), 'utf8');
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([{ scheme: 'xgenartifact', privileges: { secure: true } }]);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const RUNTIME_DIR = path.join(__dirname, '../src/renderer/src/artifacts/runtime');
const runtimeJs = fs.readFileSync(path.join(RUNTIME_DIR, 'react-runtime.js.txt'), 'utf8');
const babelJs = fs.readFileSync(path.join(RUNTIME_DIR, 'babel.min.js.txt'), 'utf8');

/** 에이전트가 썼다고 치는 아티팩트 — JSX + import + 선언 파일 + 선언 API. */
const ARTIFACT_SOURCE = `
import React, { useEffect, useState } from 'react';
export default function App() {
  const [rows, setRows] = useState('대기');
  const [reach, setReach] = useState('안 해봄');
  useEffect(() => {
    // 선언된 파일은 처음에 함께 온다.
    const cfg = JSON.parse(xgen.file('data/rows.json'));
    // 선언된 API 는 호스트가 대신 부른다.
    xgen.fetch('rows', { limit: cfg.limit }).then((d) => setRows('받음:' + d.total));
    // 부모 창에 닿아 보려는 시도 — 불투명 오리진이면 반드시 실패해야 한다.
    try {
      const stolen = window.parent.xgen;
      setReach(stolen ? '닿았다' : '없음');
    } catch (e) {
      setReach('막힘');
    }
  }, []);
  return (
    <div>
      <h1 id="title">아티팩트가 떴다</h1>
      <p id="rows">{rows}</p>
      <p id="reach">{reach}</p>
    </div>
  );
}
`;

async function main() {
  await app.whenReady();

  protocol.handle('xgenartifact', () =>
    new Response(FRAME_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': FRAME_CSP,
      },
    }),
  );

  // 호스트 창 — 렌더러를 흉내 낸다. window.xgen 이 있다는 것이 핵심이다:
  // 프레임이 여기 닿으면 안 된다.
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  const hostHtml = `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'unsafe-inline'; frame-src xgenartifact:">
    <body>
    <iframe id="f" src="xgenartifact://frame/" sandbox="allow-scripts"
            referrerpolicy="no-referrer" style="width:100%;height:520px;border:0"></iframe>
    <script>
      // 렌더러의 다리를 흉내 낸다 — 진짜 앱에서는 preload 가 심는다.
      window.xgen = { SECRET_BRIDGE: 'this-is-the-node-bridge' };
      window.__log = [];
      const frame = document.getElementById('f');
      window.addEventListener('message', (ev) => {
        if (ev.source !== frame.contentWindow) return;
        const m = ev.data || {};
        window.__log.push(m.type);
        if (m.type === 'artifact:fetch') {
          // 호스트만 실제 호출을 할 수 있다. 여기서는 선언 검사만 흉내 낸다.
          const ok = m.alias === 'rows';
          frame.contentWindow.postMessage(
            ok
              ? { type: 'artifact:fetch-result', id: m.id, ok: true, data: { total: 42 } }
              : { type: 'artifact:fetch-result', id: m.id, ok: false, error: '선언되지 않은 alias' },
            '*',
          );
        }
      });
      window.__frameLoaded = false;
      frame.addEventListener('load', () => { window.__frameLoaded = true; });
      window.__init = (payload) => frame.contentWindow.postMessage(payload, '*');
    </script>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(hostHtml)}`);

  // 프레임이 뜰 때까지 기다렸다가 런타임 + 소스를 건넨다.
  // 부모에서 프레임의 contentDocument 를 들여다볼 수는 없다 — 불투명 오리진이라
  // 접근 자체가 던진다(그게 바로 우리가 원하는 격리다). load 이벤트만 기다린다.
  await win.webContents.executeJavaScript(
    `new Promise((r) => {
       const f = document.getElementById('f');
       if (window.__frameLoaded) return r(true);
       f.addEventListener('load', () => r(true), { once: true });
       setTimeout(() => r(false), 10000);
     })`,
  );
  await new Promise((r) => setTimeout(r, 300));

  await win.webContents.executeJavaScript(
    `window.__init(${JSON.stringify({
      type: 'artifact:init',
      runtimeJs,
      babelJs,
      entry: 'App.jsx',
      source: ARTIFACT_SOURCE,
      files: { 'data/rows.json': JSON.stringify({ limit: 5 }) },
    })}), true`,
  );

  // 렌더 + 왕복을 기다린다.
  const deadline = Date.now() + 20_000;
  let text = '';
  for (;;) {
    const frames = win.webContents.mainFrame.frames;
    const inner = frames[0];
    if (inner) {
      text = await inner
        .executeJavaScript(`document.body.innerText`)
        .catch(() => '');
      if (text.includes('아티팩트가 떴다') && text.includes('받음:42')) break;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const inner = win.webContents.mainFrame.frames[0];
  assert.ok(inner, '아티팩트 프레임이 붙지 않았다');

  // 1) 실제로 렌더됐다 — JSX 변환도 React 마운트도 됐다는 뜻.
  assert.match(text, /아티팩트가 떴다/, `아티팩트가 렌더되지 않았다. 본문: ${JSON.stringify(text)}`);

  // 5) 선언된 alias 는 호스트를 거쳐 돌아왔다.
  assert.match(text, /받음:42/, `xgen.fetch 왕복이 실패했다. 본문: ${JSON.stringify(text)}`);

  // 3) 부모에 닿지 못했다. (스킴이 다르면 sandbox 없이도 막히므로, 이 줄만으로는
  //     sandbox 속성이 살아 있다는 증명이 되지 않는다 — 위 주석 참고.)
  assert.match(
    text,
    /막힘/,
    `프레임이 부모 창에 닿았다 (샌드박스가 풀렸다). 본문: ${JSON.stringify(text)}`,
  );
  assert.ok(
    !text.includes('this-is-the-node-bridge'),
    '프레임이 호스트의 다리를 읽었다 — allow-same-origin 이 새어 들어갔는지 확인하라',
  );

  // 2) 오리진이 없어야 한다. standard:true 와 allow-same-origin 이 **함께**
  //    들어오면 여기서 실패한다 — 그 조합이 쿠키를 여는 유일한 조합이다.
  const origin = await inner.executeJavaScript(`String(window.origin)`);
  assert.equal(origin, 'null', `오리진이 불투명하지 않다: ${origin}`);

  // 4) 네트워크 없음 — CSP connect-src 'none'.
  const fetchResult = await inner.executeJavaScript(
    `fetch('https://example.com').then(() => 'reached').catch((e) => 'blocked:' + e.name)`,
  );
  assert.match(
    String(fetchResult),
    /^blocked:/,
    `프레임에서 네트워크가 열려 있다: ${fetchResult}`,
  );

  // 프레임이 자기 CSP 를 받았는지 — 헤더가 실제로 붙었다는 확인.
  const cspMeta = await inner.executeJavaScript(
    `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
  );
  assert.equal(cspMeta, true, '프레임 문서에 meta CSP 가 없다(이중 잠금이 빠졌다)');

  console.log('아티팩트 격리 프레임 확인 통과 — 렌더 · 격리 · 무네트워크 · alias 왕복');
  win.destroy();
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
