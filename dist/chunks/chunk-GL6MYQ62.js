// ../xgen-connector/src/core/agent-data.ts
function workspaceStoragePath(path) {
  const clean = String(path ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return clean === "workspace" || clean.startsWith("workspace/") ? clean : `workspace/${clean}`;
}
var AgentDataApi = class {
  constructor(http) {
    this.http = http;
  }
  // ── 전체로그 ──────────────────────────────────────────────────
  /** 이 에이전트의 실행 트레이스 목록(최근 50). */
  traceList(workflowId) {
    const params = new URLSearchParams({
      workflow_id: workflowId,
      page: "1",
      page_size: "50"
    });
    return this.http.get(`/api/agentflow/trace/list?${params}`);
  }
  /** 트레이스 하나의 스팬(단계) 전부. */
  traceDetail(traceId) {
    return this.http.get(`/api/agentflow/trace/detail/${encodeURIComponent(traceId)}`);
  }
  // ── 메모리 ────────────────────────────────────────────────────
  memoryList(workflowId) {
    return this.http.get(
      `/api/agentflow/geny-memory/${encodeURIComponent(workflowId)}/files`
    );
  }
  /** filename 은 서버에서 `{filename:path}` — 슬래시는 살리고 세그먼트만 인코딩한다. */
  memoryRead(workflowId, path) {
    const fp = path.split("/").map(encodeURIComponent).join("/");
    return this.http.get(
      `/api/agentflow/geny-memory/${encodeURIComponent(workflowId)}/files/${fp}`
    );
  }
  // ── 작업 ──────────────────────────────────────────────────────
  tasksList(workflowId) {
    return this.http.get(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}`
    );
  }
  /** 예약 작업(job=session_id) 1건의 실행 기록. */
  taskRuns(workflowId, sessionId) {
    return this.http.get(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}/job/${encodeURIComponent(sessionId ?? "")}/runs`
    );
  }
  /** 백그라운드/서브에이전트 작업(task_id) 1건의 출력. */
  taskOutput(workflowId, runId) {
    return this.http.get(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}/task/${encodeURIComponent(runId)}/output`
    );
  }
  // ── 세션 수명 ──────────────────────────────────────────────────
  /** '진행 중 대화' 종료 — 서버가 들고 있는 세션 RAM(executor + 라우팅)을 회수한다.
   *  이력은 지우지 않는다(삭제는 세션 종료이지 대화 기록 삭제가 아니다). */
  endSession(workflowId, interactionId) {
    return this.http.post(
      `/api/agentflow/geny-agent/${encodeURIComponent(workflowId)}/end-session`,
      { interaction_id: interactionId }
    );
  }
  // ── 기본정보 ──────────────────────────────────────────────────
  /** 실행 없이 재구성한 턴 프롬프트 + 도구 표면(web/connector 둘 다). */
  basicInfo(workflowId) {
    return this.http.get(
      `/api/agentflow/${encodeURIComponent(workflowId)}/basic-info`
    );
  }
  // ── 도구 ──────────────────────────────────────────────────────
  toolsList(workflowId) {
    return this.http.get(
      `/api/agentflow/geny-tools/${encodeURIComponent(workflowId)}`
    );
  }
  /** 제작 도구 하나 — 소스 코드까지. */
  toolGet(workflowId, functionId) {
    return this.http.get(
      `/api/agentflow/geny-tools/${encodeURIComponent(workflowId)}/${encodeURIComponent(functionId)}?with_source=true`
    );
  }
  // ── 스토리지 ──────────────────────────────────────────────────
  /** 워크스페이스 전체(평면) 목록 — 파일/폴더 각각 한 항목. `path` 는 예약(미사용). */
  workspaceTree(workflowId, _path) {
    return this.http.get(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/list`
    );
  }
  /** 텍스트 파일 미리보기. 바이너리/과대 파일은 서버가 415/413 으로 거부한다. */
  workspaceFile(workflowId, path) {
    const params = new URLSearchParams({ path: workspaceStoragePath(path) });
    return this.http.get(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/text?${params}`
    );
  }
  /** 원바이트 파일 읽기 — 이미지처럼 텍스트 API로 읽을 수 없는 미리보기용. */
  workspaceBinary(workflowId, path, purpose) {
    const encodedPath = workspaceStoragePath(path).split("/").map(encodeURIComponent).join("/");
    const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : "";
    return this.http.getBinary(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage-raw/${encodedPath}${query}`
    );
  }
  /** Image bytes land in this agent's durable workspace before chat execution. */
  workspaceUpload(workflowId, bytes, filename, mimeType, interactionId, attachmentId) {
    const form = new FormData();
    const owned = new Uint8Array(bytes);
    form.append("file", new Blob([owned.buffer], { type: mimeType }), filename);
    return this.http.upload(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/upload?subdir=uploads&purpose=chat_attachment&interaction_id=${encodeURIComponent(interactionId)}&attachment_id=${encodeURIComponent(attachmentId)}`,
      form,
      { timeoutMs: 3e5 }
    );
  }
};

// ../xgen-connector/src/core/agents.ts
function mapAgent(r) {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    nodeCount: r.node_count ?? 0,
    isShared: !!r.is_shared,
    isDeployed: !!r.is_deployed,
    isCompleted: !!r.is_completed,
    workflowType: r.workflow_type ?? "canvas",
    description: r.description ?? "",
    username: r.username ?? "",
    fullName: r.full_name ?? "",
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
    hasAgentGeny: !!r.has_agent_geny
  };
}
var AgentsApi = class {
  constructor(http) {
    this.http = http;
  }
  /** Paged agent list matching the UI grid (default page_size 24). */
  async list(query = {}) {
    const params = new URLSearchParams();
    params.set("page", String(query.page ?? 1));
    params.set("page_size", String(query.pageSize ?? 24));
    if (query.search) params.set("search", query.search);
    if (query.status) params.set("status", query.status);
    if (query.owner) params.set("owner", query.owner);
    if (query.includeHarness) params.set("include_harness", "true");
    const res = await this.http.get(`/api/agentflow/list/detail?${params}`);
    const raw = res.items ?? res.workflows ?? [];
    return {
      items: raw.map(mapAgent),
      pagination: {
        page: res.pagination?.page ?? query.page ?? 1,
        pageSize: res.pagination?.page_size ?? query.pageSize ?? 24,
        totalCount: res.pagination?.total_count ?? raw.length,
        totalPages: res.pagination?.total_pages ?? 1
      }
    };
  }
  /**
   * Fetch every page and return the full agent list. Convenience for small
   * accounts / pickers; bounded by `maxPages` to avoid runaway loops.
   */
  async listAll(query = {}, maxPages = 50) {
    const first = await this.list({ ...query, page: 1 });
    const all = [...first.items];
    for (let page = 2; page <= Math.min(first.pagination.totalPages, maxPages); page++) {
      const next = await this.list({ ...query, page });
      all.push(...next.items);
    }
    return all;
  }
};

// ../xgen-connector/src/core/hash.ts
async function subtle() {
  const g = globalThis.crypto;
  if (g?.subtle) return g.subtle;
  const { webcrypto } = await import("node:crypto");
  return webcrypto.subtle;
}
async function sha256Hex(plaintext) {
  const data = new TextEncoder().encode(plaintext);
  const digest = await (await subtle()).digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ../xgen-connector/src/core/auth.ts
var AuthApi = class {
  constructor(http) {
    this.http = http;
  }
  /**
   * Log in with email + plaintext password. The password is SHA-256-hex hashed
   * before sending (the gateway compares the hash verbatim). Returns tokens +
   * identity. Throws ApiError on bad credentials / locked / inactive account.
   */
  async login(email, password) {
    const passwordHash = await sha256Hex(password);
    const res = await this.http.post(
      "/api/auth/login",
      { email, password: passwordHash, token: null }
      // login itself must not trigger the onAuthFailure hook
    );
    if (!res.success || !res.access_token) {
      throw new Error(res.message || "\uB85C\uADF8\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
    }
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? void 0,
      tokenType: res.token_type ?? "bearer",
      userId: res.user_id ?? "",
      username: res.username ?? email
    };
  }
  /** SSO login with a pre-obtained token. */
  async loginWithToken(ssoToken) {
    const res = await this.http.post("/api/auth/login", {
      token: ssoToken
    });
    if (!res.success || !res.access_token) {
      throw new Error(res.message || "SSO \uB85C\uADF8\uC778\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
    }
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? void 0,
      tokenType: res.token_type ?? "bearer",
      userId: res.user_id ?? "",
      username: res.username ?? ""
    };
  }
  /**
   * Validate the access token and return the current user + permissions. If the
   * access token is expired and a refresh token is supplied, the gateway may
   * return a rotated access token in `newAccessToken`.
   */
  async validate(accessToken, refreshToken) {
    const res = await this.http.post(
      "/api/auth/validate-token",
      { token: accessToken, refresh_token: refreshToken },
      { auth: false }
    );
    if (!res.valid) return { user: null, newAccessToken: res.new_access_token ?? void 0 };
    return {
      user: {
        userId: res.user_id ?? "",
        username: res.username ?? "",
        isSuperuser: !!res.is_superuser,
        roles: res.roles ?? [],
        permissions: res.permissions ?? []
      },
      newAccessToken: res.new_access_token ?? void 0
    };
  }
  /** Exchange a refresh token for a fresh access token. */
  async refresh(refreshToken) {
    const res = await this.http.post(
      "/api/auth/refresh",
      { refresh_token: refreshToken },
      { auth: false }
    );
    return res.success ? res.access_token : null;
  }
  async logout(accessToken) {
    try {
      await this.http.post("/api/auth/logout", { token: accessToken }, { timeoutMs: 8e3 });
    } catch {
    }
  }
  /** Server session policy (timeouts) — useful for a refresh scheduler. */
  async sessionConfig() {
    return this.http.get("/api/auth/session-config", { timeoutMs: 8e3 });
  }
};

// ../xgen-connector/src/core/avatars.ts
var AvatarsApi = class {
  constructor(http) {
    this.http = http;
  }
  /** Upload one avatar file (model zip or photo) → parsed descriptor. */
  async uploadAsset(bytes, filename) {
    const form = new FormData();
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    form.append("file", new Blob([buf]), filename);
    const res = await this.http.upload("/api/storage/avatar/upload", form);
    return res.avatar;
  }
  /** Delete an avatar's stored asset tree. */
  async deleteAsset(avatarId) {
    await this.http.json("DELETE", `/api/storage/avatar/${avatarId}`);
  }
  // ── store ──────────────────────────────────────────────────────
  async storeList() {
    const res = await this.http.get("/api/storage/avatar/store/list");
    return res.items || [];
  }
  async storePublish(descriptor, name, description = "") {
    const res = await this.http.post("/api/storage/avatar/store/publish", {
      descriptor,
      name,
      description
    });
    return res.item;
  }
  /** Add a store avatar to my assets → descriptor with a fresh local id. */
  async storeDownload(storeId) {
    const res = await this.http.post(`/api/storage/avatar/store/${storeId}/download`, {});
    return res.avatar;
  }
  async storeRate(storeId, stars) {
    const res = await this.http.post(`/api/storage/avatar/store/${storeId}/rate`, { stars });
    return res.item;
  }
  async storeUnpublish(storeId) {
    await this.http.json("DELETE", `/api/storage/avatar/store/${storeId}`);
  }
};

// ../xgen-connector/src/core/sse.ts
var SseParser = class {
  buffer = "";
  /** Feed a raw chunk; returns any complete frames it produced. */
  push(chunk) {
    this.buffer += chunk;
    const frames = [];
    let sep;
    while ((sep = this.nextSeparator()) !== -1) {
      const rawFrame = this.buffer.slice(0, sep.valueOf());
      this.buffer = this.buffer.slice(this.advanceAfterSeparator(sep));
      const frame = this.parseFrame(rawFrame);
      if (frame) frames.push(frame);
    }
    return frames;
  }
  /** Flush any trailing frame not terminated by a blank line (stream end). */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const frame = this.parseFrame(rest);
    return frame ? [frame] : [];
  }
  nextSeparator() {
    const a = this.buffer.indexOf("\n\n");
    const b = this.buffer.indexOf("\r\n\r\n");
    if (a === -1) return b;
    if (b === -1) return a;
    return Math.min(a, b);
  }
  advanceAfterSeparator(sep) {
    return this.buffer.startsWith("\r\n\r\n", sep) ? sep + 4 : sep + 2;
  }
  parseFrame(raw) {
    let event;
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0 && event === void 0) return null;
    return { event, data: dataLines.join("\n") };
  }
};

// ../xgen-connector/src/core/chat.ts
function toRequestBody(req) {
  return {
    workflow_name: req.workflowName,
    workflow_id: req.workflowId,
    input_data: req.input,
    interaction_id: req.interactionId,
    selected_collections: req.selectedCollections ?? [],
    selected_files: req.selectedFiles ?? [],
    include_logs: req.includeLogs ?? true,
    include_node_status: req.includeNodeStatus ?? true,
    include_tool_events: req.includeToolEvents ?? true,
    response_format: "stream",
    // 대화 출처 — 이 턴이 데스크톱 커넥터에서 왔음을 서버에 알린다. 서버는 이
    // 값이 "connector" 인 실행에만 커넥터 호스팅 로컬 도구(이 PC 의 파일/셸/
    // 브라우저/오피스 조작)를 에이전트에 노출·실행한다. 웹 채팅은 이 필드를
    // 보내지 않으므로, 같은 사용자가 커넥터를 켜 둔 상태로 웹에서 대화해도
    // 로컬 도구는 절대 작동하지 않는다.
    client_surface: "connector",
    // 실행 환경 지시 — 로컬 실행 v2 폴백 턴은 'sandbox'(서버 sandbox 강제; 커넥터
    // 로컬 워크스페이스를 원격 조작하는 중간 형태를 쓰지 않는다). 없으면 생략(auto).
    ...req.executionTarget ? { execution_target: req.executionTarget } : {}
  };
}
function mapToolEvent(d) {
  return {
    eventType: String(d.event_type ?? d.type ?? "tool"),
    toolName: d.tool_name,
    toolInput: d.tool_input,
    result: d.result,
    resultLength: d.result_length,
    error: d.error,
    citations: d.citations,
    runId: d.run_id,
    indicator: d.indicator,
    durationMs: d.duration_ms,
    timestamp: d.timestamp
  };
}
function parseData(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
function frameToChatEvent(frameEvent, rawData) {
  const d = parseData(rawData);
  switch (frameEvent) {
    case "tool":
      return d ? { kind: "tool", event: mapToolEvent(d) } : null;
    case "node_status":
      return d ? {
        kind: "node_status",
        event: { nodeId: String(d.node_id ?? ""), status: String(d.status ?? ""), ...d }
      } : null;
    case "log":
      return { kind: "log", data: d ?? rawData };
    case "execution_io":
      return d ? { kind: "execution_io", executionIoId: Number(d.execution_io_id ?? 0) } : null;
    case "download_artifact":
      return d ? { kind: "download", data: d } : null;
    case "a2ui_command":
      return d ? { kind: "ui_command", surface: "a2ui", command: d } : null;
    case "floui_command":
      return d ? { kind: "ui_command", surface: "floui", command: d } : null;
    case "quota_warning":
      return d ? { kind: "quota", level: "warning", data: d } : null;
    case "quota_exceeded":
      return d ? { kind: "quota", level: "exceeded", data: d } : null;
    case "execution_suspended":
      return { kind: "error", detail: "\uC6CC\uD06C\uD50C\uB85C\uC6B0\uAC00 \uAD00\uB9AC\uC790\uC5D0 \uC758\uD574 \uC77C\uC2DC \uC911\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4." };
    case void 0:
    case "":
    case "message":
      break;
    // default frame — dispatch on the JSON `type` below
    default:
      return null;
  }
  if (!d) return null;
  switch (d.type) {
    case "data":
      return { kind: "text", content: String(d.content ?? "") };
    case "summary": {
      const data = d.data ?? {};
      const outputs = data.outputs ?? [];
      return { kind: "summary", text: outputs.map(String).join(""), data };
    }
    case "end":
      return { kind: "end" };
    case "error":
      return { kind: "error", detail: String(d.detail ?? d.error ?? "unknown error") };
    // Some tool/agent frames arrive as bare `data:` JSON (no event: line).
    case "tool_call":
    case "tool_start":
    case "tool_result":
    case "tool_error":
      return { kind: "tool", event: mapToolEvent(d) };
    default:
      return null;
  }
}
var ChatApi = class {
  constructor(http) {
    this.http = http;
  }
  /**
   * Stream a chat turn. Yields normalized ChatEvents until the terminal `end`
   * (or the stream closes). Pass an AbortSignal to cancel mid-stream.
   */
  async *stream(req, signal) {
    const res = await this.http.stream(
      "/api/agentflow/execute/based-id/stream",
      toRequestBody(req),
      signal
    );
    const body = res.body;
    if (!body) throw new Error("\uC2A4\uD2B8\uB9BC \uC751\uB2F5 \uBCF8\uBB38\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        const frames = parser.push(decoder.decode(value, { stream: true }));
        for (const f of frames) {
          const ev = frameToChatEvent(f.event, f.data);
          if (ev) {
            yield ev;
            if (ev.kind === "end") return;
          }
        }
      }
      for (const f of parser.flush()) {
        const ev = frameToChatEvent(f.event, f.data);
        if (ev) yield ev;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
      }
    }
  }
  /**
   * Convenience: run a turn to completion and return the accumulated assistant
   * text plus collected tool events. Ignores intermediate UI/log frames.
   */
  async complete(req, onEvent, signal) {
    let text = "";
    let summary = "";
    const tools = [];
    let error;
    let executionIoId;
    for await (const e of this.stream(req, signal)) {
      onEvent?.(e);
      if (e.kind === "text") text += e.content;
      else if (e.kind === "summary") summary = e.text;
      else if (e.kind === "tool") tools.push(e.event);
      else if (e.kind === "execution_io") executionIoId = e.executionIoId;
      else if (e.kind === "error") error = e.detail;
    }
    return { text: text || summary, tools, error, executionIoId };
  }
};

// ../xgen-connector/src/core/browser.ts
var BROWSER_CONTEXT_START = "<xgen_browser_context>";
var BROWSER_CONTEXT_END = "</xgen_browser_context>";
function stripBrowserContext(text) {
  if (typeof text !== "string" || !text.startsWith(BROWSER_CONTEXT_START)) return text;
  const end = text.indexOf(BROWSER_CONTEXT_END);
  if (end < 0) return text;
  return text.slice(end + BROWSER_CONTEXT_END.length).replace(/^\r?\n/, "");
}

// ../xgen-connector/src/core/history.ts
function toHistoryAttachments(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item;
    const path = String(raw.minioPath ?? raw.filePath ?? raw.object_name ?? raw.path ?? "").trim();
    if (!path) continue;
    const name = String(raw.name ?? raw.original_name ?? path.split("/").pop() ?? "attachment");
    const contentType = String(raw.contentType ?? raw.content_type ?? "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
    const type = raw.type === "picture" || contentType.startsWith("image/") ? "picture" : "file";
    const numericSize = Number(raw.size ?? raw.file_size ?? 0);
    result.push({
      id: typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : void 0,
      name,
      size: Number.isFinite(numericSize) && numericSize > 0 ? numericSize : 0,
      contentType,
      type,
      path,
      bucket: String(raw.bucket ?? "")
    });
  }
  return result;
}
function toDisplayText(v) {
  if (v == null) return "";
  if (typeof v === "string") return stripBrowserContext(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((b) => {
      if (b == null) return "";
      if (typeof b === "string") return b;
      if (typeof b === "object") {
        const o = b;
        if (typeof o.text === "string") return o.text;
        const t = typeof o.type === "string" ? o.type : "";
        if (t.includes("image")) return "[\uC774\uBBF8\uC9C0]";
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      }
      return String(b);
    });
    return stripBrowserContext(parts.filter(Boolean).join("\n"));
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
var HistoryApi = class {
  constructor(http) {
    this.http = http;
  }
  /** Ordered turns of one conversation. */
  async turns(workflowId, interactionId, workflowName) {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    if (workflowName) params.set("workflow_name", workflowName);
    const res = await this.http.get(`/api/chat/io-logs?${params}`);
    return (res.in_out_logs ?? []).map((r) => ({
      logId: r.log_id,
      ioId: r.io_id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      input: toDisplayText(r.input_data),
      output: toDisplayText(r.output_data),
      attachments: toHistoryAttachments(r.attachments),
      updatedAt: r.updated_at
    }));
  }
  /** Past conversations (interactions) for the sidebar. */
  async conversations() {
    const res = await this.http.get("/api/interaction/list");
    return (res.execution_meta_list ?? []).map((r) => ({
      id: r.id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      interactionCount: r.interaction_count ?? 0,
      metadata: r.metadata ?? {},
      createdAt: r.created_at ?? "",
      updatedAt: r.updated_at ?? ""
    }));
  }
};

// ../xgen-connector/src/core/preferences.ts
var PreferencesApi = class {
  constructor(http) {
    this.http = http;
  }
  /** GET /api/admin/user → preferences.avatar.
   *
   *  THROWS on failure (network / 401 / not-yet-authenticated) rather than
   *  returning an empty config: at startup the overlay's fetch can beat the
   *  main window's session restore, and masking that as `{enabled:false}` made
   *  the avatar look permanently absent. Propagating lets the caller retry until
   *  the client is authed. A genuinely empty config (feature off) still returns
   *  normally. */
  async getAvatarConfig() {
    const res = await this.http.get("/api/admin/user");
    if (!res || !res.user) {
      throw new Error("avatar config: no authenticated profile");
    }
    let prefs = res.user.preferences ?? {};
    if (typeof prefs === "string") {
      try {
        prefs = JSON.parse(prefs);
      } catch {
        prefs = {};
      }
    }
    const raw = prefs?.avatar ?? {};
    return {
      enabled: !!raw.enabled,
      defaultAvatarId: typeof raw.defaultAvatarId === "string" ? raw.defaultAvatarId : null,
      avatars: Array.isArray(raw.avatars) ? raw.avatars : []
    };
  }
  /** Persist the whole avatar config (PUT shallow-merges preferences top-level,
   *  so sending {avatar} replaces just that key). Used when the overlay adjusts
   *  the avatar's scale/position in-place. */
  async saveAvatarConfig(config) {
    await this.http.put("/api/admin/user", { preferences: { avatar: config } });
  }
  /** Read-modify-write: 서버의 CURRENT config 를 읽어 최소 패치만 적용한다.
   *  화면에 캐시된 스냅샷 전체를 저장하면 그 사이의 변경(선택 등)을 조용히
   *  되돌린다 — 모든 부분 수정은 반드시 이 경로를 쓴다. */
  async mutateAvatarConfig(mutate) {
    const cfg = await this.getAvatarConfig();
    const next = mutate(cfg);
    await this.saveAvatarConfig(next);
    return next;
  }
  /** Persist ONE avatar's scale/position (read-modify-write). */
  async saveAvatarTransform(avatarId, tf) {
    await this.mutateAvatarConfig((cfg) => ({
      ...cfg,
      avatars: cfg.avatars.map(
        (a) => a.id === avatarId ? { ...a, scale: tf.scale, position: tf.position } : a
      )
    }));
  }
  setAvatarEnabled(enabled) {
    return this.mutateAvatarConfig((c) => ({ ...c, enabled }));
  }
  selectAvatar(id) {
    return this.mutateAvatarConfig((c) => ({ ...c, defaultAvatarId: id }));
  }
  renameAvatar(id, name) {
    return this.mutateAvatarConfig((c) => ({
      ...c,
      avatars: c.avatars.map((a) => a.id === id ? { ...a, name } : a)
    }));
  }
  /** Add an uploaded/downloaded descriptor (optionally renamed); first avatar
   *  becomes the selection. */
  addAvatar(descriptor, name) {
    return this.mutateAvatarConfig((c) => ({
      ...c,
      avatars: [...c.avatars, { ...descriptor, name: (name ?? descriptor.name) || descriptor.name }],
      defaultAvatarId: c.defaultAvatarId ?? descriptor.id
    }));
  }
  removeAvatar(id) {
    return this.mutateAvatarConfig((c) => {
      const remaining = c.avatars.filter((a) => a.id !== id);
      return {
        ...c,
        avatars: remaining,
        defaultAvatarId: c.defaultAvatarId === id ? remaining[0]?.id ?? null : c.defaultAvatarId
      };
    });
  }
};

// ../xgen-connector/src/core/ssh.ts
var BASE = "/api/agentflow/user-ssh";
var SshApi = class {
  constructor(http) {
    this.http = http;
  }
  getConfig() {
    return this.http.get(`${BASE}/config`);
  }
  /** Master switch only — the server list survives being turned off. */
  setEnabled(enabled) {
    return this.http.put(`${BASE}/config`, { enabled });
  }
  createServer(input) {
    return this.http.post(`${BASE}/servers`, input);
  }
  /** Partial update. Renaming also rewrites this server out of others' jump paths. */
  updateServer(name, input) {
    return this.http.put(`${BASE}/servers/${encodeURIComponent(name)}`, input);
  }
  /** Refused (400) while another server still lists it as a jump host. */
  deleteServer(name) {
    return this.http.del(`${BASE}/servers/${encodeURIComponent(name)}`);
  }
  /**
   * Dial it for real, through the jump path.
   *
   * Works regardless of the master switch — you must be able to check a server
   * *before* turning the feature on, otherwise the only order available is
   * "switch it on and hope".
   *
   * The connection is opened by the XGEN server, not this machine: the agent
   * runs there, so that is the only reachability that matters.
   */
  testServer(name) {
    return this.http.post(
      `${BASE}/servers/${encodeURIComponent(name)}/test`,
      {},
      // A three-hop chain can legitimately take a while; the default JSON
      // timeout would report a failure the server never saw.
      { timeoutMs: 7e4 }
    );
  }
};

// ../xgen-connector/src/core/teams.ts
var str = (v, fallback = "") => typeof v === "string" ? v : v === null || v === void 0 ? fallback : String(v);
var num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
function normalizeRouterMode(v) {
  const raw = str(v, "hybrid");
  if (raw === "chat" || raw === "manual" || raw === "hybrid" || raw === "auto") return raw;
  return "hybrid";
}
function normalizeSenderType(v) {
  const raw = str(v, "user");
  if (raw === "agent" || raw === "router" || raw === "system") return raw;
  return "user";
}
function mapRoom(raw) {
  const r = raw ?? {};
  return {
    id: str(r.id),
    name: str(r.name, "\uC774\uB984 \uC5C6\uB294 \uB300\uD654"),
    description: str(r.description) || void 0,
    routerMode: normalizeRouterMode(r.router_mode),
    isDirect: Boolean(r.is_direct),
    createdAt: str(r.created_at),
    createdBy: num(r.created_by),
    lastMessageAt: str(r.last_message_at) || void 0
  };
}
function mapMember(raw) {
  const m = raw ?? {};
  const role = str(m.role, "member");
  return {
    userId: num(m.user_id),
    username: str(m.username) || `User-${num(m.user_id)}`,
    fullName: str(m.full_name) || str(m.name) || void 0,
    role: role === "owner" || role === "admin" ? role : "member",
    isOnline: Boolean(m.is_online),
    joinedAt: str(m.joined_at)
  };
}
function directRoomNameForViewer(room, members, viewerUserId) {
  if (!room.isDirect || !viewerUserId) return room.name;
  const other = members.find((member) => String(member.userId) !== viewerUserId);
  return other ? other.fullName || other.username || room.name : room.name;
}
function mapReactions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return void 0;
  return raw.map((item) => {
    const r = item ?? {};
    return {
      emoji: str(r.emoji),
      count: num(r.count),
      userIds: Array.isArray(r.user_ids) ? r.user_ids.map((x) => num(x)) : []
    };
  });
}
function mapAttachment(raw) {
  const a = raw ?? {};
  const extracted = str(a.extracted_text) || str(a.extractedText);
  return {
    id: str(a.id),
    filename: str(a.original_filename) || str(a.display_name) || str(a.name) || str(a.filename, "file"),
    mime: str(a.mime, "application/octet-stream"),
    size: num(a.size),
    storageKey: str(a.storage_key) || str(a.storageKey),
    extractedText: extracted || void 0,
    truncated: Boolean(a.truncated) || void 0
  };
}
function mapAttachments(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  if (arr.length === 0) return void 0;
  return arr.map((item) => {
    const { extractedText: _drop, ...meta } = mapAttachment(item);
    return meta;
  });
}
function senderName(raw, type, senderId) {
  const name = str(raw).trim();
  if (name) return name;
  if (type === "system") return "\uC2DC\uC2A4\uD15C";
  if (type === "agent") return "Agent";
  return senderId ? `User-${senderId}` : "\uC54C \uC218 \uC5C6\uC74C";
}
function mapMessage(raw) {
  const m = raw ?? {};
  const type = normalizeSenderType(m.sender_type);
  const senderId = str(m.sender_id);
  return {
    id: str(m.id),
    roomId: str(m.room_id),
    senderType: type,
    senderId,
    senderName: senderName(m.sender_name, type, senderId),
    content: str(m.content),
    createdAt: str(m.created_at),
    reactions: mapReactions(m.reactions),
    attachments: mapAttachments(m.attachments),
    replyToId: str(m.reply_to_id) || void 0,
    replyToSenderName: str(m.reply_to_sender_name) || void 0,
    replyToContent: str(m.reply_to_content) || void 0,
    isEdited: Boolean(m.is_edited),
    editedAt: str(m.edited_at) || void 0
  };
}
function safeMapMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  try {
    const mapped = mapMessage(raw);
    return mapped.id ? mapped : null;
  } catch {
    return null;
  }
}
var TEAMS_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
var TeamsApi = class {
  constructor(http) {
    this.http = http;
  }
  // ── 방 ───────────────────────────────────────────────────
  /** 내가 속한 방 전체. 최근 메시지 순 정렬은 호출자(렌더러 store)가 한다. */
  async listRooms(viewerUserId) {
    const res = await this.http.get("/api/teams/rooms/list");
    const rooms = (res.data ?? []).map(mapRoom);
    if (!viewerUserId) return rooms;
    return Promise.all(
      rooms.map(async (room) => {
        if (!room.isDirect) return room;
        try {
          const members = await this.listMembers(room.id);
          return { ...room, name: directRoomNameForViewer(room, members, viewerUserId) };
        } catch {
          return room;
        }
      })
    );
  }
  async getRoom(roomId) {
    const res = await this.http.get(
      `/api/teams/rooms/${encodeURIComponent(roomId)}`
    );
    return res.data ? mapRoom(res.data) : null;
  }
  async createRoom(opts) {
    const res = await this.http.post("/api/teams/rooms/create", {
      name: opts.name,
      description: opts.description ?? null,
      router_mode: opts.routerMode ?? "chat"
    });
    return mapRoom(res.data);
  }
  /**
   * 1:1 대화 — 이미 있으면 그 방을, 없으면 새로 만들어 돌려준다.
   * 서버가 `dm:u{min}:u{max}` 키로 중복을 막으므로 클라이언트가 찾을 필요가 없다.
   */
  async openDirectMessage(userId, username) {
    const res = await this.http.post(
      "/api/teams/rooms/dm/lookup-or-create",
      {
        target_type: "user",
        target_id: String(userId),
        target_name: username ?? null,
        target_description: null,
        target_color: null
      }
    );
    return mapRoom(res.data?.room);
  }
  /**
   * 방 정보 수정 (이름·설명). 서버는 **멤버 전원**에게 허용한다(방장 전용이 아니다).
   *
   * ⚠ 서버가 이 변경을 broadcast 하지 않는다 — 다른 클라이언트는 새로고침 전까지
   * 옛 이름을 본다. 우리 화면만 즉시 갱신할 수 있다.
   */
  async updateRoom(roomId, patch) {
    const res = await this.http.put(
      `/api/teams/rooms/${encodeURIComponent(roomId)}`,
      {
        // 서버는 null 을 "변경 없음" 으로 읽는다. 보내지 않을 값은 넣지 않는다.
        ...patch.name !== void 0 ? { name: patch.name } : {},
        ...patch.description !== void 0 ? { description: patch.description } : {}
      }
    );
    return res.data ? mapRoom(res.data) : null;
  }
  /** 마지막 멤버의 나가기를 빈 방 정리로 바꿀 때만 쓰는 내부 경로. */
  async deleteRoom(roomId) {
    await this.http.del(`/api/teams/rooms/${encodeURIComponent(roomId)}`);
  }
  /**
   * 사용자가 보는 방 종료 동작은 항상 "나가기" 하나다. 마지막 멤버라면 빈 방을
   * 남기지 않도록 내부적으로 방을 정리한다. 멤버 조회나 정리 권한이 없는 구버전
   * 서버에서는 기존 leave API 로 폴백해 사용자가 방에 갇히지 않게 한다.
   */
  async leaveRoom(roomId) {
    let lastMember = false;
    try {
      lastMember = (await this.listMembers(roomId)).length <= 1;
    } catch {
    }
    if (lastMember) {
      try {
        await this.deleteRoom(roomId);
        return;
      } catch {
      }
    }
    await this.http.post(`/api/teams/rooms/${encodeURIComponent(roomId)}/leave`);
  }
  // ── 멤버 ─────────────────────────────────────────────────
  async listMembers(roomId) {
    const res = await this.http.get(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/members`
    );
    return (res.data ?? []).map(mapMember);
  }
  async addMember(roomId, userId) {
    await this.http.post(`/api/teams/rooms/${encodeURIComponent(roomId)}/members`, {
      user_id: userId,
      role: "member",
      force_override: false
    });
  }
  /** 초대 대상 검색. 빈 질의는 서버를 부르지 않는다. */
  async searchUsers(query, limit = 20) {
    const q = query.trim();
    if (!q) return [];
    const params = new URLSearchParams({ q, limit: String(limit) });
    const res = await this.http.get(`/api/teams/users/search?${params}`);
    return (res.data ?? []).map((item) => {
      const u = item ?? {};
      const id = num(u.id);
      return {
        id,
        username: str(u.username) || str(u.user_name) || `user_${id}`,
        fullName: str(u.full_name) || str(u.name) || void 0,
        email: str(u.email) || void 0
      };
    });
  }
  // ── 메시지 ───────────────────────────────────────────────
  /**
   * 메시지 조회 (커서 페이지네이션). `before` 는 더 과거를 부르는 커서이고,
   * 서버는 **최신순**으로 돌려주므로 시간 오름차순 정렬은 호출자가 한다
   * (렌더러 store 의 mergeMessages 가 담당).
   */
  async listMessages(roomId, opts) {
    const params = new URLSearchParams({ limit: String(opts?.limit ?? 50) });
    if (opts?.before) params.set("before", opts.before);
    const res = await this.http.get(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages?${params}`
    );
    return (res.data ?? []).flatMap((raw) => {
      const mapped = safeMapMessage(raw);
      return mapped ? [mapped] : [];
    });
  }
  /**
   * 메시지 전송. 응답의 `data.message` 가 서버가 확정한 메시지다 —
   * 낙관적으로 그려 둔 임시 메시지를 이것으로 교체한다.
   *
   * 라우팅 결과(`data.routing`)는 에이전트 실행용이라 1차 범위에서는 버린다.
   * router_mode='chat' 방에서는 서버가 애초에 에이전트를 부르지 않는다.
   */
  async sendMessage(roomId, content, opts) {
    const res = await this.http.post(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages`,
      {
        content,
        mentioned_agent_ids: null,
        attachments: opts?.attachments?.length ? opts.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          storage_key: a.storageKey,
          // 업로드 응답을 그대로 되돌려준다 — null 로 덮으면 첨부 내용이 사라진다.
          extracted_text: a.extractedText ?? null,
          truncated: a.truncated ?? false
        })) : null,
        discussion_max_rounds: null,
        reply_to_id: opts?.replyToId ?? null
      }
    );
    const mapped = safeMapMessage(res.data?.message);
    if (!mapped) throw new Error("\uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0C8\uC9C0\uB9CC \uC11C\uBC84 \uC751\uB2F5\uC744 \uD574\uC11D\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    return mapped;
  }
  /** 본인 메시지 편집. 서버가 `message_updated` 를 broadcast 한다. */
  async editMessage(roomId, messageId, content) {
    const res = await this.http.patch(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      { content }
    );
    return safeMapMessage(res.data);
  }
  // ── 첨부 ─────────────────────────────────────────────────
  /**
   * 첨부 업로드 → 메타. 이 메타를 `sendMessage` 의 `attachments` 로 넘겨야
   * 실제로 메시지에 붙는다 (업로드만으로는 방에 나타나지 않는다).
   *
   * 서버가 같은 요청 안에서 문서 본문까지 추출해 `extracted_text` 로 돌려주므로
   * 응답을 통째로 들고 다닌다 — 그래야 나중에 에이전트가 그 파일의 내용을 본다.
   * 상한은 서버 기준 50MB, 허용 확장자는 `attachment_controller.ALLOWED_EXTENSIONS`.
   */
  async uploadAttachment(roomId, bytes, filename, mime) {
    const form = new FormData();
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    form.append("file", new Blob([buf], mime ? { type: mime } : void 0), filename);
    const res = await this.http.upload(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/attachments/upload`,
      form,
      // 50MB 까지 받는 엔드포인트라 기본 타임아웃으로는 큰 파일이 끊긴다.
      { timeoutMs: 3e5 }
    );
    const mapped = mapAttachment(res.data);
    if (!mapped.storageKey) throw new Error("\uCCA8\uBD80\uB97C \uC62C\uB838\uC9C0\uB9CC \uC11C\uBC84 \uC751\uB2F5\uC744 \uD574\uC11D\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    return { ...mapped, filename: mapped.filename || filename };
  }
  /**
   * 첨부 원본 바이트. 다운로드 주소에 `filename` 을 함께 넘겨야 서버가
   * Content-Disposition 에 실제 이름을 실어 준다 (안 넘기면 `att-xxx.docx` 로 떨어진다).
   */
  async downloadAttachment(roomId, attachment) {
    const params = attachment.filename ? `?filename=${encodeURIComponent(attachment.filename)}` : "";
    const { bytes } = await this.http.getBinary(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(
        attachment.storageKey
      )}${params}`
    );
    return bytes;
  }
  /**
   * 이모지 리액션 토글. 서버가 집계 전체를 돌려주고 동시에 `reaction_update` 를
   * broadcast 하므로, 반환값은 즉시 반영용 보조다.
   */
  async toggleReaction(roomId, messageId, emoji) {
    const res = await this.http.post(
      `/api/teams/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      { emoji }
    );
    return mapReactions(res.data?.reactions) ?? [];
  }
};

// ../xgen-connector/src/core/voice.ts
function filenameFor(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("ogg")) return "audio.ogg";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "audio.m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  return "audio.webm";
}
var VoiceApi = class {
  constructor(http) {
    this.http = http;
  }
  /** GET /api/admin/user → { stt: preferences.stt|null, tts: preferences.tts|null }.
   *  UI hints only — no secrets. THROWS when not yet authenticated (mirrors
   *  PreferencesApi.getAvatarConfig) so callers can retry rather than latch a
   *  false "voice off". */
  async getVoiceConfig() {
    const res = await this.http.get("/api/admin/user");
    if (!res || !res.user) {
      throw new Error("voice config: no authenticated profile");
    }
    let prefs = res.user.preferences ?? {};
    if (typeof prefs === "string") {
      try {
        prefs = JSON.parse(prefs);
      } catch {
        prefs = {};
      }
    }
    const p = prefs ?? {};
    const stt = p.stt && typeof p.stt === "object" ? p.stt : null;
    const tts = p.tts && typeof p.tts === "object" ? p.tts : null;
    return { stt, tts };
  }
  /** POST an audio clip → transcript text. Uses the caller's saved STT
   *  preference server-side unless `language` overrides it. */
  async transcribe(blob, language) {
    const form = new FormData();
    form.append("file", blob, filenameFor(blob.type));
    if (language) form.append("language", language);
    const res = await this.http.upload("/api/audio/stt/transcribe", form);
    return res?.text ?? "";
  }
  /** POST text → synthesized audio Blob. Uses the caller's active TTS profile
   *  server-side unless `opts` overrides it. */
  async speak(text, opts) {
    const { bytes, contentType } = await this.http.postBinary(
      "/api/audio/tts/speak",
      { text, ...opts ?? {} },
      // Synthesis can take a few seconds for longer replies.
      { timeoutMs: 6e4 }
    );
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Blob([buf], { type: contentType || "audio/wav" });
  }
};

// ../xgen-connector/src/core/client.ts
var ApiError = class extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
};
var HttpClient = class {
  baseUrl;
  accessToken = null;
  fetchImpl;
  onAuthFailure;
  timeoutMs;
  constructor(opts) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.onAuthFailure = opts.onAuthFailure;
    this.timeoutMs = opts.timeoutMs ?? 3e4;
    if (!this.fetchImpl) {
      throw new Error("HttpClient: no fetch implementation available");
    }
  }
  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }
  getBaseUrl() {
    return this.baseUrl;
  }
  setToken(token) {
    this.accessToken = token;
  }
  url(path) {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
  headers(extra) {
    const h = { ...extra };
    if (this.accessToken) h["Authorization"] = `Bearer ${this.accessToken}`;
    return h;
  }
  /** GET/POST/… returning parsed JSON. Throws ApiError on non-2xx. */
  async json(method, path, body, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers({
          "Content-Type": "application/json",
          Accept: "application/json"
        }),
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed = void 0;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401 && opts?.auth !== false) this.onAuthFailure?.();
      throw new ApiError(res.status, `${method} ${path} \u2192 ${res.status}`, parsed);
    }
    return parsed;
  }
  get(path, opts) {
    return this.json("GET", path, void 0, opts);
  }
  /** Multipart upload (아바타 에셋 등). Content-Type 은 fetch 가 boundary 와
   *  함께 자동 설정하므로 지정하지 않는다. 대용량(모델 zip) 대비 긴 타임아웃. */
  async upload(path, form, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 12e4);
    let res;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers: this.headers({ Accept: "application/json" }),
        body: form,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed = void 0;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      throw new ApiError(res.status, `POST ${path} \u2192 ${res.status}`, parsed);
    }
    return parsed;
  }
  post(path, body, opts) {
    return this.json("POST", path, body, opts);
  }
  /**
   * POST a JSON body and read the raw BINARY response (e.g. TTS audio bytes).
   * Returns the bytes plus the response `Content-Type` so the caller can wrap a
   * correctly-typed Blob (audio/wav|mpeg|ogg). Throws ApiError on non-2xx.
   */
  async postBinary(path, body, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Accept: "audio/*" }),
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `POST ${path} \u2192 ${res.status}`, text);
    }
    const ab = await res.arrayBuffer();
    return { bytes: new Uint8Array(ab), contentType: res.headers.get("content-type") ?? "" };
  }
  /**
   * GET a raw BINARY response (Teams 첨부 다운로드 등). `postBinary` 의 GET 짝.
   *
   * 파일명은 응답 헤더가 아니라 **호출자가 이미 아는 값**을 쓴다 —
   * Content-Disposition 의 RFC 5987 인코딩을 여기서 되풀이 파싱할 이유가 없고,
   * 서버도 우리가 쿼리로 넘긴 이름을 그대로 되돌려줄 뿐이다.
   */
  async getBinary(path, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 12e4);
    let res;
    try {
      res = await this.fetchImpl(this.url(path), {
        method: "GET",
        headers: this.headers({ Accept: "*/*" }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `GET ${path} \u2192 ${res.status}`, text);
    }
    const ab = await res.arrayBuffer();
    return { bytes: new Uint8Array(ab), contentType: res.headers.get("content-type") ?? "" };
  }
  put(path, body, opts) {
    return this.json("PUT", path, body, opts);
  }
  patch(path, body, opts) {
    return this.json("PATCH", path, body, opts);
  }
  /** `delete` is a reserved word in some call sites — keep the short alias. */
  del(path, opts) {
    return this.json("DELETE", path, void 0, opts);
  }
  /**
   * Open a raw streaming POST (for SSE). Returns the Response so the caller can
   * read `response.body` as a stream. Does NOT enforce the JSON timeout — SSE
   * connections are long-lived (the gateway allows 1h for `/stream` paths).
   */
  async stream(path, body, signal) {
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      }),
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      if (res.status === 401) this.onAuthFailure?.();
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `stream ${path} \u2192 ${res.status}`, text);
    }
    return res;
  }
};
function normalizeBaseUrl(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

// ../xgen-connector/src/core/index.ts
var XgenClient = class {
  http;
  auth;
  agents;
  chat;
  history;
  preferences;
  ssh;
  teams;
  avatars;
  voice;
  agentData;
  refreshToken;
  onTokensRotated;
  /** ensureFreshAuth 의 single-flight 가드 — 동시 401 들이 refresh 를 한 번만 태운다. */
  refreshing = null;
  user = null;
  constructor(opts) {
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      onAuthFailure: opts.onAuthFailure
    });
    if (opts.accessToken) this.http.setToken(opts.accessToken);
    this.refreshToken = opts.refreshToken;
    this.onTokensRotated = opts.onTokensRotated;
    this.auth = new AuthApi(this.http);
    this.agents = new AgentsApi(this.http);
    this.chat = new ChatApi(this.http);
    this.history = new HistoryApi(this.http);
    this.preferences = new PreferencesApi(this.http);
    this.ssh = new SshApi(this.http);
    this.teams = new TeamsApi(this.http);
    this.avatars = new AvatarsApi(this.http);
    this.voice = new VoiceApi(this.http);
    this.agentData = new AgentDataApi(this.http);
  }
  setBaseUrl(baseUrl) {
    this.http.setBaseUrl(baseUrl);
  }
  setTokens(accessToken, refreshToken) {
    this.http.setToken(accessToken);
    if (refreshToken !== void 0) this.refreshToken = refreshToken;
  }
  /** Log in and adopt the returned tokens. */
  async login(email, password) {
    return this.adoptLogin(await this.auth.login(email, password));
  }
  /** Adopt tokens returned by an external SSO bridge and resolve full identity. */
  async adoptLogin(res) {
    this.http.setToken(res.accessToken);
    this.refreshToken = res.refreshToken;
    this.onTokensRotated?.(res.accessToken, res.refreshToken);
    this.user = {
      userId: res.userId,
      username: res.username,
      isSuperuser: false,
      roles: [],
      permissions: []
    };
    try {
      const { user } = await this.auth.validate(res.accessToken, res.refreshToken);
      if (user) this.user = user;
    } catch {
    }
    return res;
  }
  /**
   * Validate the current session, rotating the access token if the gateway
   * returned a fresh one. Returns true if still/again authenticated.
   */
  async restore(accessToken, refreshToken) {
    return await this.restoreDetailed(accessToken, refreshToken) === "valid";
  }
  /**
   * restore() 의 판정 세분화 — 호출자가 토큰 폐기 여부를 올바르게 정할 수
   * 있게 한다 (geny-connector validateAndRefreshAuth 강건성 이식):
   *   'valid'   — 인증 성공 (토큰 회전 반영됨)
   *   'invalid' — 서버가 **응답으로** 거부 (토큰 폐기가 맞다)
   *   'network' — 서버 미응답/네트워크 오류 (토큰을 지우면 안 된다 — 일시
   *               장애 후 재시작에서 재로그인을 강요하게 된다)
   */
  async restoreDetailed(accessToken, refreshToken) {
    this.http.setToken(accessToken);
    this.refreshToken = refreshToken;
    let sawNetworkError = false;
    try {
      const { user, newAccessToken } = await this.auth.validate(accessToken, refreshToken);
      if (newAccessToken) {
        this.http.setToken(newAccessToken);
        this.onTokensRotated?.(newAccessToken, refreshToken);
      }
      if (user) {
        this.user = user;
        return "valid";
      }
    } catch {
      sawNetworkError = true;
    }
    if (refreshToken) {
      try {
        const fresh = await this.auth.refresh(refreshToken);
        if (fresh) {
          this.http.setToken(fresh);
          this.onTokensRotated?.(fresh, refreshToken);
          const { user } = await this.auth.validate(fresh, refreshToken);
          if (user) {
            this.user = user;
            return "valid";
          }
        }
        sawNetworkError = false;
      } catch {
        sawNetworkError = true;
      }
    }
    return sawNetworkError ? "network" : "invalid";
  }
  getAccessTokenAfterRotation() {
    return this.http.accessToken ?? "";
  }
  /**
   * 인증 실패(401/403)를 맞은 소비자가 부르는 **자가치유** 경로: refresh 토큰으로
   * 액세스 토큰을 회전시키고 새 토큰을 돌려준다. 실패(refresh 토큰 없음/거부)면
   * null — 그때는 진짜 재로그인 대상이다.
   *
   * single-flight: WS 브릿지·워크스페이스 동기화·HTTP 가 동시에 401 을 맞아도
   * refresh 는 한 번만 나간다 (게이트웨이는 refresh 마다 이전 세션을 지우므로,
   * 동시 refresh 는 서로의 새 토큰을 폐기하는 경쟁이 된다).
   *
   * ``fallbackRefreshToken`` — 인메모리에 refresh 토큰이 없을 때(재시작 직후 등)
   * 호스트가 keychain 값을 넘겨줄 수 있다.
   */
  async ensureFreshAuth(fallbackRefreshToken) {
    if (this.refreshing) return this.refreshing;
    const rt = this.refreshToken ?? fallbackRefreshToken;
    if (!rt) return null;
    this.refreshing = (async () => {
      try {
        const fresh = await this.auth.refresh(rt);
        if (!fresh) return null;
        this.http.setToken(fresh);
        this.refreshToken = rt;
        this.onTokensRotated?.(fresh, rt);
        return fresh;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
  /** The current refresh token, so the host can persist it (e.g. keychain). */
  getRefreshToken() {
    return this.refreshToken;
  }
  async logout() {
    const token = this.getAccessTokenAfterRotation();
    if (token) await this.auth.logout(token);
    this.http.setToken(null);
    this.refreshToken = void 0;
    this.user = null;
  }
};

// src/errors.ts
var DexError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "DexError";
  }
};
function isUnauthorized(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
function publicError(error) {
  if (error instanceof DexError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof ApiError) {
    return {
      code: `http_${error.status}`,
      message: error.message,
      details: error.body
    };
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return { code: "cancelled", message: "\uC694\uCCAD\uC774 \uCDE8\uC18C\uB418\uC5C8\uC2B5\uB2C8\uB2E4." };
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}

export {
  XgenClient,
  DexError,
  isUnauthorized,
  publicError
};
//# sourceMappingURL=chunk-GL6MYQ62.js.map
