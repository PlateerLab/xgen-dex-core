/**
 * 앱 미리보기를 **진짜 Chromium 으로 찍을 수 있는가** — main/app-preview-shot 을 그대로 쓴다.
 *
 * 숨긴 창의 capturePage 는 플랫폼에 따라 빈 그림을 돌려준 적이 있다. 그래서 단위 시험이 아니라
 * 실제 Electron 에서 본다: 서버처럼 굴 작은 HTTP 서버가 빨간 화면을 내고, 찍은 JPEG 의 가운데가
 * 빨간지 본다. 앱 주소(…/app/) 아래의 상대 경로 자산(CSS)이 함께 그려지는지도 같이 본다.
 *
 *   npm --prefix apps/desktop run verify:app-preview
 */
const { app, nativeImage } = require('electron');
const http = require('http');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>
<body><h1>맛집 지도</h1></body></html>`;
const CSS = 'html,body{margin:0;height:100%;background:#e01010;color:#fff;font:40px sans-serif}';

function serve() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      if (req.url === '/api/agentflow/agent-apps/wf/map/app/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (req.url === '/api/agentflow/agent-apps/wf/map/app/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css' });
        return res.end(CSS);
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port }));
  });
}

app.whenReady().then(async () => {
  const { shootAppPreview, THUMB_WIDTH } = require('../src/main/app-preview-shot.ts');
  const { server, hits, port } = await serve();
  let ok = false;
  try {
    const jpeg = await shootAppPreview(`http://127.0.0.1:${port}/api/agentflow/agent-apps/wf/map/app/`, { settleMs: 500 });
    if (!jpeg || jpeg.byteLength === 0) throw new Error('빈 그림');
    const img = nativeImage.createFromBuffer(Buffer.from(jpeg));
    const { width, height } = img.getSize();
    const bmp = img.getBitmap(); // BGRA
    const at = ((Math.floor(height / 2) * width) + Math.floor(width / 2)) * 4;
    const [b, g, r] = [bmp[at], bmp[at + 1], bmp[at + 2]];
    console.log(`jpeg=${jpeg.byteLength}B size=${width}x${height} center=rgb(${r},${g},${b}) hits=${JSON.stringify(hits)}`);
    if (width !== THUMB_WIDTH) throw new Error(`폭이 ${THUMB_WIDTH} 가 아니다: ${width}`);
    if (!(r > 180 && g < 80 && b < 80)) throw new Error('가운데가 빨갛지 않다 — 화면이 그려지지 않았다');
    if (!hits.includes('/api/agentflow/agent-apps/wf/map/app/style.css')) throw new Error('상대 경로 자산을 받지 않았다');
    ok = true;
  } catch (e) {
    console.error('실패:', e && e.message ? e.message : e);
  } finally {
    server.close();
    app.exit(ok ? 0 : 1);
  }
});
