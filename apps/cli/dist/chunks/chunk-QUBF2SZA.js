// src/xgen/client.ts
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
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.onAuthFailure = options.onAuthFailure;
    this.timeoutMs = options.timeoutMs ?? 3e4;
    if (!this.fetchImpl) throw new Error("\uD604\uC7AC Node.js \uB7F0\uD0C0\uC784\uC5D0\uC11C fetch\uB97C \uC0AC\uC6A9\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }
  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }
  setToken(token) {
    this.accessToken = token;
  }
  getToken() {
    return this.accessToken ?? "";
  }
  async json(method, path, body, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers({ "Content-Type": "application/json", Accept: "application/json" }),
        body: body === void 0 ? void 0 : JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      if (response.status === 401 && options?.auth !== false) this.onAuthFailure?.();
      throw new ApiError(response.status, `${method} ${path} \u2192 ${response.status}`, parsed);
    }
    return parsed;
  }
  get(path, options) {
    return this.json("GET", path, void 0, options);
  }
  post(path, body, options) {
    return this.json("POST", path, body, options);
  }
  async stream(path, body, signal) {
    const response = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      if (response.status === 401) this.onAuthFailure?.();
      const text = await response.text().catch(() => "");
      throw new ApiError(response.status, `stream ${path} \u2192 ${response.status}`, text);
    }
    return response;
  }
  url(path) {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
  headers(extra) {
    return this.accessToken ? { ...extra, Authorization: `Bearer ${this.accessToken}` } : { ...extra };
  }
};
function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

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
  HttpClient,
  DexError,
  isUnauthorized,
  publicError
};
//# sourceMappingURL=chunk-QUBF2SZA.js.map
