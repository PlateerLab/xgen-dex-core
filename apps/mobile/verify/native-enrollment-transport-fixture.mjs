import https from "node:https";
import fs from "node:fs";

const [portText, certPath, keyPath] = process.argv.slice(2);
let disconnectedPosts = 0;
const expectedAuthorization = "Bearer fixture-token_123~safe";
const statusBase = "/api/auth/platform-devices/native/mobile/registration/status/";

const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, (request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const headersValid = request.headers.accept === "application/json" && request.headers.authorization === expectedAuthorization;
    if (!headersValid) { response.writeHead(400); response.end("bad headers"); return; }

    if (request.url === "/api/auth/platform-devices/native/mobile/registration/challenge") {
      if (request.method !== "POST" || request.headers["content-type"] !== "application/json" || body !== '{"case":"headers"}') {
        response.writeHead(400); response.end("bad request"); return;
      }
      response.writeHead(201, { "Set-Cookie": "native-secret=must-not-return", "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/api/auth/platform-devices/native/mobile/registration/complete") {
      response.writeHead(request.headers.cookie ? 400 : 200, { "Content-Type": "application/json" });
      response.end(request.headers.cookie ? "cookie leaked" : '{"cookie":false}');
      return;
    }
    if (request.url === "/api/me/devices/native/mobile/00000000-0000-0000-0000-000000000001/approval-requests/begin") {
      disconnectedPosts += 1;
      request.socket.destroy();
      return;
    }
    if (request.url === "/api/auth/platform-devices/trust-overview") {
      response.writeHead(302, { Location: "/escaped" }); response.end("redirect"); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000001") {
      response.writeHead(200, { "Transfer-Encoding": "chunked" });
      response.end("x".repeat(65537)); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000002") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(Buffer.from([0xc3, 0x28])); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000003") {
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200); response.end("late"); } }, 5000); return;
    }
    if (request.url === statusBase + "00000000-0000-0000-0000-000000000004") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ disconnectedPosts })); return;
    }
    response.writeHead(404); response.end("missing");
  });
});

server.listen(Number(portText), "127.0.0.1", () => process.stdout.write("ready\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
