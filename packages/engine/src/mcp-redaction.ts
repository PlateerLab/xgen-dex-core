import type { McpServerSecrets } from './mcp-types';

const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';
const CIRCULAR = '[CIRCULAR]';
const BINARY = '[BINARY]';

export interface RedactionLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxStringChars?: number;
  maxTotalChars?: number;
}

/**
 * Redacts the exact secret values that were resolved for one MCP server while
 * also converting arbitrary SDK/tool output into a bounded JSON-safe value.
 * This is the single egress filter for WebSocket, renderer and runtime-log data.
 */
export class McpSecretRedactor {
  private readonly values: string[];

  constructor(secrets?: McpServerSecrets | null) {
    this.values = [...new Set([
      ...Object.values(secrets?.env ?? {}),
      ...Object.values(secrets?.headers ?? {}),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0))]
      .sort((a, b) => b.length - a.length);
  }

  text(input: unknown, maxChars = 8_192): string {
    let value = input instanceof Error ? input.message : String(input ?? '');
    for (const secret of this.values) value = value.split(secret).join(REDACTED);
    return value.length > maxChars ? `${value.slice(0, maxChars)}${TRUNCATED}` : value;
  }

  value(input: unknown, limits: RedactionLimits = {}): unknown {
    const maxDepth = limits.maxDepth ?? 12;
    const maxNodes = limits.maxNodes ?? 5_000;
    const maxStringChars = limits.maxStringChars ?? 64 * 1024;
    const maxTotalChars = limits.maxTotalChars ?? 512 * 1024;
    const seen = new WeakSet<object>();
    let nodes = 0;
    let chars = 0;

    const walk = (value: unknown, depth: number): unknown => {
      if (++nodes > maxNodes || depth > maxDepth || chars > maxTotalChars) return TRUNCATED;
      if (typeof value === 'string') {
        const redacted = this.text(value, maxStringChars);
        chars += redacted.length;
        return chars > maxTotalChars ? TRUNCATED : redacted;
      }
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'undefined') return null;
      if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
      if (value instanceof Error) {
        return { name: this.text(value.name, 128), message: this.text(value.message) };
      }
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return BINARY;
      if (typeof value !== 'object') return this.text(value);
      if (seen.has(value)) return CIRCULAR;
      seen.add(value);
      if (Array.isArray(value)) return value.map((entry) => walk(entry, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (nodes > maxNodes || chars > maxTotalChars) {
          out[TRUNCATED] = true;
          break;
        }
        out[this.text(key, 256)] = walk(entry, depth + 1);
      }
      return out;
    };
    return walk(input, 0);
  }
}

export function containsPlaintextSecrets(config: {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): boolean {
  return [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]
    .some((value) => typeof value === 'string' && value.length > 0);
}
