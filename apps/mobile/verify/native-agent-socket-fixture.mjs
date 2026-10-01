import https from "node:https";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Server: WebSocketServer } = require("../node_modules/react-native/node_modules/ws");
const [portText, certPath, keyPath] = process.argv.slice(2);
const sessionId = "00000000-0000-4000-8000-000000000001";
const prefix = `/api/agentflow/agent-sessions/${sessionId}/events?after_seq=`;
const expectedAuthorization = "DPoP fixture.access.token";
const expectedDpop = "fixture.header.signature";
let active = 0;
let sawHeaders = false;

const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) });
const sockets = new Set();
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
wss.on("headers", (headers) => headers.push("Set-Cookie: socket-secret=must-not-return; Secure; HttpOnly"));

function reject(socket, status, label, headers = "") {
  socket.end(`HTTP/1.1 ${status} ${label}\r\nContent-Length: 0\r\nConnection: close\r\n${headers}\r\n`);
}

server.on("upgrade", (request, socket, head) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  const sequence = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : null;
  if (request.method !== "GET" || sequence === null || request.headers.authorization !== expectedAuthorization ||
      request.headers.dpop !== expectedDpop || request.headers.cookie !== undefined || request.headers.origin !== undefined ||
      request.headers["sec-websocket-protocol"] !== undefined) {
    reject(socket, 400, "Bad Request");
    return;
  }
  sawHeaders = true;
  if (sequence === "3") { reject(socket, 401, "Unauthorized"); return; }
  if (sequence === "16") { reject(socket, 403, "Forbidden"); return; }
  if (sequence === "4") { reject(socket, 409, "Conflict"); return; }
  if (sequence === "5") { reject(socket, 503, "Service Unavailable"); return; }
  if (sequence === "21") { reject(socket, 500, "Internal Server Error"); return; }
  if (sequence === "22") { reject(socket, 408, "Request Timeout"); return; }
  if (sequence === "23") { reject(socket, 429, "Too Many Requests"); return; }
  if (sequence === "6") {
    reject(socket, 302, "Found", `Location: wss://localhost:${portText}/escaped\r\n`);
    return;
  }
  if (sequence === "10") {
    setTimeout(() => { if (!socket.destroyed) reject(socket, 503, "Service Unavailable"); }, 3000);
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.fixtureSequence = sequence;
    wss.emit("connection", webSocket, request);
  });
});

wss.on("connection", (webSocket) => {
  active += 1;
  webSocket.once("close", () => { active -= 1; });
  switch (webSocket.fixtureSequence) {
  case "0": webSocket.send('{"sequence":1}'); break;
  case "1": webSocket.send(Buffer.from("binary"), { binary: true }); break;
  case "2": webSocket.send("x".repeat(1024 * 1024 + 1)); break;
  case "7": webSocket.close(1008); break;
  case "8": webSocket.close(4409); break;
  case "9": webSocket.close(1011); break;
  case "11": break;
  case "12": setTimeout(() => { if (webSocket.readyState === webSocket.OPEN) webSocket.send('{"sequence":12}'); }, 300); break;
  case "13":
    webSocket._socket.pause();
    setTimeout(() => webSocket._socket.resume(), 600);
    break;
  case "14": webSocket.send(Buffer.from([0xc3, 0x28]), { binary: false }); break;
  case "15": webSocket.send("x".repeat(1024 * 1024)); break;
  case "17": setTimeout(() => webSocket._socket.destroy(), 50); break;
  case "18": webSocket.close(1000); break;
  case "19": webSocket.close(4401); break;
  case "20": webSocket.close(4403); break;
  case "24": webSocket.close(4400); break;
  case "25": webSocket.close(1002); break;
  case "26": webSocket.close(1003); break;
  case "27": webSocket.close(1007); break;
  case "28": webSocket.close(1009); break;
  default: webSocket.send('{"unexpected":true}');
  }
});

server.listen(Number(portText), "::1", () => process.stdout.write("ready\n"));

let shuttingDown = false;
process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = Date.now() + 4000;
  while (active !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const failures = [];
  if (!sawHeaders) failures.push("headers/query were not observed");
  if (active !== 0) failures.push(`active sockets remain: ${active}`);
  if (failures.length) {
    process.stderr.write(`${failures.join("; ")}\n`);
    process.exit(1);
  }
  server.close(() => process.exit(0));
  for (const socket of sockets) socket.destroy();
});
