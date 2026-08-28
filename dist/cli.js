#!/usr/bin/env node
import {
  DexError,
  XgenClient,
  isUnauthorized,
  publicError
} from "./chunks/chunk-GL6MYQ62.js";

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

// src/config-store.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
var DEFAULT_PROFILE = "default";
function defaultConfig() {
  return {
    version: 1,
    currentProfile: DEFAULT_PROFILE,
    profiles: {},
    localTools: defaultLocalToolsConfig()
  };
}
function defaultLocalToolsConfig() {
  return {
    enabled: false,
    cwd: "",
    timeoutMs: 12e4,
    allowedRoots: [],
    blockedCommands: [],
    allowDangerous: false
  };
}
function dataDirectory(env = process.env) {
  if (env.DEX_CLI_HOME?.trim()) return env.DEX_CLI_HOME.trim();
  if (platform() === "win32") return join(env.APPDATA || homedir(), "xgen-dex-cli");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "xgen-dex-cli");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "xgen-dex-cli");
}
function configPath(env = process.env) {
  return join(dataDirectory(env), "config.json");
}
function parseConfig(raw) {
  if (!raw || typeof raw !== "object") throw new DexError("config_invalid", "\uC124\uC815 \uD30C\uC77C\uC774 \uAC1D\uCCB4\uAC00 \uC544\uB2D9\uB2C8\uB2E4.");
  const value = raw;
  const profiles = {};
  if (value.profiles && typeof value.profiles === "object") {
    for (const [name, profile] of Object.entries(value.profiles)) {
      if (!profile || typeof profile !== "object") continue;
      const serverUrl = String(profile.serverUrl ?? "").trim();
      if (serverUrl) profiles[name] = { serverUrl };
    }
  }
  const localTools = parseLocalToolsConfig(value.localTools);
  return {
    version: 1,
    currentProfile: String(value.currentProfile || DEFAULT_PROFILE),
    profiles,
    localTools
  };
}
function parseLocalToolsConfig(raw) {
  const defaults = defaultLocalToolsConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const value = raw;
  const timeout = Number(value.timeoutMs);
  return {
    enabled: value.enabled === true,
    cwd: typeof value.cwd === "string" ? value.cwd.trim() : "",
    timeoutMs: Number.isFinite(timeout) ? Math.max(1e3, Math.min(36e5, Math.round(timeout))) : defaults.timeoutMs,
    allowedRoots: stringArray(value.allowedRoots),
    blockedCommands: stringArray(value.blockedCommands),
    allowDangerous: value.allowDangerous === true
  };
}
function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}
var FileConfigStore = class {
  constructor(path = configPath()) {
    this.path = path;
  }
  queue = Promise.resolve();
  async read() {
    try {
      return parseConfig(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return defaultConfig();
      if (error instanceof DexError) throw error;
      throw new DexError("config_invalid", `\uC124\uC815 \uD30C\uC77C\uC744 \uC77D\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${this.path}`, error);
    }
  }
  async write(config) {
    const operation = async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 448 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
      await chmod(temporary, 384);
      await rename(temporary, this.path);
    };
    this.queue = this.queue.then(operation, operation);
    await this.queue;
  }
};
function validateProfileName(input) {
  const name = input.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new DexError(
      "config_invalid",
      "\uD504\uB85C\uD544 \uC774\uB984\uC740 \uC601\uBB38\uC790/\uC22B\uC790\uB85C \uC2DC\uC791\uD558\uACE0 \uC601\uBB38\uC790, \uC22B\uC790, \uC810, \uBC11\uC904, \uD558\uC774\uD508\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
    );
  }
  return name;
}
function validateServerUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new DexError("config_invalid", "\uC11C\uBC84 URL\uC740 http:// \uB610\uB294 https://\uB85C \uC2DC\uC791\uD574\uC57C \uD569\uB2C8\uB2E4.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DexError("config_invalid", "\uC11C\uBC84 URL\uC740 http:// \uB610\uB294 https://\uB9CC \uC0AC\uC6A9\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new DexError("config_invalid", "\uC11C\uBC84 URL\uC5D0\uB294 \uC790\uACA9 \uC99D\uBA85, query, fragment\uB97C \uB123\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }
  return url.toString().replace(/\/$/, "");
}

// src/credential-store.ts
var SERVICE = "xgen-dex-cli";
var ACCOUNT_PREFIX = "profile:";
async function loadKeytar() {
  try {
    const loaded = await import("keytar");
    const keytar = loaded.default ?? loaded;
    if (!keytar.getPassword || !keytar.setPassword || !keytar.deletePassword) throw new Error("invalid keytar module");
    return keytar;
  } catch (error) {
    throw new DexError(
      "credential_store_unavailable",
      "OS \uD0A4\uCCB4\uC778\uC744 \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. keytar \uC124\uCE58\uC640 OS \uD0A4\uB9C1 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694.",
      error
    );
  }
}
function parseSession(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value.serverUrl || !value.accessToken) return null;
    return value;
  } catch {
    return null;
  }
}
var KeytarCredentialStore = class {
  async get(profile) {
    const keytar = await loadKeytar();
    return parseSession(await keytar.getPassword(SERVICE, ACCOUNT_PREFIX + profile));
  }
  async set(profile, session) {
    const keytar = await loadKeytar();
    await keytar.setPassword(SERVICE, ACCOUNT_PREFIX + profile, JSON.stringify(session));
  }
  async delete(profile) {
    const keytar = await loadKeytar();
    await keytar.deletePassword(SERVICE, ACCOUNT_PREFIX + profile);
  }
};

// src/engine.ts
import { randomUUID } from "node:crypto";

// src/local-tool-bridge.ts
import WebSocket from "ws";

// src/local-tools.ts
import { spawn } from "node:child_process";
import {
  appendFile,
  mkdir as mkdir2,
  readFile as readFile2,
  readdir,
  realpath,
  stat,
  writeFile as writeFile2
} from "node:fs/promises";
import { homedir as homedir2, platform as platform2 } from "node:os";
import {
  basename,
  dirname as dirname2,
  extname,
  isAbsolute,
  join as join2,
  relative,
  resolve
} from "node:path";
var LOCAL_TOOL_SERVER = "local";
var LOCAL_TOOL_NAMES = ["Shell", "ReadFile", "WriteFile", "ListDir", "Search", "Open"];
var OUTPUT_CAP = 2e5;
var WRITE_CAP_BYTES = 2e6;
var COMMAND_CAP_CHARS = 32e3;
var BINARY_EXTENSIONS = /* @__PURE__ */ new Set([
  ".7z",
  ".avi",
  ".bin",
  ".class",
  ".dmg",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".tar",
  ".wav",
  ".webp",
  ".xlsx",
  ".zip"
]);
var DANGEROUS_COMMANDS = [
  /\brm\s+-[a-z]*[rf]/i,
  /(^|[;&|`(])\s*rm\s+\//i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\b(mkfs|fdisk|format)\b/i,
  /\bdd\b[^\n]*\b(of|if)=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/,
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\bsudo\s+rm\b/i
];
function localToolSchemas() {
  return [
    {
      name: "Shell",
      description: "Run one non-interactive command on the USER'S LOCAL COMPUTER in the configured working directory. Use for builds, tests, git, and project automation. Destructive commands may be refused by policy.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command line to execute." },
          cwd: { type: "string", description: "Working directory inside an allowed root." },
          timeoutMs: { type: "integer", minimum: 1e3, maximum: 36e5 }
        },
        required: ["command"]
      }
    },
    {
      name: "ReadFile",
      description: "Read a UTF-8 text file from the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxBytes: { type: "integer", minimum: 1, maximum: OUTPUT_CAP }
        },
        required: ["path"]
      }
    },
    {
      name: "WriteFile",
      description: "Create, replace, or append a UTF-8 file on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["overwrite", "append"] }
        },
        required: ["path", "content"]
      }
    },
    {
      name: "ListDir",
      description: "List a directory on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } }
      }
    },
    {
      name: "Search",
      description: "Search UTF-8 project files on the USER'S LOCAL COMPUTER inside an allowed root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 500 },
          caseSensitive: { type: "boolean" }
        },
        required: ["query"]
      }
    },
    {
      name: "Open",
      description: "Open an http(s) URL, file, or folder on the USER'S LOCAL COMPUTER with the operating system default app. Filesystem targets must be inside an allowed root.",
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"]
      }
    }
  ];
}
function normalizeLocalToolsConfig(value, fallbackCwd = process.cwd()) {
  const cwd = expandPath(value.cwd || fallbackCwd, fallbackCwd);
  const roots = (value.allowedRoots.length ? value.allowedRoots : [cwd]).map((root) => expandPath(root, cwd));
  return {
    enabled: value.enabled === true,
    cwd,
    timeoutMs: Math.max(1e3, Math.min(36e5, Math.round(value.timeoutMs || 12e4))),
    allowedRoots: [...new Set(roots)],
    blockedCommands: [...new Set(value.blockedCommands.map((item) => firstToken(item)).filter(Boolean))],
    allowDangerous: value.allowDangerous === true
  };
}
function firstToken(command) {
  const match = String(command || "").trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const raw = match && (match[1] || match[2] || match[3]) || "";
  return basename(raw).replace(/\.(exe|cmd|bat|com|ps1)$/i, "").toLocaleLowerCase();
}
function isDangerousCommand(command) {
  return DANGEROUS_COMMANDS.some((pattern) => pattern.test(command));
}
var LocalToolProvider = class {
  config;
  constructor(config) {
    this.config = normalizeLocalToolsConfig(config);
  }
  configure(config) {
    this.config = normalizeLocalToolsConfig(config);
  }
  schemas() {
    return this.config.enabled ? localToolSchemas() : [];
  }
  async call(tool, args) {
    if (!this.config.enabled) throw new DexError("local_tools_disabled", "\uB85C\uCEEC \uB3C4\uAD6C\uAC00 \uAEBC\uC838 \uC788\uC2B5\uB2C8\uB2E4.");
    if (!LOCAL_TOOL_NAMES.includes(tool)) {
      throw new DexError("not_found", `\uC9C0\uC6D0\uD558\uC9C0 \uC54A\uB294 \uB85C\uCEEC \uB3C4\uAD6C\uC785\uB2C8\uB2E4: ${tool}`);
    }
    if (tool === "Shell") return this.shell(args);
    if (tool === "ReadFile") return this.readFile(args);
    if (tool === "WriteFile") return this.writeFile(args);
    if (tool === "ListDir") return this.listDir(args);
    if (tool === "Search") return this.search(args);
    return this.open(args);
  }
  objectArgs(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return {};
    return args;
  }
  async scopedPath(input, defaultPath = this.config.cwd) {
    const raw = String(input ?? defaultPath).trim();
    if (!raw) throw new DexError("usage_error", "\uB85C\uCEEC \uACBD\uB85C\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const candidate = expandPath(raw, this.config.cwd);
    const roots = await Promise.all(this.config.allowedRoots.map((root) => canonicalCandidate(root)));
    const canonical = await canonicalCandidate(candidate);
    if (!roots.some((root) => inside(root, canonical))) {
      throw new DexError(
        "local_path_denied",
        `\uD5C8\uC6A9\uB41C \uB85C\uCEEC \uACBD\uB85C \uBC94\uC704\uB97C \uBC97\uC5B4\uB0AC\uC2B5\uB2C8\uB2E4: ${candidate}`,
        { allowedRoots: this.config.allowedRoots }
      );
    }
    return candidate;
  }
  async readFile(args) {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path);
    const maxBytes = Math.max(1, Math.min(OUTPUT_CAP, Number(input.maxBytes) || OUTPUT_CAP));
    const bytes = await readFile2(path);
    const text = bytes.subarray(0, maxBytes).toString("utf8");
    const suffix = bytes.byteLength > maxBytes ? `
\u2026(truncated, ${bytes.byteLength} bytes total)` : "";
    return result((text || "(empty file)") + suffix);
  }
  async writeFile(args) {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path);
    const content = typeof input.content === "string" ? input.content : String(input.content ?? "");
    const contentBytes = Buffer.byteLength(content);
    if (contentBytes > WRITE_CAP_BYTES) {
      throw new DexError("usage_error", `\uD55C \uBC88\uC5D0 \uC800\uC7A5\uD560 \uC218 \uC788\uB294 \uD06C\uAE30\uB294 ${WRITE_CAP_BYTES} bytes \uC774\uD558\uC785\uB2C8\uB2E4.`);
    }
    await mkdir2(dirname2(path), { recursive: true });
    if (input.mode === "append") await appendFile(path, content, "utf8");
    else await writeFile2(path, content, "utf8");
    return result(`${input.mode === "append" ? "\uC774\uC5B4\uC37C\uC2B5\uB2C8\uB2E4" : "\uC800\uC7A5\uD588\uC2B5\uB2C8\uB2E4"}: ${path} (${contentBytes} bytes)`);
  }
  async listDir(args) {
    const input = this.objectArgs(args);
    const path = await this.scopedPath(input.path, this.config.cwd);
    const entries = await readdir(path, { withFileTypes: true });
    const rows = [];
    for (const entry of entries.slice(0, 1e3)) {
      const fullPath = join2(path, entry.name);
      const info = await stat(fullPath).catch(() => void 0);
      rows.push(`${entry.isDirectory() ? "d" : "-"} ${String(info?.size ?? "?").padStart(10)}  ${entry.name}`);
    }
    if (entries.length > rows.length) rows.push(`\u2026(${entries.length} entries, first ${rows.length} shown)`);
    return result(rows.join("\n") || "(empty directory)");
  }
  async search(args) {
    const input = this.objectArgs(args);
    const rawQuery = String(input.query ?? "");
    if (!rawQuery) throw new DexError("usage_error", "Search \uB3C4\uAD6C\uC5D0\uB294 query\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const root = await this.scopedPath(input.path, this.config.cwd);
    const maxResults = Math.max(1, Math.min(500, Number(input.maxResults) || 100));
    const caseSensitive = input.caseSensitive === true;
    const query = caseSensitive ? rawQuery : rawQuery.toLocaleLowerCase();
    const hits = [];
    const skipped = /* @__PURE__ */ new Set([".git", ".next", ".venv", "__pycache__", "dist", "node_modules", "out"]);
    const visit = async (directory, depth) => {
      if (hits.length >= maxResults || depth > 10) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (hits.length >= maxResults) return;
        const path = join2(directory, entry.name);
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name) && !entry.name.startsWith(".")) await visit(path, depth + 1);
          continue;
        }
        if (!entry.isFile() || BINARY_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) continue;
        const info = await stat(path).catch(() => void 0);
        if (!info || info.size > 2e6) continue;
        const content = await readFile2(path, "utf8").catch(() => void 0);
        if (content === void 0) continue;
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
          if (haystack.includes(query)) hits.push(`${path}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        }
      }
    };
    await visit(root, 0);
    return result(hits.join("\n") || `'${rawQuery}' \uAC80\uC0C9 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4 (${root}).`);
  }
  async shell(args) {
    const input = this.objectArgs(args);
    const command = String(input.command ?? "").trim();
    if (!command) throw new DexError("usage_error", "Shell \uB3C4\uAD6C\uC5D0\uB294 command\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    if (command.length > COMMAND_CAP_CHARS) throw new DexError("usage_error", "Shell command\uAC00 \uB108\uBB34 \uAE41\uB2C8\uB2E4.");
    const token = firstToken(command);
    if (this.config.blockedCommands.includes(token)) {
      throw new DexError("local_command_denied", `\uCC28\uB2E8\uB41C \uBA85\uB839\uC785\uB2C8\uB2E4: ${token}`);
    }
    if (!this.config.allowDangerous && isDangerousCommand(command)) {
      throw new DexError(
        "local_command_denied",
        "\uB418\uB3CC\uB9AC\uAE30 \uC5B4\uB824\uC6B4 \uBA85\uB839 \uD328\uD134\uC774 \uAC10\uC9C0\uB418\uC5B4 \uC2E4\uD589\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uD544\uC694\uD558\uBA74 allowDangerous \uC124\uC815\uC744 \uBA85\uC2DC\uC801\uC73C\uB85C \uCF1C\uC138\uC694."
      );
    }
    const cwd = await this.scopedPath(input.cwd, this.config.cwd);
    const timeoutMs = Math.max(
      1e3,
      Math.min(36e5, Math.round(Number(input.timeoutMs) || this.config.timeoutMs))
    );
    const invocation = shellInvocation(command);
    const captured = await captureProcess(invocation.file, invocation.args, cwd, timeoutMs);
    if (captured.error) throw new DexError("local_tool_failed", captured.error.message);
    const sections = [];
    if (captured.stdout.trim()) sections.push(captured.stdout.trimEnd());
    if (captured.stderr.trim()) sections.push(`STDERR:
${captured.stderr.trimEnd()}`);
    if (captured.timedOut) sections.push(`(${Math.round(timeoutMs / 1e3)}\uCD08 \uC81C\uD55C\uC73C\uB85C \uC885\uB8CC\uB428)`);
    else if (captured.signal) sections.push(`(signal ${captured.signal})`);
    else if (captured.code !== 0) sections.push(`(exit code ${captured.code})`);
    return {
      content: [{ type: "text", text: sections.join("\n\n") || "(no output)" }],
      ...captured.timedOut || captured.signal || captured.code !== 0 ? { isError: true } : {}
    };
  }
  async open(args) {
    const input = this.objectArgs(args);
    const target = String(input.target ?? "").trim();
    if (!target) throw new DexError("usage_error", "Open \uB3C4\uAD6C\uC5D0\uB294 target\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.");
    let resolvedTarget = target;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      const url = new URL(target);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new DexError("local_open_denied", `\uD5C8\uC6A9\uD558\uC9C0 \uC54A\uB294 URL scheme\uC785\uB2C8\uB2E4: ${url.protocol}`);
      }
    } else {
      resolvedTarget = await this.scopedPath(target);
    }
    const invocation = openerInvocation(resolvedTarget);
    await spawnDetached(invocation.file, invocation.args);
    return result(`\uC5F4\uC5C8\uC2B5\uB2C8\uB2E4: ${resolvedTarget}`);
  }
};
function result(text) {
  return { content: [{ type: "text", text }] };
}
function expandPath(value, base) {
  const expanded = value === "~" ? homedir2() : value.startsWith("~/") || value.startsWith("~\\") ? join2(homedir2(), value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : resolve(base, expanded));
}
function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
}
async function canonicalCandidate(path) {
  let cursor = path;
  const tail = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...tail.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname2(cursor);
      if (parent === cursor) return path;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
}
function shellInvocation(command) {
  if (platform2() === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] };
  }
  const configured = String(process.env.SHELL || "").trim();
  return { file: configured.startsWith("/") ? configured : "bash", args: ["-lc", command] };
}
function openerInvocation(target) {
  if (platform2() === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", "start", "", target] };
  if (platform2() === "darwin") return { file: "open", args: [target] };
  return { file: "xdg-open", args: [target] };
}
function captureProcess(file, args, cwd, timeoutMs) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        detached: platform2() !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      done({ stdout: "", stderr: "", code: null, signal: null, error });
      return;
    }
    let stdout2 = "";
    let stderr3 = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(value);
    };
    child.stdout?.on("data", (chunk) => {
      stdout2 = capped(stdout2 + String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr3 = capped(stderr3 + String(chunk));
    });
    child.once("error", (error) => finish({ stdout: stdout2, stderr: stderr3, code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ stdout: stdout2, stderr: stderr3, code, signal }));
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ stdout: stdout2, stderr: stderr3, code: null, signal: "SIGKILL", timedOut: true });
    }, timeoutMs);
  });
}
function capped(value) {
  return value.length > OUTPUT_CAP ? `${value.slice(-OUTPUT_CAP)}
\u2026(truncated)` : value;
}
function killProcessTree(child) {
  if (!child.pid) return;
  if (platform2() === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
function spawnDetached(file, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { detached: true, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

// src/local-tool-bridge.ts
var HEARTBEAT_MS = 2e4;
var RETRY_MIN_MS = 1e3;
var RETRY_MAX_MS = 3e4;
var LocalToolBridge = class {
  constructor(tools, log = () => void 0) {
    this.tools = tools;
    this.log = log;
  }
  socket;
  options;
  stopped = true;
  heartbeat;
  retry;
  retryMs = RETRY_MIN_MS;
  catalogSequence = 0;
  pendingCatalogId = "";
  statusValue = {
    running: false,
    connected: false,
    catalogSynced: false,
    advertisedTools: 0,
    serverTools: 0
  };
  listeners = /* @__PURE__ */ new Set();
  status() {
    return structuredClone(this.statusValue);
  }
  onStatus(listener) {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }
  start(options) {
    const sameTarget = !this.stopped && this.options?.serverUrl === options.serverUrl && this.options?.userId === options.userId && this.options?.profile === options.profile;
    this.options = options;
    this.stopped = false;
    this.patchStatus({
      running: true,
      profile: options.profile,
      serverUrl: options.serverUrl,
      userId: options.userId,
      advertisedTools: this.tools.schemas().length
    });
    if (sameTarget && this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) this.sendCatalog();
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) return;
    }
    this.disconnectSocket();
    this.retryMs = RETRY_MIN_MS;
    void this.connect();
  }
  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.retry = void 0;
    this.heartbeat = void 0;
    this.disconnectSocket();
    this.options = void 0;
    this.statusValue = {
      running: false,
      connected: false,
      catalogSynced: false,
      advertisedTools: 0,
      serverTools: 0
    };
    this.emit();
  }
  refreshCatalog() {
    this.patchStatus({ advertisedTools: this.tools.schemas().length });
    this.sendCatalog();
  }
  async waitUntilReady(timeoutMs = 3e3) {
    if (this.statusValue.catalogSynced) return this.status();
    return new Promise((resolve2) => {
      let remove = () => void 0;
      const timer = setTimeout(() => {
        remove();
        resolve2(this.status());
      }, Math.max(0, timeoutMs));
      remove = this.onStatus((status) => {
        if (!status.catalogSynced) return;
        clearTimeout(timer);
        remove();
        resolve2(status);
      });
    });
  }
  async connect() {
    if (this.stopped || !this.options) return;
    const options = this.options;
    const token = await options.getToken().catch(() => null);
    if (this.stopped || this.options !== options) return;
    const url = `${options.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/api/tools/ws/connector-mcp/${encodeURIComponent(options.userId)}`;
    this.log(`local tools bridge connecting: ${url}`);
    const socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : void 0,
      maxPayload: 2e6
    });
    this.socket = socket;
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      this.patchStatus({ error: `handshake HTTP ${status}` });
      const refresh = status === 401 || status === 403 ? options.refreshAuth() : Promise.resolve(null);
      void refresh.finally(() => {
        if (this.socket === socket) this.socket = void 0;
        socket.removeAllListeners();
        socket.on("error", () => void 0);
        socket.close();
        this.scheduleRetry();
      });
    });
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.retryMs = RETRY_MIN_MS;
      this.patchStatus({ connected: true, error: void 0 });
      this.sendCatalog();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, HEARTBEAT_MS);
    });
    socket.on("message", (raw) => void this.onMessage(String(raw)));
    socket.on("error", (error) => {
      this.patchStatus({ error: error.message });
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = void 0;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = void 0;
      this.patchStatus({ connected: false, catalogSynced: false, serverTools: 0 });
      this.scheduleRetry();
    });
  }
  sendCatalog() {
    const schemas = this.tools.schemas();
    this.patchStatus({ advertisedTools: schemas.length });
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const catalogId = `${Date.now()}-${++this.catalogSequence}`;
    this.pendingCatalogId = catalogId;
    const tools = schemas.map((tool) => ({
      server: LOCAL_TOOL_SERVER,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    this.socket.send(JSON.stringify({ type: "hello", catalog_id: catalogId, tools }));
    this.patchStatus({ catalogSynced: false, serverTools: 0 });
  }
  async onMessage(text) {
    let message;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    if (message.type === "ready") {
      if (message.catalog_id !== this.pendingCatalogId) return;
      this.patchStatus({
        catalogSynced: true,
        serverTools: Number.isFinite(message.tool_count) ? Math.max(0, Math.trunc(Number(message.tool_count))) : 0
      });
      return;
    }
    if (message.type === "ping") {
      this.socket?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message.type !== "mcp_call") return;
    const requestId = typeof message.request_id === "string" ? message.request_id : "";
    const server = typeof message.server === "string" ? message.server : "";
    const tool = typeof message.tool === "string" ? message.tool : "";
    const startedAt = Date.now();
    let payload;
    try {
      if (!requestId) throw new Error("request_id is required");
      if (server !== LOCAL_TOOL_SERVER) throw new Error(`unknown local tool server: ${server}`);
      const result2 = await this.tools.call(tool, message.args ?? {});
      payload = { request_id: requestId, ok: true, result: result2 };
      this.patchStatus({
        lastCall: { tool, ok: true, durationMs: Date.now() - startedAt, at: (/* @__PURE__ */ new Date()).toISOString() }
      });
    } catch (error) {
      payload = { request_id: requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
      this.patchStatus({
        lastCall: { tool, ok: false, durationMs: Date.now() - startedAt, at: (/* @__PURE__ */ new Date()).toISOString() }
      });
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "mcp_result", ...payload }));
    }
  }
  scheduleRetry() {
    if (this.stopped || this.retry) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, Math.round(this.retryMs * 1.8));
    this.retry = setTimeout(() => {
      this.retry = void 0;
      void this.connect();
    }, delay);
  }
  disconnectSocket() {
    const socket = this.socket;
    this.socket = void 0;
    if (!socket) return;
    socket.removeAllListeners();
    socket.on("error", () => void 0);
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
  }
  patchStatus(patch) {
    this.statusValue = { ...this.statusValue, ...patch };
    this.emit();
  }
  emit() {
    const value = this.status();
    for (const listener of this.listeners) listener(value);
  }
};

// src/engine.ts
var DexEngine = class {
  constructor(configs, credentials, options = {}) {
    this.configs = configs;
    this.credentials = credentials;
    this.localTools = options.localToolProvider ?? new LocalToolProvider(defaultLocalToolsConfig());
    this.localToolBridge = options.localToolBridge ?? new LocalToolBridge(this.localTools, options.log);
  }
  clients = /* @__PURE__ */ new Map();
  localTools;
  localToolBridge;
  async listProfiles() {
    const config = await this.configs.read();
    return Object.entries(config.profiles).map(([name, profile]) => ({ name, ...profile, current: name === config.currentProfile })).sort((a, b) => a.name.localeCompare(b.name));
  }
  onLocalToolsStatus(listener) {
    return this.localToolBridge.onStatus(listener);
  }
  async localToolsStatus() {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    const tools = this.localTools.schemas();
    const bridge = this.localToolBridge.status();
    if (config.enabled && !bridge.running) bridge.advertisedTools = tools.length;
    return { config, tools, bridge };
  }
  async configureLocalTools(patch) {
    const config = await this.configs.read();
    const current = normalizeLocalToolsConfig(config.localTools);
    config.localTools = normalizeLocalToolsConfig({
      ...current,
      ...patch,
      allowedRoots: patch.allowedRoots ?? current.allowedRoots,
      blockedCommands: patch.blockedCommands ?? current.blockedCommands
    });
    await this.configs.write(config);
    this.localTools.configure(config.localTools);
    if (!config.localTools.enabled) this.localToolBridge.stop();
    else this.localToolBridge.refreshCatalog();
    return this.localToolsStatus();
  }
  async runLocalTool(tool, args) {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    return this.localTools.call(tool, args);
  }
  async startLocalTools(requestedProfile, waitMs = 0) {
    const config = normalizeLocalToolsConfig((await this.configs.read()).localTools);
    this.localTools.configure(config);
    if (!config.enabled) {
      this.localToolBridge.stop();
      return this.localToolsStatus();
    }
    const record = await this.authenticatedRecord(requestedProfile);
    const userId = record.client.user?.userId?.trim();
    if (!userId) throw new DexError("auth_invalid", "\uB85C\uCEEC \uB3C4\uAD6C \uC5F0\uACB0\uC5D0 \uD544\uC694\uD55C \uC0AC\uC6A9\uC790 ID\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
    this.localToolBridge.start({
      profile: record.profile,
      serverUrl: record.serverUrl,
      userId,
      getToken: async () => {
        await this.flush(record);
        return record.client.getAccessTokenAfterRotation() || (await this.credentials.get(record.profile))?.accessToken || null;
      },
      refreshAuth: async () => {
        const session = await this.credentials.get(record.profile);
        const token = await record.client.ensureFreshAuth(session?.refreshToken);
        await this.flush(record);
        return token;
      }
    });
    if (waitMs > 0) await this.localToolBridge.waitUntilReady(waitMs);
    return this.localToolsStatus();
  }
  stopLocalTools() {
    this.localToolBridge.stop();
  }
  async setProfile(nameInput, serverUrlInput) {
    const name = validateProfileName(nameInput);
    const serverUrl = validateServerUrl(serverUrlInput);
    const config = await this.configs.read();
    const previous = config.profiles[name];
    config.profiles[name] = { serverUrl };
    if (!config.profiles[config.currentProfile]) config.currentProfile = name;
    await this.configs.write(config);
    this.clients.delete(name);
    if (name === config.currentProfile && previous?.serverUrl !== serverUrl) this.localToolBridge.stop();
    if (previous && previous.serverUrl !== serverUrl) await this.credentials.delete(name);
    return { name, serverUrl, current: name === config.currentProfile };
  }
  async useProfile(nameInput) {
    const name = validateProfileName(nameInput);
    const config = await this.configs.read();
    const profile = config.profiles[name];
    if (!profile) throw new DexError("not_found", `\uD504\uB85C\uD544\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${name}`);
    config.currentProfile = name;
    await this.configs.write(config);
    this.localToolBridge.stop();
    return { name, ...profile, current: true };
  }
  async login(email, password, requestedProfile) {
    if (!email.trim() || !password) throw new DexError("usage_error", "\uC774\uBA54\uC77C\uACFC \uBE44\uBC00\uBC88\uD638\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const { name, profile } = await this.resolveProfile(requestedProfile);
    this.clients.delete(name);
    const record = this.createClient(name, profile.serverUrl);
    const result2 = await record.client.login(email.trim(), password);
    const session = {
      serverUrl: profile.serverUrl,
      accessToken: result2.accessToken,
      refreshToken: result2.refreshToken
    };
    await this.credentials.set(name, session);
    await this.flush(record);
    record.authenticated = true;
    return {
      profile: name,
      serverUrl: profile.serverUrl,
      authenticated: true,
      user: record.client.user ?? void 0
    };
  }
  async authStatus(requestedProfile) {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (!session || session.serverUrl !== profile.serverUrl) {
      return {
        profile: name,
        serverUrl: profile.serverUrl,
        authenticated: false,
        reason: "missing_session"
      };
    }
    try {
      const record = await this.ensureAuthenticated(name, profile.serverUrl, session);
      return {
        profile: name,
        serverUrl: profile.serverUrl,
        authenticated: true,
        user: record.client.user ?? void 0
      };
    } catch (error) {
      if (error instanceof DexError && error.code === "network_error") {
        return {
          profile: name,
          serverUrl: profile.serverUrl,
          authenticated: false,
          reason: "network"
        };
      }
      if (error instanceof DexError && (error.code === "auth_required" || error.code === "auth_invalid")) {
        return {
          profile: name,
          serverUrl: profile.serverUrl,
          authenticated: false,
          reason: "invalid_session"
        };
      }
      throw error;
    }
  }
  async logout(requestedProfile) {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (session?.serverUrl === profile.serverUrl) {
      const record = this.createClient(name, profile.serverUrl);
      record.client.setTokens(session.accessToken, session.refreshToken);
      await record.client.logout().catch(() => {
      });
    }
    await this.credentials.delete(name);
    this.clients.delete(name);
    this.localToolBridge.stop();
  }
  async listAgents(query = {}, requestedProfile) {
    return this.withAuthRetry(requestedProfile, (client) => client.agents.list(query));
  }
  async listConversations(requestedProfile) {
    return this.withAuthRetry(requestedProfile, (client) => client.history.conversations());
  }
  async historyTurns(workflowId, interactionId, workflowName, requestedProfile) {
    if (!workflowId || !interactionId) {
      throw new DexError("usage_error", "workflowId\uC640 interactionId\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    }
    return this.withAuthRetry(
      requestedProfile,
      (client) => client.history.turns(workflowId, interactionId, workflowName)
    );
  }
  async resolveChatInput(input) {
    const workflowId = input.workflowId.trim();
    if (!workflowId) throw new DexError("usage_error", "Agent workflow ID\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4.");
    const { name } = await this.resolveProfile(input.profile);
    const workflowName = input.workflowName?.trim() || (await this.findAgent(workflowId, name)).workflowName;
    return {
      profile: name,
      workflowId,
      workflowName,
      input: input.input,
      interactionId: input.interactionId?.trim() || randomUUID()
    };
  }
  async *chat(input, signal) {
    const resolved = await this.resolveChatInput(input);
    let record = await this.authenticatedRecord(resolved.profile);
    let emitted = false;
    try {
      const local = await this.startLocalTools(resolved.profile, 3e3);
      if (local.config.enabled) {
        yield local.bridge.catalogSynced ? {
          kind: "status",
          surface: "connector_local",
          detail: `\uB85C\uCEEC \uB3C4\uAD6C ${local.bridge.serverTools || local.tools.length}\uAC1C \uC5F0\uACB0\uB428`
        } : {
          kind: "status",
          surface: "connector_local",
          detail: local.bridge.error || "\uB85C\uCEEC \uB3C4\uAD6C \uCE74\uD0C8\uB85C\uADF8 \uC5F0\uACB0 \uB300\uAE30 \uC911",
          reason: "bridge_not_ready"
        };
      }
    } catch (error) {
      yield {
        kind: "status",
        surface: "connector_local",
        detail: `\uB85C\uCEEC \uB3C4\uAD6C \uC5F0\uACB0 \uC2E4\uD328: ${error instanceof Error ? error.message : String(error)}`,
        reason: "bridge_error"
      };
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        for await (const event of record.client.chat.stream(
          {
            workflowId: resolved.workflowId,
            workflowName: resolved.workflowName,
            input: resolved.input,
            interactionId: resolved.interactionId
          },
          signal
        )) {
          emitted = true;
          yield event;
        }
        return resolved;
      } catch (error) {
        if (attempt === 0 && !emitted && isUnauthorized(error)) {
          await this.refresh(record);
          record = await this.authenticatedRecord(resolved.profile);
          continue;
        }
        throw error;
      }
    }
    return resolved;
  }
  async findAgent(selector, profile) {
    const agents = await this.withAuthRetry(profile, (client) => client.agents.listAll({}, 100));
    const normalized = selector.trim().toLocaleLowerCase();
    const found = agents.find((agent) => agent.workflowId === selector.trim()) ?? agents.find((agent) => agent.workflowName.toLocaleLowerCase() === normalized);
    if (!found) throw new DexError("not_found", `Agent\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${selector}`);
    return found;
  }
  async withAuthRetry(requestedProfile, operation) {
    const record = await this.authenticatedRecord(requestedProfile);
    try {
      return await operation(record.client);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.refresh(record);
      return operation(record.client);
    }
  }
  async authenticatedRecord(requestedProfile) {
    const { name, profile } = await this.resolveProfile(requestedProfile);
    const session = await this.credentials.get(name);
    if (!session || session.serverUrl !== profile.serverUrl) {
      throw new DexError("auth_required", `\uB85C\uADF8\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4: dex login --profile ${name}`);
    }
    return this.ensureAuthenticated(name, profile.serverUrl, session);
  }
  async ensureAuthenticated(name, serverUrl, session) {
    const cached = this.clients.get(name);
    if (cached?.authenticated && cached.serverUrl === serverUrl) return cached;
    const record = cached?.serverUrl === serverUrl ? cached : this.createClient(name, serverUrl);
    const state = await record.client.restoreDetailed(session.accessToken, session.refreshToken);
    await this.flush(record);
    if (state === "valid") {
      record.authenticated = true;
      return record;
    }
    if (state === "invalid") {
      await this.credentials.delete(name);
      this.clients.delete(name);
      throw new DexError("auth_invalid", `\uC138\uC158\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4: dex login --profile ${name}`);
    }
    throw new DexError("network_error", `XGEN \uC11C\uBC84\uC5D0 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4: ${serverUrl}`);
  }
  createClient(profile, serverUrl) {
    const existing = this.clients.get(profile);
    if (existing?.serverUrl === serverUrl) return existing;
    const record = {
      profile,
      serverUrl,
      authenticated: false,
      persisting: Promise.resolve()
    };
    record.client = new XgenClient({
      baseUrl: serverUrl,
      onTokensRotated: (accessToken, refreshToken) => {
        record.persisting = record.persisting.then(
          () => this.credentials.set(profile, { serverUrl, accessToken, refreshToken })
        );
      }
    });
    this.clients.set(profile, record);
    return record;
  }
  async refresh(record) {
    const session = await this.credentials.get(record.profile);
    const accessToken = await record.client.ensureFreshAuth(session?.refreshToken);
    await this.flush(record);
    if (!accessToken) {
      await this.credentials.delete(record.profile);
      record.authenticated = false;
      throw new DexError("auth_invalid", `\uC138\uC158\uC774 \uB9CC\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4: dex login --profile ${record.profile}`);
    }
    record.authenticated = true;
  }
  async flush(record) {
    await record.persisting;
  }
  async resolveProfile(requested) {
    const config = await this.configs.read();
    const name = requested ? validateProfileName(requested) : config.currentProfile;
    const profile = config.profiles[name];
    if (!profile) {
      throw new DexError(
        "config_invalid",
        `XGEN \uC11C\uBC84 \uD504\uB85C\uD544\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uBA3C\uC800 \uC2E4\uD589\uD558\uC138\uC694: dex profile set ${name} --server <URL>`
      );
    }
    return { name, profile };
  }
};

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
  return new Promise((resolve2, reject) => {
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
          resolve2(value);
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

// src/rpc-server.ts
import { createInterface as createInterface2 } from "node:readline";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/types.ts
var DEX_PROTOCOL_VERSION = 1;

// src/rpc-server.ts
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
      const result2 = await this.dispatch(value.method, value.params);
      if (hasId) this.write({ jsonrpc: "2.0", id: value.id ?? null, result: result2 });
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
    const streamId = optionalString(params, "streamId") ?? randomUUID2();
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
    `\uBE0C\uB9AC\uC9C0: ${status.bridge.catalogSynced ? `\uC5F0\uACB0\uB428 (${status.bridge.serverTools} tools)` : status.bridge.connected ? "\uCE74\uD0C8\uB85C\uADF8 \uB3D9\uAE30\uD654 \uC911" : status.bridge.running ? "\uC5F0\uACB0 \uB300\uAE30 \uC911" : "\uC911\uC9C0\uB428"}
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
  await new Promise((resolve2) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve2();
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
    const { runTui } = await import("./chunks/tui-4SAMYYOS.js");
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
    const tools = localToolSchemas();
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
    const result2 = await engine.runLocalTool(tool, jsonObjectOption(args, "args"));
    if (asJson) writeJson(result2);
    else for (const content of result2.content) stdout.write(`${content.text}
`);
    if (result2.isError) process.exitCode = 1;
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
    const result2 = await engine.listAgents(query, option(args, "profile"));
    if (asJson) writeJson(result2);
    else printAgents(result2.items);
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
