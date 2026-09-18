/**
 * 앱이 **아티팩트 앱을 프레임에 띄울 수 있는가** — 진짜 Chromium 으로 확인한다.
 *
 * 소스 문자열 검사로는 못 잡는 회귀가 여기 있었다(2026-09-18): 렌더러의 CSP 가
 * `frame-src xgenartifact: blob:` 이라, 서버 주소를 그대로 여는 iframe 은 **요청조차
 * 나가지 않고** 막혔다. 화면에는 빈 프레임만 남는다. 서버가 붙이는 frame-ancestors
 * 를 떼도 이 문 앞에서 먼저 막히므로 아무 것도 달라지지 않는다 — 그래서 한 번은
 * 엉뚱한 곳을 고쳤다.
 *
 * 판정은 브라우저가 아니라 **서버가** 한다: 요청이 한 건이라도 닿았으면 프레임이
 * 열린 것이고, 0 건이면 CSP 가 막은 것이다. 이 신호에는 해석의 여지가 없다.
 *
 * 검사는 **실제로 배포되는 CSP**(src/renderer/index.html)로 한다. 그 파일이 곧
 * 계약이므로, 거기서 스킴이 빠지면 여기서 바로 빨개진다.
 *
 *   npm --prefix apps/desktop run verify:artifact-site
 */
const { app, BrowserWindow } = require('electron');
const http = require('http');
const { mkdtempSync, writeFileSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const RENDERER_HTML = join(__dirname, '..', 'src', 'renderer', 'index.html');

/** 배포되는 렌더러 문서에서 CSP 를 그대로 꺼내 온다. */
function shippedCsp() {
  const html = readFileSync(RENDERER_HTML, 'utf8');
  const m = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  if (!m) throw new Error('렌더러 index.html 에서 CSP 를 찾지 못했다');
  return m[1];
}

/** frame-src 에서 네트워크 스킴만 걷어낸 사본 — 고치기 전 상태를 재현한다. */
function withoutNetworkSchemes(csp) {
  return csp.replace(/frame-src([^;"]*)/, (_all, body) =>
    'frame-src' + body.replace(/\s*https:/g, '').replace(/\s*http:/g, ''),
  );
}

function page(csp, appUrl) {
  return `<!doctype html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
</head><body><iframe src="${appUrl}"></iframe></body></html>`;
}

async function framesReach(csp, appUrl, hits) {
  const before = hits.n;
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const dir = mkdtempSync(join(tmpdir(), 'xgen-frame-'));
  const file = join(dir, 'index.html');
  writeFileSync(file, page(csp, appUrl), 'utf8');
  // 하위 프레임이 CSP 로 막히면 부모의 loadFile 까지 reject 된다 — 그것이 곧
  // 우리가 재려는 사실이므로, 여기서 실패로 끝내면 안 된다.
  await win.loadFile(file).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  win.destroy();
  return hits.n > before;
}

// 창을 하나씩 세웠다 지운다 — 기본 동작(창이 다 닫히면 종료)에 맡기면 첫 번째
// 판정만 하고 앱이 끝난다.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const hits = { n: 0 };
  const server = http.createServer((req, res) => {
    hits.n += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><h1>artifact app</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${server.address().port}/api/agentflow/agent-artifacts/wfA/ops/app/`;

  const shipped = shippedCsp();
  const opens = await framesReach(shipped, appUrl, hits);
  const blocked = await framesReach(withoutNetworkSchemes(shipped), appUrl, hits);

  const lines = [
    `배포되는 CSP → 아티팩트 앱 프레임: ${opens ? '열린다' : '막힌다'}`,
    `frame-src 에서 스킴을 뺀 사본 → 프레임: ${blocked ? '열린다' : '막힌다'}`,
  ];
  const ok = opens === true && blocked === false;
  const verdict = ok
    ? 'PASS — 배포되는 CSP 가 앱을 열고, 그 스킴이 사라지면 다시 막힌다'
    : 'FAIL — [아티팩트] 탭이 빈 화면이 된다';
  const report = [...lines, verdict].join('\n');
  if (process.env.XGEN_SMOKE_OUT) writeFileSync(process.env.XGEN_SMOKE_OUT, report + '\n', 'utf8');
  console.log(report);
  server.close();
  setTimeout(() => app.exit(ok ? 0 : 1), 150);
});
