// Verifies the MCP bridge flicker fix (v0.1.14): a flapping backend endpoint
// (opens then immediately closes the socket, as when MR !937 isn't deployed and
// the gateway proxies to a route that 404s) must NOT toggle the UI status
// between 연결됨/연결 대기 중. A stable endpoint must settle to connected and stay.
import { WebSocketServer } from 'ws';

// Load TS sources on the fly.
const { McpBridge } = await import('../src/main/mcp-bridge.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(bridge) {
  const events = [];
  bridge.setStatusListener((s) => events.push({ t: Date.now(), connected: s.connected }));
  return events;
}
// count connected true<->false transitions in an emitted-status sequence
function transitions(events) {
  let last = null;
  let n = 0;
  for (const e of events) {
    if (last !== null && e.connected !== last) n++;
    last = e.connected;
  }
  return n;
}

async function scenario(name, { flap }) {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise((res) => wss.on('listening', () => res(wss.address().port)));
  wss.on('connection', (ws) => {
    ws.on('message', () => {}); // swallow hello/ping
    if (flap) setTimeout(() => { try { ws.close(); } catch {} }, 150); // close well under SETTLE (1.2s)
  });

  const bridge = new McpBridge();
  const events = collect(bridge);
  bridge.start({
    serverUrl: `http://127.0.0.1:${port}`,
    userId: 'u1',
    getToken: async () => 'tok',
  });

  await sleep(9000); // several flap cycles (backoff 5s→9s…) or one stable settle
  const preStop = events.length; // stop() emits a final "disconnected" — not flicker
  bridge.stop();
  await new Promise((r) => wss.close(r));

  const runtime = events.slice(0, preStop);
  const everConnected = runtime.some((e) => e.connected);
  const tr = transitions(runtime);
  console.log(`\n[${name}] emits=${events.length} everConnected=${everConnected} transitions=${tr}`);
  console.log('  seq:', events.map((e) => (e.connected ? 'C' : '·')).join(''));
  return { name, everConnected, transitions: tr, emits: events.length };
}

const flapR = await scenario('flapping-endpoint', { flap: true });
const stableR = await scenario('stable-endpoint', { flap: false });

let ok = true;
// A flapping endpoint must never report "connected" (socket dies before settle),
// so the UI stays steadily on "연결 대기 중" — zero connected<->disconnected churn.
if (flapR.everConnected || flapR.transitions !== 0) {
  console.log('\n❌ FLAP: expected no connected emits / 0 transitions, got', flapR);
  ok = false;
}
// A stable endpoint must settle to connected exactly once and never toggle.
if (!stableR.everConnected || stableR.transitions > 1) {
  console.log('\n❌ STABLE: expected settle-to-connected once, got', stableR);
  ok = false;
}
console.log(ok ? '\n✅ MCP flicker fix verified: no status flapping.' : '\n❌ verification failed');
process.exit(ok ? 0 : 1);
