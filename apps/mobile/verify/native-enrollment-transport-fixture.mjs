import https from "node:https";
import fs from "node:fs";

const [portText, certPath, keyPath] = process.argv.slice(2);
let disconnectedPosts = 0;
let disconnectedTurnPosts = 0;
let disconnectedLifecyclePosts = 0;
const expectedAuthorization = "Bearer fixture-token_123~safe";
const expectedDpopAuthorization = "DPoP fixture.access.token";
const expectedDpop = "fixture.header.signature";
const statusBase = "/api/auth/platform-devices/native/mobile/registration/status/";
const canonicalSession = "00000000-0000-4000-8000-000000000001";
const canonicalReads = new Set([
  "/api/agentflow/me/agent-state",
  "/api/agentflow/me/agent-events?after_sequence=9007199254740991&limit=200",
  "/api/agentflow/me/agent-sessions?limit=100",
  `/api/agentflow/me/agent-sessions?limit=20&before_id=${canonicalSession}`,
  `/api/agentflow/agent-sessions/${canonicalSession}/snapshot`,
  `/api/agentflow/agent-sessions/${canonicalSession}/events?after_sequence=0&limit=1`,
  `/api/agentflow/agent-sessions/${canonicalSession}/messages?after_sequence=9007199254740991&limit=20`,
]);

const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.headers.accept !== "application/json") { response.writeHead(400); response.end("bad headers"); return; }

    if (request.url === "/api/auth/platform-devices/native/mobile/registration/challenge") {
      if (request.method !== "POST" || request.headers.authorization !== expectedAuthorization ||
        request.headers["content-type"] !== "application/json" || body !== '{"case":"headers"}') {
        response.writeHead(400); response.end("bad request"); return;
      }
      response.writeHead(201, { "Set-Cookie": "native-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/api/auth/platform-devices/native/mobile/registration/complete") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      response.writeHead(request.headers.cookie ? 400 : 200, { "Content-Type": "application/json" });
      response.end(request.headers.cookie ? "cookie leaked" : '{"cookie":false}');
      return;
    }
    if (request.url === "/api/me/devices/native/mobile/00000000-0000-0000-0000-000000000001/approval-requests/begin") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      disconnectedPosts += 1;
      request.socket.destroy();
      return;
    }
    if (request.url === "/api/auth/platform-devices/trust-overview") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      response.writeHead(302, { Location: "/escaped" }); response.end("redirect"); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000001") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      response.writeHead(200, { "Transfer-Encoding": "chunked" });
      response.end("x".repeat(65537)); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000002") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(Buffer.from([0xc3, 0x28])); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000003") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end("late"); } }, 5000); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000004") {
      if (request.headers.authorization !== expectedAuthorization) { response.writeHead(400); response.end("bad auth"); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ disconnectedPosts })); return;
    }
    if (request.url === "/api/auth/platform-sessions/native/login-key/begin") {
      if (request.method !== "POST" || request.headers.authorization !== expectedAuthorization || request.headers.dpop !== undefined ||
        request.headers["content-type"] !== "application/json" || body !== '{"case":"session-headers"}') {
        response.writeHead(400); response.end("bad session login"); return;
      }
      response.writeHead(201, { "Set-Cookie": "session-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"session":true}'); return;
    }
    if (request.url === "/api/auth/platform-sessions/native/login-key/complete") {
      if (request.method !== "POST" || request.headers.authorization !== expectedAuthorization || request.headers.dpop !== undefined ||
        body !== '{"case":"disconnect"}') { response.writeHead(400); response.end("bad session login"); return; }
      disconnectedPosts += 1;
      request.socket.destroy(); return;
    }
    if (request.url === "/api/auth/platform-sessions/native/refresh/begin") {
      if (request.method !== "POST" || request.headers.authorization !== undefined || request.headers.dpop !== undefined || request.headers.cookie !== undefined) {
        response.writeHead(400); response.end("credential leaked"); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"cookie":false}'); return;
    }
    if (request.url === "/api/auth/platform-sessions/native/refresh/complete") {
      if (request.method !== "POST" || request.headers.authorization !== undefined || request.headers.dpop !== undefined || body !== '{"case":"delay"}') {
        response.writeHead(400); response.end("bad refresh"); return;
      }
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end("late"); } }, 5000); return;
    }
    if (request.url === "/api/me/platform-sessions/00000000-0000-4000-8000-000000000001") {
      if (request.method !== "DELETE" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== "application/json" ||
        body !== '{"password":"fixture-password"}') { response.writeHead(400); response.end("bad delete"); return; }
      response.writeHead(204); response.end(); return;
    }
    if (request.url === "/api/agentflow/agent-sessions") {
      if (request.method !== "POST" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== "application/json" ||
        request.headers.origin !== undefined || request.headers.cookie !== undefined) {
        response.writeHead(400); response.end("bad lifecycle create headers"); return;
      }
      const parsed = JSON.parse(body);
      if (parsed.workflow_id === "lost") { disconnectedLifecyclePosts += 1; request.socket.destroy(); return; }
      if (parsed.workflow_id === "delayed") {
        setTimeout(() => { if (!response.destroyed) { response.writeHead(201); response.end("late"); } }, 5000); return;
      }
      if (parsed.workflow_id === "large-ack") { response.writeHead(201); response.end("x".repeat(65537)); return; }
      if (parsed.workflow_id === "invalid-ack") { response.writeHead(201); response.end(Buffer.from([0xc3, 0x28])); return; }
      if (parsed.workflow_id === "redirect") { response.writeHead(302, { Location: "/escaped" }); response.end(); return; }
      response.writeHead(201, { "Set-Cookie": "lifecycle-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"created":true}'); return;
    }
    if (request.url === "/api/agentflow/me/agent-state" && request.method === "PUT") {
      if (request.headers.authorization !== expectedDpopAuthorization || request.headers.dpop !== expectedDpop ||
        request.headers["content-type"] !== "application/json" || request.headers.origin !== undefined ||
        request.headers.cookie !== undefined || body !== '{"active_agent_session_id":null,"expected_version":0}') {
        response.writeHead(400); response.end("bad lifecycle focus"); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ focused: true, disconnectedLifecyclePosts })); return;
    }
    if (request.url === `/api/agentflow/agent-sessions/${canonicalSession}/turns`) {
      if (request.method !== "POST" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== "application/json" ||
        request.headers.origin !== undefined || request.headers.cookie !== undefined) {
        response.writeHead(400); response.end("bad turn headers"); return;
      }
      const parsed = JSON.parse(body);
      if (parsed.input_text === "lost") { disconnectedTurnPosts += 1; request.socket.destroy(); return; }
      if (parsed.input_text === "delayed") {
        setTimeout(() => { if (!response.destroyed) { response.writeHead(202); response.end("late"); } }, 5000); return;
      }
      if (parsed.input_text === "large-ack") { response.writeHead(202); response.end("x".repeat(65537)); return; }
      if (parsed.input_text === "invalid-ack") { response.writeHead(202); response.end(Buffer.from([0xc3, 0x28])); return; }
      if (parsed.input_text === "redirect") { response.writeHead(302, { Location: "/escaped" }); response.end(); return; }
      response.writeHead(202, { "Set-Cookie": "turn-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"accepted":true}'); return;
    }
    if (request.url === `/api/agentflow/agent-sessions/${canonicalSession}/stop`) {
      if (request.method !== "POST" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== "application/json" ||
        request.headers.origin !== undefined || request.headers.cookie !== undefined ||
        body !== '{"turn_id":"00000000-0000-4000-8000-000000000002","expected_state_version":2}') {
        response.writeHead(400); response.end("bad stop"); return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ requested: true, disconnectedTurnPosts })); return;
    }
    if (request.url === "/api/agentflow/me/agent-events?after_sequence=7&limit=1") {
      if (request.method !== "GET" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== undefined || body !== "") {
        response.writeHead(400); response.end("bad delayed read"); return;
      }
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end("late"); } }, 5000); return;
    }
    const messagesBase = `/api/agentflow/agent-sessions/${canonicalSession}/messages?after_sequence=`;
    if (request.url === messagesBase + "1&limit=20") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("x".repeat(70000)); return;
    }
    if (request.url === "/api/agentflow/me/agent-events?after_sequence=8&limit=1") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("x".repeat(65537)); return;
    }
    if (request.url === messagesBase + "2&limit=20") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end("x".repeat(1048577)); return;
    }
    if (request.url === messagesBase + "3&limit=20") {
      response.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
      response.write("x".repeat(524288)); response.write("x".repeat(524288)); response.end("x"); return;
    }
    if (request.url === messagesBase + "4&limit=20") {
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(Buffer.from([0xc3, 0x28])); return;
    }
    if (request.url === messagesBase + "5&limit=20") {
      response.writeHead(302, { Location: "/escaped" }); response.end("redirect"); return;
    }
    if (request.url === messagesBase + "6&limit=1") {
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end("late"); } }, 5000); return;
    }
    if (canonicalReads.has(request.url)) {
      if (request.method !== "GET" || request.headers.authorization !== expectedDpopAuthorization ||
        request.headers.dpop !== expectedDpop || request.headers["content-type"] !== undefined ||
        request.headers.cookie !== undefined || body !== "") {
        response.writeHead(400); response.end("bad canonical read"); return;
      }
      response.writeHead(200, { "Set-Cookie": "canonical-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"read":true}'); return;
    }
    response.writeHead(404); response.end("missing");
  });
});

// macOS URLSession resolves localhost to IPv6 on the CI image. Keep the
// test-only listener on loopback rather than exposing the fixture externally.
server.listen(Number(portText), "::1", () => process.stdout.write("ready\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
