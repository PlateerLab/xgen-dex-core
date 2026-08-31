/**
 * MCP secret handling (G8a). Secrets in an MCP server config — stdio `env`
 * values (API tokens) and http/sse `headers` values (Authorization) — must NOT
 * be written to the plaintext connector.json. Instead we keep the KEY names in
 * config (so the UI can show structure) with the VALUES redacted, and store the
 * real values in the encrypted keychain (see keychain.ts `mcpSecretStore`).
 *
 * All functions here are pure and unit-tested; the async keychain/config wiring
 * lives in index.ts (save) and mcp-manager.ts (connect).
 */
import type { McpServerConfig } from './mcp-types';
import type { McpServerSecrets } from './mcp-types';

type Kv = Record<string, string>;

/** Keep keys, blank every value — the config-safe (non-secret) shape. */
export function redactKv(o?: Kv): Kv | undefined {
  if (!o) return undefined;
  const out: Kv = {};
  for (const k of Object.keys(o)) out[k] = '';
  return Object.keys(out).length ? out : undefined;
}

/** Merge UI input over stored secrets: a non-empty incoming value is a new/
 *  changed secret; an empty incoming value keeps the stored one. Keys absent
 *  from `incoming` are dropped (the user removed them). */
export function mergeSecretKv(stored?: Kv, incoming?: Kv): Kv | undefined {
  if (!incoming) return undefined;
  const out: Kv = {};
  for (const [k, v] of Object.entries(incoming)) {
    out[k] = typeof v === 'string' && v.length ? v : stored?.[k] ?? '';
  }
  return Object.keys(out).length ? out : undefined;
}

/** Resolve real values for connect/test. A NON-EMPTY config value wins — it is
 *  either a freshly-typed value (test-before-save) or pre-migration plaintext;
 *  an empty ('') config value is a redaction, so the stored secret is used. */
export function resolveSecretKv(configVals?: Kv, secretVals?: Kv): Kv | undefined {
  const keys = new Set([...Object.keys(configVals || {}), ...Object.keys(secretVals || {})]);
  if (!keys.size) return undefined;
  const out: Kv = {};
  for (const k of keys) {
    const cfg = configVals?.[k];
    const v = cfg && cfg.length ? cfg : secretVals?.[k] || '';
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface SplitResult {
  /** Config-safe copy (secret values redacted to ''). */
  redacted: McpServerConfig;
  /** Real secrets to persist in the keychain. */
  secrets: McpServerSecrets;
}

/** Split one server config into (config-safe, secrets), merging with previously
 *  stored secrets so unchanged (redacted) fields keep their stored values. */
export function splitServerSecrets(
  incoming: McpServerConfig,
  stored?: McpServerSecrets | null,
): SplitResult {
  const env = mergeSecretKv(stored?.env ?? undefined, incoming.env);
  const headers = mergeSecretKv(stored?.headers ?? undefined, incoming.headers);
  const redacted: McpServerConfig = { ...incoming };
  if (env) redacted.env = redactKv(env);
  else delete redacted.env;
  if (headers) redacted.headers = redactKv(headers);
  else delete redacted.headers;
  return { redacted, secrets: { env, headers } };
}

/** Rehydrate a config with real secret values for a live connect. */
export function withResolvedSecrets(cfg: McpServerConfig, secrets?: McpServerSecrets | null): McpServerConfig {
  const env = resolveSecretKv(cfg.env, secrets?.env ?? undefined);
  const headers = resolveSecretKv(cfg.headers, secrets?.headers ?? undefined);
  const out: McpServerConfig = { ...cfg };
  if (env) out.env = env;
  else delete out.env;
  if (headers) out.headers = headers;
  else delete out.headers;
  return out;
}
