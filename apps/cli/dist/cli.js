#!/usr/bin/env node
import {
  DANGEROUS_COMMAND_PROMPT,
  DexEngine,
  DexError,
  FileConfigStore,
  SystemCredentialStore,
  bindHost,
  credentialBackend,
  dataDirectory,
  openerInvocation,
  publicError
} from "./chunks/chunk-GS2Q7ZZA.js";

// src/cli.ts
import { stdin as stdin3, stdout as stdout2, stderr as stderr2 } from "node:process";

// src/args.ts
var BOOLEAN_OPTIONS = /* @__PURE__ */ new Set([
  "allow-dangerous",
  "help",
  "include-harness",
  "json",
  "jsonl",
  "no-allow-dangerous",
  "password-stdin",
  "stdin",
  "stdio",
  "version"
]);
function parseArgs(argv) {
  const positionals = [];
  const options = /* @__PURE__ */ new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h") {
      options.set("help", true);
      continue;
    }
    if (argument === "-v") {
      options.set("version", true);
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equal = argument.indexOf("=");
    const name = argument.slice(2, equal >= 0 ? equal : void 0);
    if (!name) throw new DexError("usage_error", `\uC798\uBABB\uB41C option\uC785\uB2C8\uB2E4: ${argument}`);
    if (equal >= 0) {
      options.set(name, argument.slice(equal + 1));
      continue;
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new DexError("usage_error", `--${name} \uAC12\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.`);
    }
    options.set(name, value);
    index += 1;
  }
  return { positionals, options };
}
function option(args, name) {
  const value = args.options.get(name);
  return typeof value === "string" ? value : void 0;
}
function requiredOption(args, name) {
  const value = option(args, name);
  if (!value) throw new DexError("usage_error", `--${name} \uAC12\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.`);
  return value;
}
function flag(args, name) {
  return args.options.get(name) === true;
}
function positiveIntegerOption(args, name) {
  const raw = option(args, name);
  if (raw === void 0) return void 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new DexError("usage_error", `--${name}\uC740 \uC591\uC758 \uC815\uC218\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
  }
  return value;
}

// src/io.ts
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";
async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}
async function promptLine(label) {
  const readline = createInterface({ input: stdin, output: stderr });
  try {
    return await readline.question(label);
  } finally {
    readline.close();
  }
}
async function promptSecret(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readStdin();
  stderr.write(label);
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk) => {
      const text = chunk.toString();
      for (const character of text) {
        if (character === "") {
          cleanup();
          reject(Object.assign(new Error("\uC785\uB825\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4."), { name: "AbortError" }));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\x7F" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// src/mode.ts
function isInteractiveTerminal(input) {
  const ci = input.ci?.trim().toLowerCase();
  const isCi = !!ci && ci !== "false" && ci !== "0";
  return input.stdinIsTty && input.stdoutIsTty && input.term !== "dumb" && !isCi;
}
function shouldLaunchTui(positionals, terminal) {
  if (!isInteractiveTerminal(terminal)) return false;
  return positionals.length === 0 || positionals.length === 1 && positionals[0] === "ui";
}

// ../../packages/rpc/src/server.ts
import { createInterface as createInterface2 } from "node:readline";
import { randomUUID } from "node:crypto";

// ../../packages/rpc/src/wire.ts
var DEX_PROTOCOL_VERSION = 1;

// ../../packages/rpc/src/server.ts
var RpcFailure = class extends Error {
  constructor(rpcCode, message, data) {
    super(message);
    this.rpcCode = rpcCode;
    this.data = data;
  }
};
function objectParams(params) {
  if (params === void 0) return {};
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new RpcFailure(-32602, "params must be an object");
  }
  return params;
}
function requiredString(params, key) {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new RpcFailure(-32602, `${key} is required`);
  return value;
}
function optionalString(params, key) {
  const value = params[key];
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") throw new RpcFailure(-32602, `${key} must be a string`);
  return value;
}
function optionalInteger(params, key) {
  const value = params[key];
  if (value === void 0 || value === null) return void 0;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new RpcFailure(-32602, `${key} must be a positive integer`);
  }
  return Number(value);
}
function optionalBoolean(params, key) {
  const value = params[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "boolean") throw new RpcFailure(-32602, `${key} must be a boolean`);
  return value;
}
function optionalStringArray(params, key) {
  const value = params[key];
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RpcFailure(-32602, `${key} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}
function isRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value;
  return request.jsonrpc === "2.0" && typeof request.method === "string";
}
var DexRpcServer = class {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}
`));
    this.version = options.version ?? "0.1.0";
    this.removeLocalToolsListener = engine.onLocalToolsStatus((status) => {
      if (this.initialized && !this.closed) this.notify("localTools/status", status);
    });
  }
  input;
  output;
  log;
  version;
  activeChats = /* @__PURE__ */ new Map();
  readline = null;
  initialized = false;
  closed = false;
  removeLocalToolsListener;
  start() {
    if (this.readline) return;
    this.readline = createInterface2({ input: this.input, crlfDelay: Infinity });
    this.readline.on("line", (line) => void this.onLine(line));
    this.readline.on("close", () => this.close());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeChats.values()) controller.abort();
    this.activeChats.clear();
    this.engine.stopLocalTools();
    this.removeLocalToolsListener();
    if (this.readline) {
      const readline = this.readline;
      this.readline = null;
      readline.close();
    }
    this.input.pause();
  }
  async onLine(line) {
    if (!line.trim() || this.closed) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      this.writeError(null, -32700, "Parse error");
      return;
    }
    if (!isRequest(value)) {
      this.writeError(null, -32600, "Invalid Request");
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(value, "id");
    try {
      if (!this.initialized && value.method !== "initialize" && value.method !== "exit") {
        throw new RpcFailure(-32002, "initialize must be called first");
      }
      const result = await this.dispatch(value.method, value.params);
      if (hasId) this.write({ jsonrpc: "2.0", id: value.id ?? null, result });
      if (value.method === "shutdown" || value.method === "exit") setImmediate(() => this.close());
    } catch (error) {
      if (!hasId) {
        this.log(`notification ${value.method} failed: ${publicError(error).message}`);
        return;
      }
      if (error instanceof RpcFailure) {
        this.writeError(value.id ?? null, error.rpcCode, error.message, error.data);
        return;
      }
      const exposed = publicError(error);
      this.writeError(value.id ?? null, -32e3, exposed.message, exposed);
    }
  }
  async dispatch(method, rawParams) {
    const params = objectParams(rawParams);
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        if (requested !== DEX_PROTOCOL_VERSION) {
          throw new DexError(
            "protocol_mismatch",
            `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 protocolVersion\uC785\uB2C8\uB2E4: ${String(requested)}`,
            { supported: DEX_PROTOCOL_VERSION }
          );
        }
        this.initialized = true;
        setImmediate(() => {
          void this.engine.startLocalTools().catch(
            (error) => this.log(`local tools: ${publicError(error).message}`)
          );
        });
        return {
          protocolVersion: DEX_PROTOCOL_VERSION,
          server: { name: "dex-cli", version: this.version },
          capabilities: {
            profiles: true,
            authentication: ["password"],
            agents: true,
            chatStreaming: true,
            chatCancellation: true,
            history: true,
            localTools: true,
            ssh: true
          }
        };
      }
      case "shutdown":
      case "exit":
        this.engine.stopLocalTools();
        return null;
      case "health":
        return { ok: true, activeChats: this.activeChats.size };
      case "profile/list":
        return this.engine.listProfiles();
      case "profile/set":
        return this.engine.setProfile(requiredString(params, "name"), requiredString(params, "serverUrl"));
      case "profile/use": {
        const profile = await this.engine.useProfile(requiredString(params, "name"));
        void this.engine.startLocalTools(profile.name).catch((error) => this.log(`local tools: ${publicError(error).message}`));
        return profile;
      }
      case "auth/login": {
        const auth = await this.engine.login(
          requiredString(params, "email"),
          requiredString(params, "password"),
          optionalString(params, "profile")
        );
        void this.engine.startLocalTools(auth.profile).catch((error) => this.log(`local tools: ${publicError(error).message}`));
        return auth;
      }
      case "auth/status":
        return this.engine.authStatus(optionalString(params, "profile"));
      case "auth/logout":
        await this.engine.logout(optionalString(params, "profile"));
        return { ok: true };
      // ── SSH ──
      // 프로토콜에는 Teams · 음성 · 알림도 있지만 RPC 로 열지 않는다. CLI 와
      // 편집기에서 쓸 일이 아직 없고, 열어 두면 "되는 줄 알고" 부르는 경로가
      // 생긴다. 타입은 @dex/protocol 에 그대로 있으므로 여는 것은 한 줄이다.
      case "ssh/config":
        return this.engine.sshConfig(optionalString(params, "profile"));
      case "ssh/setEnabled":
        return this.engine.setSshEnabled(
          params.enabled === true,
          optionalString(params, "profile")
        );
      case "ssh/createServer":
        return this.engine.createSshServer(
          objectParams(params.server),
          optionalString(params, "profile")
        );
      case "ssh/updateServer":
        return this.engine.updateSshServer(
          requiredString(params, "name"),
          objectParams(params.server),
          optionalString(params, "profile")
        );
      case "ssh/deleteServer":
        return this.engine.deleteSshServer(
          requiredString(params, "name"),
          optionalString(params, "profile")
        );
      case "ssh/testServer":
        return this.engine.testSshServer(
          requiredString(params, "name"),
          optionalString(params, "profile")
        );
      case "localTools/status":
        return this.engine.localToolsStatus();
      case "localTools/list":
        return (await this.engine.localToolsStatus()).tools;
      case "localTools/configure": {
        const patch = {};
        const enabled = optionalBoolean(params, "enabled");
        const cwd = optionalString(params, "cwd");
        const timeoutMs = optionalInteger(params, "timeoutMs");
        const allowedRoots = optionalStringArray(params, "allowedRoots");
        const blockedCommands = optionalStringArray(params, "blockedCommands");
        const allowDangerous = optionalBoolean(params, "allowDangerous");
        if (enabled !== void 0) patch.enabled = enabled;
        if (cwd !== void 0) patch.cwd = cwd;
        if (timeoutMs !== void 0) patch.timeoutMs = timeoutMs;
        if (allowedRoots !== void 0) patch.allowedRoots = allowedRoots;
        if (blockedCommands !== void 0) patch.blockedCommands = blockedCommands;
        if (allowDangerous !== void 0) patch.allowDangerous = allowDangerous;
        const status = await this.engine.configureLocalTools(patch);
        if (status.config.enabled) {
          void this.engine.startLocalTools(optionalString(params, "profile")).catch(
            (error) => this.log(`local tools: ${publicError(error).message}`)
          );
        }
        return status;
      }
      case "localTools/run":
        return this.engine.runLocalTool(requiredString(params, "tool"), params.args ?? {});
      case "localTools/start":
        return this.engine.startLocalTools(optionalString(params, "profile"), optionalInteger(params, "waitMs") ?? 0);
      case "localTools/stop":
        this.engine.stopLocalTools();
        return this.engine.localToolsStatus();
      case "agents/list": {
        const owner = optionalString(params, "owner");
        if (owner && owner !== "personal" && owner !== "shared") {
          throw new RpcFailure(-32602, "owner must be personal or shared");
        }
        const query = {
          page: optionalInteger(params, "page"),
          pageSize: optionalInteger(params, "pageSize"),
          search: optionalString(params, "search"),
          status: optionalString(params, "status"),
          owner,
          includeHarness: params.includeHarness === true
        };
        return this.engine.listAgents(query, optionalString(params, "profile"));
      }
      case "history/conversations":
        return this.engine.listConversations(optionalString(params, "profile"));
      case "history/turns":
        return this.engine.historyTurns(
          requiredString(params, "workflowId"),
          requiredString(params, "interactionId"),
          optionalString(params, "workflowName"),
          optionalString(params, "profile")
        );
      case "chat/start":
        return this.startChat(params);
      case "chat/cancel": {
        const streamId = requiredString(params, "streamId");
        const controller = this.activeChats.get(streamId);
        if (!controller) return { cancelled: false };
        controller.abort();
        return { cancelled: true };
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${method}`);
    }
  }
  async startChat(params) {
    const rawInput = params.input;
    if (typeof rawInput !== "string" && !Array.isArray(rawInput) && (!rawInput || typeof rawInput !== "object")) {
      throw new RpcFailure(-32602, "input must be a string, object, or array");
    }
    const input = {
      profile: optionalString(params, "profile"),
      workflowId: requiredString(params, "workflowId"),
      workflowName: optionalString(params, "workflowName"),
      interactionId: optionalString(params, "interactionId"),
      input: rawInput
    };
    const resolved = await this.engine.resolveChatInput(input);
    const streamId = optionalString(params, "streamId") ?? randomUUID();
    if (this.activeChats.has(streamId)) throw new RpcFailure(-32602, `streamId already exists: ${streamId}`);
    const controller = new AbortController();
    this.activeChats.set(streamId, controller);
    setImmediate(() => void this.runChat(streamId, resolved, controller));
    return {
      streamId,
      interactionId: resolved.interactionId,
      workflowId: resolved.workflowId,
      workflowName: resolved.workflowName
    };
  }
  async runChat(streamId, input, controller) {
    try {
      for await (const event of this.engine.chat(input, controller.signal)) {
        this.notify("chat/event", { streamId, event });
      }
      this.notify("chat/complete", { streamId, interactionId: input.interactionId });
    } catch (error) {
      const exposed = publicError(error);
      this.notify("chat/error", { streamId, error: exposed });
    } finally {
      this.activeChats.delete(streamId);
    }
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  writeError(id, code, message, data) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...data === void 0 ? {} : { data } }
    });
  }
  write(value) {
    if (this.closed) return;
    this.output.write(`${JSON.stringify(value)}
`);
  }
};

// src/dex-host.ts
import { spawn } from "node:child_process";
import { createInterface as createInterface3 } from "node:readline";
import { platform } from "node:os";
import { stdin as stdin2, stdout } from "node:process";
function run(file, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve({ ok: false, out: "" });
      return;
    }
    let out = "";
    child.stdout?.on("data", (c) => out += c.toString("utf8"));
    child.on("error", () => resolve({ ok: false, out: "" }));
    child.on("close", (code) => resolve({ ok: code === 0, out }));
    if (input !== void 0) child.stdin?.end(input);
    else child.stdin?.end();
  });
}
function clipboardCommands() {
  const os = platform();
  if (os === "darwin") return { read: ["pbpaste", []], write: ["pbcopy", []] };
  if (os === "win32") {
    return {
      read: ["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]],
      write: ["clip", []]
    };
  }
  return { read: ["xclip", ["-selection", "clipboard", "-o"]], write: ["xclip", ["-selection", "clipboard"]] };
}
async function confirmDangerous(command) {
  if (!stdin2.isTTY || !stdout.isTTY) return "deny";
  const rl = createInterface3({ input: stdin2, output: stdout });
  try {
    stdout.write(`
${DANGEROUS_COMMAND_PROMPT.title}
${DANGEROUS_COMMAND_PROMPT.message}
`);
    stdout.write(`  ${DANGEROUS_COMMAND_PROMPT.detail(command)}
`);
    const answer = await new Promise(
      (resolve) => rl.question("\uD5C8\uC6A9\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C? [n=\uAC70\uBD80 / y=\uC774\uBC88\uB9CC / a=\uC774 \uC138\uC158 \uB3D9\uC548] ", resolve)
    );
    const a = answer.trim().toLowerCase();
    return a === "a" ? "session" : a === "y" ? "once" : "deny";
  } finally {
    rl.close();
  }
}
var clip = clipboardCommands();
var terminalInteraction = {
  confirmDangerous,
  clipboard: clip ? {
    async read() {
      const r = await run(clip.read[0], clip.read[1]);
      if (!r.ok) throw new Error(`\uD074\uB9BD\uBCF4\uB4DC\uB97C \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${clip.read[0]} \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4).`);
      return r.out;
    },
    async write(text) {
      const r = await run(clip.write[0], clip.write[1], text);
      if (!r.ok) throw new Error(`\uD074\uB9BD\uBCF4\uB4DC\uC5D0 \uC4F0\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${clip.write[0]} \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4).`);
    }
  } : void 0,
  /**
   * 터미널에는 알림 센터가 없다. OS 도우미가 있으면 그것으로, 없으면 **표준
   * 오류에 한 줄** 쓴다 — 사용자가 보고 있는 곳이 거기다. 조용히 성공한 척하지
   * 않는 것이 규칙이지만, 여기서는 실제로 사람에게 닿는다.
   */
  async notify(title, body) {
    const os = platform();
    if (os === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      const r = await run("osascript", ["-e", script]);
      if (r.ok) return true;
    } else if (os === "linux") {
      const r = await run("notify-send", [title, body]);
      if (r.ok) return true;
    }
    process.stderr.write(`
[\uC54C\uB9BC] ${title}${body ? `: ${body}` : ""}
`);
    return true;
  },
  async openExternal(url) {
    const { file, args } = openerInvocation(url);
    const r = await run(file, args);
    if (!r.ok) throw new Error(`\uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${file} \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4).`);
  },
  async openPath(absolutePath) {
    const { file, args } = openerInvocation(absolutePath);
    const r = await run(file, args);
    return r.ok ? "" : `\uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${file} \uAC00 \uD544\uC694\uD569\uB2C8\uB2E4).`;
  }
};
function bindCliHost(configStore) {
  let cached = null;
  void configStore.read().then((c) => cached = c).catch(() => void 0);
  const ports = {
    secrets: {
      get: (name) => credentials.getRaw(name),
      set: (name, value) => credentials.setRaw(name, value)
    },
    config: {
      load: () => cached ?? {},
      save: (patch) => {
        const next = { ...cached ?? {}, ...patch };
        cached = next;
        void configStore.write(next).catch(() => void 0);
        return next;
      }
    },
    paths: { dataRoot: () => dataDirectory() },
    interaction: terminalInteraction
  };
  bindHost(ports);
}
var credentials = new SystemCredentialStore();

// src/cli.ts
var VERSION = true ? "1.2.1" : "dev";
var HELP = `XGEN Dex CLI ${VERSION}

Usage:
  dex                     \uB300\uD654\uD615 \uD130\uBBF8\uB110 UI
  dex ui                  \uB300\uD654\uD615 \uD130\uBBF8\uB110 UI
  dex profile set [name] --server <url>
  dex profile use <name>
  dex profile list [--json]
  dex login --email <email> [--profile <name>] [--password-stdin]
  dex status [--profile <name>] [--json]
  dex logout [--profile <name>]
  dex agents list [--search <text>] [--owner personal|shared] [--json]
  dex chat --agent <workflow-id> [--name <workflow-name>] [--interaction <id>] [--jsonl]
  dex history list [--json]
  dex history turns --workflow <id> --interaction <id> [--json]
  dex tools list [--json]
  dex tools status [--profile <name>] [--json]
  dex tools enable [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--allow-dangerous]
  dex tools configure [--cwd <path>] [--allow <path,...>] [--block <command,...>] [--timeout <ms>]
                      [--allow-dangerous|--no-allow-dangerous]
  dex tools disable
  dex tools run <Shell|ShellJob|ReadFile|WriteFile|ListDir|Search|Open|Clipboard|Notify> [--args <json>] [--json]
  dex ssh list [--json]
  dex ssh enable | dex ssh disable
  dex ssh test <name> [--json]
  dex tools serve [--profile <name>]   \uB85C\uCEEC \uB3C4\uAD6C \uBE0C\uB9AC\uC9C0\uB9CC \uACC4\uC18D \uC2E4\uD589
  dex tool ...                         dex tools ...\uC758 \uB2E8\uC218\uD615 \uBCC4\uCE6D
  dex serve --stdio

Global options:
  --profile <name>  \uC0AC\uC6A9\uD560 \uC11C\uBC84 \uD504\uB85C\uD544
  --json            \uB2E8\uC77C JSON \uACB0\uACFC
  --jsonl           \uCC44\uD305 \uC774\uBCA4\uD2B8\uB97C NDJSON\uC73C\uB85C \uCD9C\uB825
  -h, --help        \uB3C4\uC6C0\uB9D0
  -v, --version     \uBC84\uC804

Examples:
  dex profile set corp --server https://xgen.example.com
  dex login --email me@corp.com
  dex agents list
  dex tools enable --cwd . --allow . --block sudo
  echo '\uC774 \uC800\uC7A5\uC18C\uB97C \uC124\uBA85\uD574\uC918' | dex chat --agent wf_abc
`;
function writeJson(value) {
  stdout2.write(`${JSON.stringify(value, null, 2)}
`);
}
function cell(value, width) {
  const text = String(value ?? "");
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text.padEnd(width);
}
function printAgents(agents) {
  if (agents.length === 0) {
    stdout2.write("Agent\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  stdout2.write(`${cell("WORKFLOW ID", 28)}  ${cell("NAME", 30)}  OWNER
`);
  for (const agent of agents) {
    stdout2.write(
      `${cell(agent.workflowId, 28)}  ${cell(agent.workflowName, 30)}  ${agent.isShared ? "shared" : "personal"}
`
    );
  }
}
function printConversations(items) {
  if (items.length === 0) {
    stdout2.write("\uB300\uD654 \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  stdout2.write(`${cell("INTERACTION ID", 38)}  ${cell("AGENT", 28)}  UPDATED
`);
  for (const item of items) {
    stdout2.write(`${cell(item.interactionId, 38)}  ${cell(item.workflowName, 28)}  ${item.updatedAt}
`);
  }
}
function printTurns(items) {
  for (const item of items) {
    stdout2.write(`
[You]
${item.input}

[${item.workflowName}]
${item.output}
`);
  }
  if (items.length === 0) stdout2.write("\uB300\uD654 turn\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
}
function describeEvent(event) {
  if (event.kind === "status") return `${event.surface}: ${event.detail ?? event.reason ?? "\uC0C1\uD0DC \uBCC0\uACBD"}`;
  if (event.kind === "tool") return `tool: ${event.event.toolName ?? event.event.eventType}`;
  if (event.kind === "node_status") return `node: ${event.event.nodeId} ${event.event.status}`;
  if (event.kind === "quota") return `quota: ${event.level}`;
  if (event.kind === "error") return `error: ${event.detail}`;
  return null;
}
function printLocalToolsStatus(status) {
  stdout2.write(`\uB85C\uCEEC \uB3C4\uAD6C: ${status.config.enabled ? "\uCF1C\uC9D0" : "\uAEBC\uC9D0"}
`);
  stdout2.write(`\uC791\uC5C5 \uD3F4\uB354: ${status.config.cwd || "(\uBBF8\uC124\uC815)"}
`);
  stdout2.write(`\uD5C8\uC6A9 \uACBD\uB85C: ${status.config.allowedRoots.join(", ") || "(\uC791\uC5C5 \uD3F4\uB354)"}
`);
  stdout2.write(`\uC704\uD5D8 \uBA85\uB839: ${status.config.allowDangerous ? "\uD5C8\uC6A9" : "\uCC28\uB2E8"}
`);
  stdout2.write(
    `\uBE0C\uB9AC\uC9C0: ${status.bridge.catalogSynced ? `\uC5F0\uACB0\uB428 (\uB3C4\uAD6C ${status.bridge.serverToolCount}\uAC1C)` : status.bridge.connected ? "\uCE74\uD0C8\uB85C\uADF8 \uB3D9\uAE30\uD654 \uC911" : status.bridge.enabled ? "\uC5F0\uACB0 \uB300\uAE30 \uC911" : "\uC911\uC9C0\uB428"}
`
  );
  if (status.bridge.error) stdout2.write(`\uC624\uB958: ${status.bridge.error}
`);
}
function csvOption(args, name) {
  const value = option(args, name);
  if (value === void 0) return void 0;
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}
function jsonObjectOption(args, name) {
  const value = option(args, name);
  if (!value) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DexError("usage_error", `--${name}\uC740 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DexError("usage_error", `--${name}\uC740 JSON \uAC1D\uCCB4\uC5EC\uC57C \uD569\uB2C8\uB2E4.`);
  }
  return parsed;
}
async function waitForStopSignal() {
  await new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
function exitCode(error) {
  if (!(error instanceof DexError)) return 1;
  if (error.code === "usage_error" || error.code === "config_invalid") return 2;
  if (error.code === "auth_required" || error.code === "auth_invalid") return 3;
  if (error.code === "network_error") return 4;
  return 1;
}
async function runChat(engine, args) {
  const workflowId = requiredOption(args, "agent");
  const input = flag(args, "stdin") || !stdin3.isTTY ? await readStdin() : await promptLine("Message: ");
  if (!input.trim()) throw new DexError("usage_error", "\uBCF4\uB0BC \uBA54\uC2DC\uC9C0\uAC00 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.");
  const resolved = await engine.resolveChatInput({
    profile: option(args, "profile"),
    workflowId,
    workflowName: option(args, "name"),
    interactionId: option(args, "interaction"),
    input
  });
  const jsonl = flag(args, "jsonl");
  if (jsonl) writeJson({ kind: "start", ...resolved, input: void 0 });
  else stderr2.write(`interaction: ${resolved.interactionId}
`);
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    for await (const event of engine.chat(resolved, controller.signal)) {
      if (jsonl) {
        stdout2.write(`${JSON.stringify(event)}
`);
      } else if (event.kind === "text") {
        stdout2.write(event.content);
      } else if (event.kind === "summary") {
        stdout2.write(event.text);
      } else {
        const description = describeEvent(event);
        if (description) stderr2.write(`[${description}]
`);
      }
    }
    if (!jsonl) stdout2.write("\n");
  } finally {
    process.off("SIGINT", onInterrupt);
    engine.stopLocalTools();
  }
}
async function run2() {
  const args = parseArgs(process.argv.slice(2));
  if (flag(args, "version")) {
    stdout2.write(`${VERSION}
`);
    return;
  }
  if (flag(args, "help")) {
    stdout2.write(HELP);
    return;
  }
  const configStore = new FileConfigStore();
  bindCliHost(configStore);
  const engine = new DexEngine(configStore, new SystemCredentialStore());
  const terminal = {
    stdinIsTty: !!stdin3.isTTY,
    stdoutIsTty: !!stdout2.isTTY,
    term: process.env.TERM,
    ci: process.env.CI
  };
  if (shouldLaunchTui(args.positionals, terminal)) {
    const { runTui } = await import("./chunks/tui-PNFWGJTJ.js");
    try {
      await runTui(engine);
    } finally {
      engine.stopLocalTools();
    }
    return;
  }
  if (args.positionals.length === 0) {
    stdout2.write(HELP);
    return;
  }
  if (args.positionals[0] === "ui" && !isInteractiveTerminal(terminal)) {
    throw new DexError("usage_error", "\uD130\uBBF8\uB110 UI\uB294 \uB300\uD654\uD615 TTY\uC5D0\uC11C\uB9CC \uC2E4\uD589\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  }
  const [rawCommand, action] = args.positionals;
  const command = rawCommand === "tool" ? "tools" : rawCommand;
  const asJson = flag(args, "json");
  if (command === "profile" && action === "set") {
    const profile = await engine.setProfile(args.positionals[2] ?? "default", requiredOption(args, "server"));
    if (asJson) writeJson(profile);
    else stdout2.write(`\uD504\uB85C\uD544 \uC800\uC7A5: ${profile.name} \u2192 ${profile.serverUrl}
`);
    return;
  }
  if (command === "profile" && action === "use") {
    const name = args.positionals[2];
    if (!name) throw new DexError("usage_error", "\uC0AC\uC6A9\uD560 \uD504\uB85C\uD544 \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const profile = await engine.useProfile(name);
    if (asJson) writeJson(profile);
    else stdout2.write(`\uD604\uC7AC \uD504\uB85C\uD544: ${profile.name}
`);
    return;
  }
  if (command === "profile" && action === "list") {
    const profiles = await engine.listProfiles();
    if (asJson) writeJson(profiles);
    else if (profiles.length === 0) stdout2.write("\uD504\uB85C\uD544\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    else {
      for (const profile of profiles) {
        stdout2.write(`${profile.current ? "*" : " "} ${profile.name.padEnd(16)} ${profile.serverUrl}
`);
      }
    }
    return;
  }
  if (command === "login") {
    const password = flag(args, "password-stdin") || !stdin3.isTTY ? await readStdin() : await promptSecret("Password: ");
    const status = await engine.login(requiredOption(args, "email"), password, option(args, "profile"));
    if (asJson) writeJson(status);
    else stdout2.write(`\uB85C\uADF8\uC778\uB428: ${status.user?.username ?? "unknown"} (${status.profile})
`);
    return;
  }
  if (command === "status") {
    const status = await engine.authStatus(option(args, "profile"));
    const backend = credentialBackend();
    if (asJson) writeJson({ ...status, credentialBackend: backend });
    else {
      if (status.authenticated) {
        stdout2.write(`\uB85C\uADF8\uC778\uB428: ${status.user?.username ?? "unknown"} @ ${status.serverUrl}
`);
      } else {
        stdout2.write(`\uB85C\uADF8\uC544\uC6C3\uB428: ${status.profile} (${status.reason ?? "unknown"})
`);
      }
      stdout2.write(
        backend === "keychain" ? "\uC790\uACA9\uC99D\uBA85: OS \uD0A4\uCCB4\uC778\n" : "\uC790\uACA9\uC99D\uBA85: \uD30C\uC77C (OS \uD0A4\uCCB4\uC778\uC744 \uC4F8 \uC218 \uC5C6\uC5B4 \uC18C\uC720\uC790 \uC804\uC6A9 \uD30C\uC77C\uC5D0 \uC800\uC7A5\uD569\uB2C8\uB2E4)\n"
      );
    }
    return;
  }
  if (command === "logout") {
    await engine.logout(option(args, "profile"));
    if (asJson) writeJson({ ok: true });
    else stdout2.write("\uB85C\uADF8\uC544\uC6C3\uD588\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  if (command === "tools" && action === "list") {
    const status = await engine.localToolsStatus();
    const exposed = new Set(status.tools.map((t) => t.name));
    if (asJson) writeJson({ enabled: status.config.enabled, catalog: status.catalog, exposed: [...exposed] });
    else {
      if (!status.config.enabled) {
        stdout2.write("\uB85C\uCEEC \uB3C4\uAD6C\uAC00 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4 \u2014 \uC544\uB798\uB294 \uCF30\uC744 \uB54C \uC4F8 \uC218 \uC788\uB294 \uBAA9\uB85D\uC785\uB2C8\uB2E4.\n");
        stdout2.write("\uCF1C\uAE30: dex tools enable\n\n");
      }
      stdout2.write(`${cell("TOOL", 14)}  ${cell("\uB178\uCD9C", 5)}  DESCRIPTION
`);
      for (const tool of status.catalog) {
        const summary = String(tool.description ?? "").split("\n")[0] ?? "";
        stdout2.write(
          `${cell(tool.name, 14)}  ${cell(exposed.has(tool.name) ? "\u25CF" : "\xB7", 5)}  ${summary.slice(0, 96)}
`
        );
      }
    }
    return;
  }
  if (command === "tools" && (action === "enable" || action === "configure")) {
    const current = (await engine.localToolsStatus()).config;
    const cwd = option(args, "cwd") || current.cwd || process.cwd();
    const timeoutRaw = option(args, "timeout");
    const timeoutMs = timeoutRaw === void 0 ? current.timeoutMs : Number(timeoutRaw);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1e3 || timeoutMs > 36e5) {
      throw new DexError("usage_error", "--timeout\uC740 1000~3600000 \uC0AC\uC774\uC758 \uBC00\uB9AC\uCD08\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
    }
    const allowedRoots = csvOption(args, "allow") ?? (current.allowedRoots.length ? current.allowedRoots : [cwd]);
    const blockedCommands = csvOption(args, "block") ?? current.blockedCommands;
    const allowDangerous = flag(args, "allow-dangerous") ? true : flag(args, "no-allow-dangerous") ? false : current.allowDangerous;
    const status = await engine.configureLocalTools({
      enabled: action === "enable" ? true : current.enabled,
      cwd,
      timeoutMs,
      allowedRoots,
      blockedCommands,
      allowDangerous
    });
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    return;
  }
  if (command === "tools" && action === "disable") {
    const status = await engine.configureLocalTools({ enabled: false });
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    return;
  }
  if (command === "tools" && action === "run") {
    const tool = args.positionals[2];
    if (!tool) throw new DexError("usage_error", "\uC2E4\uD589\uD560 \uB85C\uCEEC \uB3C4\uAD6C \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const result = await engine.runLocalTool(tool, jsonObjectOption(args, "args"));
    if (asJson) writeJson(result);
    else for (const content of result.content) stdout2.write(`${content.text}
`);
    if (result.isError) process.exitCode = 1;
    return;
  }
  if (command === "tools" && (action === "status" || action === "serve")) {
    let status = await engine.localToolsStatus();
    if (status.config.enabled) {
      try {
        status = await engine.startLocalTools(option(args, "profile"), action === "serve" ? 5e3 : 2e3);
      } catch (error) {
        if (action === "serve") throw error;
        status = {
          ...status,
          bridge: { ...status.bridge, error: error instanceof Error ? error.message : String(error) }
        };
      }
    }
    if (asJson) writeJson(status);
    else printLocalToolsStatus(status);
    if (action === "serve") {
      if (!status.config.enabled) throw new DexError("local_tools_disabled", "\uBA3C\uC800 dex tools enable\uC744 \uC2E4\uD589\uD558\uC138\uC694.");
      if (!asJson) stderr2.write("\uB85C\uCEEC \uB3C4\uAD6C \uBE0C\uB9AC\uC9C0\uAC00 \uC2E4\uD589 \uC911\uC785\uB2C8\uB2E4. \uC885\uB8CC\uD558\uB824\uBA74 Ctrl+C\uB97C \uB204\uB974\uC138\uC694.\n");
      try {
        await waitForStopSignal();
      } finally {
        engine.stopLocalTools();
      }
    } else {
      engine.stopLocalTools();
    }
    return;
  }
  if (command === "agents" && action === "list") {
    const owner = option(args, "owner");
    if (owner && owner !== "personal" && owner !== "shared") {
      throw new DexError("usage_error", "--owner\uB294 personal \uB610\uB294 shared\uC5EC\uC57C \uD569\uB2C8\uB2E4.");
    }
    const query = {
      page: positiveIntegerOption(args, "page"),
      pageSize: positiveIntegerOption(args, "page-size"),
      search: option(args, "search"),
      owner,
      status: option(args, "status"),
      includeHarness: flag(args, "include-harness")
    };
    const result = await engine.listAgents(query, option(args, "profile"));
    if (asJson) writeJson(result);
    else printAgents(result.items);
    return;
  }
  if (command === "chat") {
    await runChat(engine, args);
    return;
  }
  if (command === "history" && action === "list") {
    const conversations = await engine.listConversations(option(args, "profile"));
    if (asJson) writeJson(conversations);
    else printConversations(conversations);
    return;
  }
  if (command === "history" && action === "turns") {
    const turns = await engine.historyTurns(
      requiredOption(args, "workflow"),
      requiredOption(args, "interaction"),
      option(args, "name"),
      option(args, "profile")
    );
    if (asJson) writeJson(turns);
    else printTurns(turns);
    return;
  }
  if (command === "serve") {
    if (!flag(args, "stdio")) throw new DexError("usage_error", "\uD604\uC7AC\uB294 serve --stdio\uB9CC \uC9C0\uC6D0\uD569\uB2C8\uB2E4.");
    const server = new DexRpcServer(engine, { version: VERSION });
    server.start();
    return;
  }
  if (command === "ssh" && (action === "list" || action === void 0)) {
    const config = await engine.sshConfig(option(args, "profile"));
    if (asJson) writeJson(config);
    else {
      stdout2.write(`SSH \uC5F0\uB3D9: ${config.enabled ? "\uCF1C\uC9D0" : "\uAEBC\uC9D0"}
`);
      if (config.servers.length === 0) stdout2.write("\uB4F1\uB85D\uB41C \uC11C\uBC84\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
      for (const srv of config.servers) {
        const via = srv.jump_via.length ? ` (\uACBD\uC720 ${srv.jump_via.join(" \u2192 ")})` : "";
        const off = srv.enabled ? "" : " [\uC0AC\uC6A9 \uC548 \uD568]";
        stdout2.write(`${cell(srv.name, 18)}  ${srv.username}@${srv.host}:${srv.port}  ${srv.auth}${via}${off}
`);
      }
    }
    return;
  }
  if (command === "ssh" && (action === "enable" || action === "disable")) {
    const config = await engine.setSshEnabled(action === "enable", option(args, "profile"));
    if (asJson) writeJson(config);
    else stdout2.write(`SSH \uC5F0\uB3D9\uC744 ${config.enabled ? "\uCF30\uC2B5\uB2C8\uB2E4" : "\uAED0\uC2B5\uB2C8\uB2E4"}.
`);
    return;
  }
  if (command === "ssh" && action === "test") {
    const name = args.positionals[2];
    if (!name) throw new DexError("usage_error", "\uC11C\uBC84 \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4: dex ssh test <name>");
    const result = await engine.testSshServer(name, option(args, "profile"));
    if (asJson) writeJson(result);
    else {
      stdout2.write(
        result.success ? `\uC811\uC18D \uC131\uACF5 (${Math.round(result.latency_ms ?? 0)}ms)
` : `\uC811\uC18D \uC2E4\uD328 \u2014 ${result.error ?? ""}
`
      );
      if (result.hops && result.hops.length > 1) {
        stdout2.write(`\uACBD\uB85C: ${result.hops.join(" \u2192 ")}
`);
      }
    }
    return;
  }
  throw new DexError("usage_error", `\uC54C \uC218 \uC5C6\uB294 \uBA85\uB839\uC785\uB2C8\uB2E4: ${args.positionals.join(" ")}`);
}
run2().catch((error) => {
  const exposed = publicError(error);
  const machine = process.argv.includes("--json") || process.argv.includes("--jsonl");
  if (machine) stderr2.write(`${JSON.stringify({ error: exposed })}
`);
  else stderr2.write(`dex: ${exposed.message}
`);
  process.exitCode = exitCode(error);
});
//# sourceMappingURL=cli.js.map
