#!/usr/bin/env node
import {
  DexEngine,
  DexError,
  FileConfigStore,
  KeytarCredentialStore,
  publicError
} from "./chunks/chunk-CTEPQXLL.js";

// src/cli.ts
import { stdin as stdin2, stdout, stderr as stderr2 } from "node:process";

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

// ../../packages/rpc/src/wire.ts
var DEX_PROTOCOL_VERSION = 1;

// ../../packages/rpc/src/server.ts
import { createInterface as createInterface2 } from "node:readline";
import { randomUUID } from "node:crypto";
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
            localTools: true
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

// src/cli.ts
var VERSION = "0.1.0";
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
  dex tools run <Shell|ReadFile|WriteFile|ListDir|Search|Open> [--args <json>] [--json]
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
  stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
function cell(value, width) {
  const text = String(value ?? "");
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text.padEnd(width);
}
function printAgents(agents) {
  if (agents.length === 0) {
    stdout.write("Agent\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  stdout.write(`${cell("WORKFLOW ID", 28)}  ${cell("NAME", 30)}  OWNER
`);
  for (const agent of agents) {
    stdout.write(
      `${cell(agent.workflowId, 28)}  ${cell(agent.workflowName, 30)}  ${agent.isShared ? "shared" : "personal"}
`
    );
  }
}
function printConversations(items) {
  if (items.length === 0) {
    stdout.write("\uB300\uD654 \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  stdout.write(`${cell("INTERACTION ID", 38)}  ${cell("AGENT", 28)}  UPDATED
`);
  for (const item of items) {
    stdout.write(`${cell(item.interactionId, 38)}  ${cell(item.workflowName, 28)}  ${item.updatedAt}
`);
  }
}
function printTurns(items) {
  for (const item of items) {
    stdout.write(`
[You]
${item.input}

[${item.workflowName}]
${item.output}
`);
  }
  if (items.length === 0) stdout.write("\uB300\uD654 turn\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
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
  stdout.write(`\uB85C\uCEEC \uB3C4\uAD6C: ${status.config.enabled ? "\uCF1C\uC9D0" : "\uAEBC\uC9D0"}
`);
  stdout.write(`\uC791\uC5C5 \uD3F4\uB354: ${status.config.cwd || "(\uBBF8\uC124\uC815)"}
`);
  stdout.write(`\uD5C8\uC6A9 \uACBD\uB85C: ${status.config.allowedRoots.join(", ") || "(\uC791\uC5C5 \uD3F4\uB354)"}
`);
  stdout.write(`\uC704\uD5D8 \uBA85\uB839: ${status.config.allowDangerous ? "\uD5C8\uC6A9" : "\uCC28\uB2E8"}
`);
  stdout.write(
    `\uBE0C\uB9AC\uC9C0: ${status.bridge.catalogSynced ? `\uC5F0\uACB0\uB428 (\uB3C4\uAD6C ${status.bridge.serverToolCount}\uAC1C)` : status.bridge.connected ? "\uCE74\uD0C8\uB85C\uADF8 \uB3D9\uAE30\uD654 \uC911" : status.bridge.enabled ? "\uC5F0\uACB0 \uB300\uAE30 \uC911" : "\uC911\uC9C0\uB428"}
`
  );
  if (status.bridge.error) stdout.write(`\uC624\uB958: ${status.bridge.error}
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
  const input = flag(args, "stdin") || !stdin2.isTTY ? await readStdin() : await promptLine("Message: ");
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
        stdout.write(`${JSON.stringify(event)}
`);
      } else if (event.kind === "text") {
        stdout.write(event.content);
      } else if (event.kind === "summary") {
        stdout.write(event.text);
      } else {
        const description = describeEvent(event);
        if (description) stderr2.write(`[${description}]
`);
      }
    }
    if (!jsonl) stdout.write("\n");
  } finally {
    process.off("SIGINT", onInterrupt);
    engine.stopLocalTools();
  }
}
async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (flag(args, "version")) {
    stdout.write(`${VERSION}
`);
    return;
  }
  if (flag(args, "help")) {
    stdout.write(HELP);
    return;
  }
  const engine = new DexEngine(new FileConfigStore(), new KeytarCredentialStore());
  const terminal = {
    stdinIsTty: !!stdin2.isTTY,
    stdoutIsTty: !!stdout.isTTY,
    term: process.env.TERM,
    ci: process.env.CI
  };
  if (shouldLaunchTui(args.positionals, terminal)) {
    const { runTui } = await import("./chunks/tui-ZM72ORCJ.js");
    try {
      await runTui(engine);
    } finally {
      engine.stopLocalTools();
    }
    return;
  }
  if (args.positionals.length === 0) {
    stdout.write(HELP);
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
    else stdout.write(`\uD504\uB85C\uD544 \uC800\uC7A5: ${profile.name} \u2192 ${profile.serverUrl}
`);
    return;
  }
  if (command === "profile" && action === "use") {
    const name = args.positionals[2];
    if (!name) throw new DexError("usage_error", "\uC0AC\uC6A9\uD560 \uD504\uB85C\uD544 \uC774\uB984\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const profile = await engine.useProfile(name);
    if (asJson) writeJson(profile);
    else stdout.write(`\uD604\uC7AC \uD504\uB85C\uD544: ${profile.name}
`);
    return;
  }
  if (command === "profile" && action === "list") {
    const profiles = await engine.listProfiles();
    if (asJson) writeJson(profiles);
    else if (profiles.length === 0) stdout.write("\uD504\uB85C\uD544\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.\n");
    else {
      for (const profile of profiles) {
        stdout.write(`${profile.current ? "*" : " "} ${profile.name.padEnd(16)} ${profile.serverUrl}
`);
      }
    }
    return;
  }
  if (command === "login") {
    const password = flag(args, "password-stdin") || !stdin2.isTTY ? await readStdin() : await promptSecret("Password: ");
    const status = await engine.login(requiredOption(args, "email"), password, option(args, "profile"));
    if (asJson) writeJson(status);
    else stdout.write(`\uB85C\uADF8\uC778\uB428: ${status.user?.username ?? "unknown"} (${status.profile})
`);
    return;
  }
  if (command === "status") {
    const status = await engine.authStatus(option(args, "profile"));
    if (asJson) writeJson(status);
    else if (status.authenticated) {
      stdout.write(`\uB85C\uADF8\uC778\uB428: ${status.user?.username ?? "unknown"} @ ${status.serverUrl}
`);
    } else {
      stdout.write(`\uB85C\uADF8\uC544\uC6C3\uB428: ${status.profile} (${status.reason ?? "unknown"})
`);
    }
    return;
  }
  if (command === "logout") {
    await engine.logout(option(args, "profile"));
    if (asJson) writeJson({ ok: true });
    else stdout.write("\uB85C\uADF8\uC544\uC6C3\uD588\uC2B5\uB2C8\uB2E4.\n");
    return;
  }
  if (command === "tools" && action === "list") {
    const tools = (await engine.localToolsStatus()).tools;
    if (asJson) writeJson(tools);
    else {
      stdout.write(`${cell("TOOL", 14)}  DESCRIPTION
`);
      for (const tool of tools) stdout.write(`${cell(tool.name, 14)}  ${tool.description}
`);
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
    else for (const content of result.content) stdout.write(`${content.text}
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
  throw new DexError("usage_error", `\uC54C \uC218 \uC5C6\uB294 \uBA85\uB839\uC785\uB2C8\uB2E4: ${args.positionals.join(" ")}`);
}
run().catch((error) => {
  const exposed = publicError(error);
  const machine = process.argv.includes("--json") || process.argv.includes("--jsonl");
  if (machine) stderr2.write(`${JSON.stringify({ error: exposed })}
`);
  else stderr2.write(`dex: ${exposed.message}
`);
  process.exitCode = exitCode(error);
});
//# sourceMappingURL=cli.js.map
