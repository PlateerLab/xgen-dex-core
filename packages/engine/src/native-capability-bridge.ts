import { createHash } from 'node:crypto';
import type { NativeAgentCapabilitySocket } from './native-agent-socket';
import { NativeSocketInvalid, NativeSocketUnavailable } from './native-agent-socket';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const TOOL_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CONNECTION = /^conn_[A-Za-z0-9_-]{32}$/;
const EPOCH = /^epoch_[A-Za-z0-9_-]{32}$/;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;

export interface NativeCapabilityTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface NativeCapabilityConfirmation {
  requestId: string;
  server: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  expiresAt: number;
  argsSha256: string;
}

export type NativeCapabilityState = 'ready' | 'confirmation_required' | 'executing' | 'closed' | 'failed';

export interface NativeCapabilitySnapshot {
  state: NativeCapabilityState;
  confirmation: NativeCapabilityConfirmation | null;
}

export interface NativeCapabilityOptions {
  tools: readonly NativeCapabilityTool[];
  call(server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<unknown>;
  onChange(snapshot: NativeCapabilitySnapshot): void;
}

export interface NativeCapabilityController {
  snapshot(): NativeCapabilitySnapshot;
  confirm(requestId: string, confirmed: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface NativeCapabilityBridgeGuard {
  readonly accessExpiresAt: number;
  assertCurrent(): Promise<void>;
}

interface Descriptor {
  capabilityId: string;
  server: string;
  name: string;
  connectionId: string;
  epoch: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

interface Pending {
  readonly public: NativeCapabilityConfirmation;
  readonly requestId: string;
  readonly operation: 'mcp.call';
  readonly args: Readonly<Record<string, unknown>>;
  readonly argsCanonical: string;
  readonly capabilityId: string;
  readonly connectionId: string;
  readonly epoch: string;
  readonly nonce: string;
  confirmed: boolean;
  confirmationSent: boolean;
  dispatched: boolean;
  abort: AbortController | null;
  expiryTimer: NodeJS.Timeout | null;
  callTimer: NodeJS.Timeout | null;
}

function invalid(): never { throw new NativeSocketInvalid(); }

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) invalid();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) invalid();
  }
}

function cloneJson(value: unknown, depth = 0, rejectSchemaRefs = false): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) invalid();
    return value;
  }
  if (!value || typeof value !== 'object' || depth >= 32) invalid();
  if (Array.isArray(value)) {
    if (value.length > 2048) invalid();
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) invalid();
      result.push(cloneJson(value[index], depth + 1, rejectSchemaRefs));
    }
    return Object.freeze(result);
  }
  const raw = plain(value); const keys = Reflect.ownKeys(raw);
  if (keys.length > 2048 || keys.some((key) => typeof key !== 'string')) invalid();
  const out: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    if (rejectSchemaRefs && ['$ref', '$dynamicRef', '$id'].includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    Object.defineProperty(out, key, { value: cloneJson(descriptor.value, depth + 1, rejectSchemaRefs),
      enumerable: true, writable: true, configurable: true });
  }
  return Object.freeze(out);
}

function canonical(value: unknown, ascii = false): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') {
    const encoded = JSON.stringify(value);
    if (!ascii) return encoded;
    return encoded.replace(/[^\x00-\x7f]/gu, (character) => {
      const point = character.codePointAt(0)!;
      if (point <= 0xffff) return `\\u${point.toString(16).padStart(4, '0')}`;
      const adjusted = point - 0x10000;
      return `\\u${(0xd800 + (adjusted >> 10)).toString(16)}\\u${(0xdc00 + (adjusted & 0x3ff)).toString(16)}`;
    });
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ascii)).join(',')}]`;
  const raw = value as Record<string, unknown>;
  return `{${Object.keys(raw).sort().map((key) => `${canonical(key, ascii)}:${canonical(raw[key], ascii)}`).join(',')}}`;
}

/** Parse exact backend-produced JSON while rejecting duplicate object members. */
function parseClosedJson(text: string): unknown {
  let offset = 0;
  const string = (): string => {
    const start = offset++;
    let escaped = false;
    while (offset < text.length) {
      const code = text.charCodeAt(offset++);
      if (!escaped && code === 0x22) {
        try { return JSON.parse(text.slice(start, offset)) as string; } catch { invalid(); }
      }
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
    }
    invalid();
  };
  const value = (depth = 0): unknown => {
    if (depth >= 32 || offset >= text.length) invalid();
    const code = text.charCodeAt(offset);
    if (code === 0x22) return string();
    if (code === 0x7b) {
      offset++; const out: Record<string, unknown> = {}; const seen = new Set<string>();
      if (text.charCodeAt(offset) === 0x7d) { offset++; return out; }
      for (;;) {
        if (text.charCodeAt(offset) !== 0x22) invalid();
        const key = string(); if (seen.has(key)) invalid(); seen.add(key);
        if (text.charCodeAt(offset++) !== 0x3a) invalid();
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        const delimiter = text.charCodeAt(offset++);
        if (delimiter === 0x7d) return out;
        if (delimiter !== 0x2c) invalid();
      }
    }
    if (code === 0x5b) {
      offset++; const out: unknown[] = [];
      if (text.charCodeAt(offset) === 0x5d) { offset++; return out; }
      for (;;) {
        out.push(value(depth + 1));
        const delimiter = text.charCodeAt(offset++);
        if (delimiter === 0x5d) return out;
        if (delimiter !== 0x2c || out.length > 2048) invalid();
      }
    }
    for (const [raw, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(raw, offset)) { offset += raw.length; return parsed; }
    }
    const match = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) invalid(); offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) invalid();
    return number;
  };
  const result = value(); if (offset !== text.length) invalid(); return result;
}

function equalJson(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return Object.is(left, right);
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => equalJson(item, right[index]));
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalJson(a[key], b[key]));
}

function schemaMatches(instance: unknown, schema: unknown, depth = 0): boolean {
  if (schema === true) return true;
  if (schema === false || depth >= 32 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const rule = schema as Record<string, unknown>;
  const typeMatches = (type: string): boolean => type === 'null' ? instance === null
    : type === 'array' ? Array.isArray(instance)
    : type === 'object' ? Boolean(instance) && typeof instance === 'object' && !Array.isArray(instance)
    : type === 'string' ? typeof instance === 'string'
    : type === 'boolean' ? typeof instance === 'boolean'
    : type === 'integer' ? typeof instance === 'number' && Number.isInteger(instance)
    : type === 'number' ? typeof instance === 'number' && Number.isFinite(instance) : false;
  if (rule.type !== undefined) {
    if (typeof rule.type === 'string') { if (!typeMatches(rule.type)) return false; }
    else if (Array.isArray(rule.type) && rule.type.length > 0
      && rule.type.every((item) => typeof item === 'string')) {
      if (!(rule.type as string[]).some(typeMatches)) return false;
    } else return false;
  }
  if (rule.const !== undefined && !equalJson(instance, rule.const)) return false;
  if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.some((item) => equalJson(instance, item)))) return false;
  for (const [key, expectation] of [['allOf', 'all'], ['anyOf', 'any'], ['oneOf', 'one']] as const) {
    if (rule[key] === undefined) continue;
    if (!Array.isArray(rule[key]) || !(rule[key] as unknown[]).length) return false;
    const count = (rule[key] as unknown[]).filter((child) => schemaMatches(instance, child, depth + 1)).length;
    if ((expectation === 'all' && count !== (rule[key] as unknown[]).length)
      || (expectation === 'any' && count < 1) || (expectation === 'one' && count !== 1)) return false;
  }
  if (rule.not !== undefined && schemaMatches(instance, rule.not, depth + 1)) return false;
  if (rule.if !== undefined) {
    const branch = schemaMatches(instance, rule.if, depth + 1) ? rule.then : rule.else;
    if (branch !== undefined && !schemaMatches(instance, branch, depth + 1)) return false;
  }
  if (typeof instance === 'string') {
    const length = [...instance].length;
    if (rule.minLength !== undefined && (!Number.isSafeInteger(rule.minLength) || length < (rule.minLength as number))) return false;
    if (rule.maxLength !== undefined && (!Number.isSafeInteger(rule.maxLength) || length > (rule.maxLength as number))) return false;
    if (rule.pattern !== undefined) {
      if (typeof rule.pattern !== 'string' || rule.pattern.length > 512) return false;
      try { if (!new RegExp(rule.pattern, 'u').test(instance)) return false; } catch { return false; }
    }
  }
  if (typeof instance === 'number' && Number.isFinite(instance)) {
    if (rule.minimum !== undefined && (typeof rule.minimum !== 'number' || instance < rule.minimum)) return false;
    if (rule.maximum !== undefined && (typeof rule.maximum !== 'number' || instance > rule.maximum)) return false;
    if (rule.exclusiveMinimum !== undefined && (typeof rule.exclusiveMinimum !== 'number' || instance <= rule.exclusiveMinimum)) return false;
    if (rule.exclusiveMaximum !== undefined && (typeof rule.exclusiveMaximum !== 'number' || instance >= rule.exclusiveMaximum)) return false;
    if (rule.multipleOf !== undefined && (typeof rule.multipleOf !== 'number' || rule.multipleOf <= 0
      || Math.abs(instance / rule.multipleOf - Math.round(instance / rule.multipleOf)) > Number.EPSILON * 8)) return false;
  }
  if (Array.isArray(instance)) {
    if (rule.minItems !== undefined && (!Number.isSafeInteger(rule.minItems) || instance.length < (rule.minItems as number))) return false;
    if (rule.maxItems !== undefined && (!Number.isSafeInteger(rule.maxItems) || instance.length > (rule.maxItems as number))) return false;
    if (rule.uniqueItems === true && instance.some((item, index) => instance.slice(0, index).some((prior) => equalJson(item, prior)))) return false;
    if (rule.prefixItems !== undefined) {
      if (!Array.isArray(rule.prefixItems)) return false;
      for (let index = 0; index < Math.min(instance.length, rule.prefixItems.length); index++) {
        if (!schemaMatches(instance[index], rule.prefixItems[index], depth + 1)) return false;
      }
    }
    if (rule.items !== undefined) {
      const start = Array.isArray(rule.prefixItems) ? rule.prefixItems.length : 0;
      for (let index = start; index < instance.length; index++) if (!schemaMatches(instance[index], rule.items, depth + 1)) return false;
    }
    if (rule.contains !== undefined) {
      const count = instance.filter((item) => schemaMatches(item, rule.contains, depth + 1)).length;
      const minimum = rule.minContains === undefined ? 1 : rule.minContains;
      const maximum = rule.maxContains === undefined ? Number.MAX_SAFE_INTEGER : rule.maxContains;
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || count < (minimum as number) || count > (maximum as number)) return false;
    }
  }
  if (instance && typeof instance === 'object' && !Array.isArray(instance)) {
    const object = instance as Record<string, unknown>; const keys = Object.keys(object);
    if (rule.minProperties !== undefined && (!Number.isSafeInteger(rule.minProperties) || keys.length < (rule.minProperties as number))) return false;
    if (rule.maxProperties !== undefined && (!Number.isSafeInteger(rule.maxProperties) || keys.length > (rule.maxProperties as number))) return false;
    if (rule.required !== undefined && (!Array.isArray(rule.required) || rule.required.some((key) =>
      typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(object, key)))) return false;
    const properties = rule.properties === undefined ? {} : rule.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
    const patterns = rule.patternProperties === undefined ? {} : rule.patternProperties;
    if (!patterns || typeof patterns !== 'object' || Array.isArray(patterns)) return false;
    const compiled: Array<[RegExp, unknown]> = [];
    try {
      for (const [pattern, child] of Object.entries(patterns as Record<string, unknown>)) {
        if (pattern.length > 512) return false; compiled.push([new RegExp(pattern, 'u'), child]);
      }
    } catch { return false; }
    for (const key of keys) {
      const hasDirect = Object.prototype.hasOwnProperty.call(properties, key);
      const direct = hasDirect ? (properties as Record<string, unknown>)[key] : undefined;
      if (hasDirect && !schemaMatches(object[key], direct, depth + 1)) return false;
      const matching = compiled.filter(([pattern]) => pattern.test(key));
      if (matching.some(([, child]) => !schemaMatches(object[key], child, depth + 1))) return false;
      if (!hasDirect && matching.length === 0 && rule.additionalProperties !== undefined
        && !schemaMatches(object[key], rule.additionalProperties, depth + 1)) return false;
    }
    if (rule.dependentRequired !== undefined) {
      if (!rule.dependentRequired || typeof rule.dependentRequired !== 'object' || Array.isArray(rule.dependentRequired)) return false;
      for (const [key, required] of Object.entries(rule.dependentRequired as Record<string, unknown>)) {
        if (Object.prototype.hasOwnProperty.call(object, key)
          && (!Array.isArray(required) || required.some((child) => typeof child !== 'string'
            || !Object.prototype.hasOwnProperty.call(object, child)))) return false;
      }
    }
    if (rule.dependentSchemas !== undefined) {
      if (!rule.dependentSchemas || typeof rule.dependentSchemas !== 'object' || Array.isArray(rule.dependentSchemas)) return false;
      for (const [key, child] of Object.entries(rule.dependentSchemas as Record<string, unknown>)) {
        if (Object.prototype.hasOwnProperty.call(object, key) && !schemaMatches(instance, child, depth + 1)) return false;
      }
    }
  }
  return true;
}

function tools(value: readonly NativeCapabilityTool[]): readonly NativeCapabilityTool[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) invalid();
  const seen = new Set<string>();
  return Object.freeze(value.map((item) => {
    const raw = plain(item); const allowed = ['server', 'name', 'description', 'inputSchema'];
    if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !allowed.includes(key))
      || typeof raw.server !== 'string' || !TOOL_ID.test(raw.server)
      || typeof raw.name !== 'string' || !TOOL_ID.test(raw.name)
      || (raw.description !== undefined && (typeof raw.description !== 'string' || [...raw.description].length > 1200))) invalid();
    const key = `${raw.server}\u0000${raw.name}`; if (seen.has(key)) invalid(); seen.add(key);
    const schema = cloneJson(raw.inputSchema, 0, true);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)
      || (schema as Record<string, unknown>).type !== 'object') invalid();
    return Object.freeze({ server: raw.server, name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      inputSchema: schema as Readonly<Record<string, unknown>> });
  }));
}

/** Validate and detach host-provided descriptors before any credential or network work. */
export function validateNativeCapabilityOptions(options: NativeCapabilityOptions): NativeCapabilityOptions {
  if (!options || typeof options.call !== 'function' || typeof options.onChange !== 'function') invalid();
  return Object.freeze({ tools: tools(options.tools), call: options.call, onChange: options.onChange });
}

function frozenConfirmation(value: NativeCapabilityConfirmation): NativeCapabilityConfirmation {
  return Object.freeze({ ...value, args: cloneJson(value.args) as Readonly<Record<string, unknown>> });
}

class CapabilityBridge implements NativeCapabilityController {
  private currentSnapshot: NativeCapabilitySnapshot = Object.freeze({ state: 'ready', confirmation: null });
  private pending: Pending | null = null;
  private readonly used = new Set<string>();
  private closing = false;
  private failed = false;
  private announced = false;
  private readLoop: Promise<void> | null = null;
  private connectionId = '';
  private epoch = '';
  private socketExpiresAt = 0;
  private authorityTimer: NodeJS.Timeout | null = null;
  private readonly descriptors = new Map<string, Descriptor>();
  private readonly externalAbort: () => void;

  constructor(private readonly socket: NativeAgentCapabilitySocket, private readonly options: NativeCapabilityOptions,
    private readonly advertised: readonly NativeCapabilityTool[], private readonly guard: NativeCapabilityBridgeGuard,
    private readonly signal?: AbortSignal) {
    this.externalAbort = () => { void this.close(); };
    signal?.addEventListener('abort', this.externalAbort, { once: true });
  }

  async start(): Promise<NativeCapabilityController> {
    try {
      await this.socket.send({ type: 'hello', descriptor_version: 1, tools: this.advertised });
      const ready = plain(await this.socket.next());
      this.acceptReady(ready);
      await this.guard.assertCurrent();
      this.assertLive();
      this.announced = true;
      this.publish('ready', null);
      this.readLoop = this.run();
      void this.readLoop.catch(() => undefined);
      return this;
    } catch (error) {
      await this.fail();
      throw error;
    }
  }

  snapshot(): NativeCapabilitySnapshot { return this.currentSnapshot; }

  async confirm(requestId: string, confirmed: boolean): Promise<void> {
    const pending = this.pending;
    if (!pending || this.currentSnapshot.state !== 'confirmation_required' || pending.requestId !== requestId
      || typeof confirmed !== 'boolean' || pending.confirmed || pending.dispatched) invalid();
    // One synchronous decision latch. Concurrent UI/RPC confirmations cannot both cross an await.
    pending.confirmed = true;
    try {
      await this.guard.assertCurrent(); this.assertPendingLive(pending);
      await this.socket.send({ type: 'capability_confirmed', request_id: pending.requestId,
        connection_id: pending.connectionId, epoch: pending.epoch, capability_id: pending.capabilityId,
        args_sha256: pending.public.argsSha256, confirmation_nonce: pending.nonce, confirmed });
      pending.confirmationSent = true;
      if (confirmed) this.publish('executing', pending.public);
      else { this.finishPending(pending); this.publish('ready', null); }
    } catch (error) { await this.fail(); throw error; }
  }

  async close(): Promise<void> {
    if (this.closing) { await this.socket.close(); return; }
    this.closing = true; this.cancelPending();
    this.signal?.removeEventListener('abort', this.externalAbort);
    if (this.authorityTimer) clearTimeout(this.authorityTimer);
    this.authorityTimer = null;
    if (this.announced && !this.failed) this.publish('closed', null);
    await this.socket.close().catch(() => undefined);
  }

  private acceptReady(frame: Record<string, unknown>): void {
    exact(frame, ['type', 'protocol', 'connection_id', 'epoch', 'descriptors', 'expires_at']);
    if (frame.type !== 'ready' || frame.protocol !== 'canonical-capabilities-v1'
      || typeof frame.connection_id !== 'string' || !CONNECTION.test(frame.connection_id)
      || typeof frame.epoch !== 'string' || !EPOCH.test(frame.epoch)
      || !Array.isArray(frame.descriptors) || frame.descriptors.length !== this.advertised.length
      || typeof frame.expires_at !== 'number' || !Number.isFinite(frame.expires_at)) invalid();
    this.connectionId = frame.connection_id; this.epoch = frame.epoch;
    this.socketExpiresAt = Math.min(frame.expires_at, this.guard.accessExpiresAt);
    if (this.socketExpiresAt <= Date.now() / 1000) invalid();
    this.authorityTimer = setTimeout(() => { void this.fail(); },
      Math.max(0, Math.floor((this.socketExpiresAt - Date.now() / 1000) * 1000)));
    this.authorityTimer.unref();
    const advertised = new Map(this.advertised.map((tool) => [`${tool.server}\u0000${tool.name}`, tool]));
    for (const value of frame.descriptors) {
      const item = plain(value);
      exact(item, ['server', 'name', 'description', 'inputSchema', 'risk', 'approval_mode', 'required_scope',
        'capability_id', 'device_id', 'platform_session_id', 'connection_id', 'epoch', 'descriptor_version', 'descriptor_hash']);
      if (typeof item.server !== 'string' || typeof item.name !== 'string') invalid();
      const seed = advertised.get(`${item.server}\u0000${item.name}`);
      const description = seed?.description ?? '';
      if (!seed || item.description !== description || canonical(item.inputSchema) !== canonical(seed.inputSchema)
        || item.risk !== 'high' || item.approval_mode !== 'per_call'
        || !Array.isArray(item.required_scope) || item.required_scope.length !== 1 || item.required_scope[0] !== 'tool.execute'
        || typeof item.device_id !== 'string' || !UUID.test(item.device_id)
        || typeof item.platform_session_id !== 'string' || !UUID.test(item.platform_session_id)
        || item.connection_id !== this.connectionId || item.epoch !== this.epoch || item.descriptor_version !== 1
        || typeof item.descriptor_hash !== 'string' || !HEX64.test(item.descriptor_hash)
        || typeof item.capability_id !== 'string'
        || item.capability_id !== `cap://device/${encodeURIComponent(item.device_id)}/mcp/${encodeURIComponent(item.server)}/${encodeURIComponent(item.name)}`
        || this.descriptors.has(item.capability_id)) invalid();
      this.descriptors.set(item.capability_id, { capabilityId: item.capability_id, server: item.server, name: item.name,
        connectionId: this.connectionId, epoch: this.epoch, inputSchema: seed.inputSchema });
      advertised.delete(`${item.server}\u0000${item.name}`);
    }
    if (advertised.size) invalid();
  }

  private async run(): Promise<void> {
    try {
      while (!this.closing) {
        const frame = plain(await this.socket.next());
        await this.receive(frame);
      }
    } catch { if (!this.closing) await this.fail(); }
  }

  private async receive(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'capability_confirm') { this.receiveConfirmation(frame); return; }
    if (frame.type === 'mcp_call') {
      void this.receiveCall(frame).catch(() => { if (!this.closing) void this.fail(); });
      return;
    }
    if (frame.type === 'mcp_cancel') { this.receiveCancel(frame); return; }
    invalid();
  }

  private receiveConfirmation(frame: Record<string, unknown>): void {
    exact(frame, ['type', 'request_id', 'operation', 'args', 'args_canonical', 'expires_at', 'connection_id', 'epoch',
      'capability_id', 'args_sha256', 'confirmation_nonce']);
    if (this.pending || typeof frame.request_id !== 'string' || !UUID.test(frame.request_id) || this.used.has(frame.request_id)
      || frame.operation !== 'mcp.call' || frame.connection_id !== this.connectionId || frame.epoch !== this.epoch
      || typeof frame.capability_id !== 'string' || typeof frame.args_sha256 !== 'string' || !HEX64.test(frame.args_sha256)
      || typeof frame.confirmation_nonce !== 'string' || !NONCE.test(frame.confirmation_nonce)
      || typeof frame.expires_at !== 'number' || !Number.isFinite(frame.expires_at)) invalid();
    const descriptor = this.descriptors.get(frame.capability_id); if (!descriptor) invalid();
    const args = cloneJson(frame.args) as Readonly<Record<string, unknown>>; plain(args);
    if (typeof frame.args_canonical !== 'string' || !/^[\x00-\x7f]*$/.test(frame.args_canonical)) invalid();
    const argsCanonical = frame.args_canonical;
    const parsedCanonical = parseClosedJson(argsCanonical);
    if (Buffer.byteLength(argsCanonical) > MAX_ARGUMENT_BYTES || !equalJson(parsedCanonical, args)
      || !schemaMatches(args, descriptor.inputSchema)
      || createHash('sha256').update(argsCanonical).digest('hex') !== frame.args_sha256
      || frame.expires_at > this.socketExpiresAt || frame.expires_at <= Date.now() / 1000) invalid();
    const view = frozenConfirmation({ requestId: frame.request_id, server: descriptor.server, tool: descriptor.name,
      args, expiresAt: frame.expires_at, argsSha256: frame.args_sha256 });
    this.pending = { public: view, requestId: frame.request_id, operation: 'mcp.call', args,
      argsCanonical, capabilityId: descriptor.capabilityId, connectionId: this.connectionId,
      epoch: this.epoch, nonce: frame.confirmation_nonce, confirmed: false, confirmationSent: false,
      dispatched: false, abort: null, expiryTimer: null, callTimer: null };
    this.pending.expiryTimer = setTimeout(() => { if (this.pending?.requestId === frame.request_id) void this.fail(); },
      Math.max(0, Math.floor((frame.expires_at - Date.now() / 1000) * 1000)));
    this.pending.expiryTimer.unref();
    this.used.add(frame.request_id);
    if (this.used.size > 256) this.used.delete(this.used.values().next().value!);
    this.publish('confirmation_required', view);
  }

  private async receiveCall(frame: Record<string, unknown>): Promise<void> {
    exact(frame, ['type', 'request_id', 'server', 'tool', 'operation', 'args', 'args_canonical', 'deadline_ms', 'connection_id', 'epoch',
      'capability_id', 'args_sha256', 'confirmation_nonce']);
    const pending = this.pending;
    if (!pending || !pending.confirmed || !pending.confirmationSent || pending.dispatched || frame.request_id !== pending.requestId
      || frame.server !== pending.public.server || frame.tool !== pending.public.tool || frame.operation !== pending.operation
      || frame.connection_id !== pending.connectionId || frame.epoch !== pending.epoch
      || frame.capability_id !== pending.capabilityId || frame.args_sha256 !== pending.public.argsSha256
      || frame.confirmation_nonce !== pending.nonce || !Number.isSafeInteger(frame.deadline_ms) || (frame.deadline_ms as number) < 0) invalid();
    const args = cloneJson(frame.args) as Readonly<Record<string, unknown>>;
    if (frame.args_canonical !== pending.argsCanonical || !equalJson(parseClosedJson(pending.argsCanonical), args)) invalid();
    pending.dispatched = true;
    await this.guard.assertCurrent();
    if (this.pending !== pending) return;
    this.assertPendingLive(pending);
    const control = new AbortController(); pending.abort = control;
    const deadline = Math.min(pending.public.expiresAt, this.socketExpiresAt,
      Date.now() / 1000 + (frame.deadline_ms as number) / 1000);
    pending.callTimer = setTimeout(() => control.abort(), Math.max(0, Math.floor((deadline - Date.now() / 1000) * 1000)));
    pending.callTimer.unref();
    let result: Readonly<Record<string, unknown>>;
    try {
      const value = await this.options.call(pending.public.server, pending.public.tool, pending.args, control.signal);
      if (control.signal.aborted || this.pending !== pending) return;
      await this.guard.assertCurrent(); this.assertPendingLive(pending);
      const safe = cloneJson(value);
      const encoded = JSON.stringify(safe);
      result = !encoded || Buffer.byteLength(encoded) > MAX_RESULT_BYTES
        ? { type: 'mcp_result', request_id: pending.requestId, connection_id: pending.connectionId,
          epoch: pending.epoch, capability_id: pending.capabilityId, args_sha256: pending.public.argsSha256,
          confirmation_nonce: pending.nonce, ok: false }
        : { type: 'mcp_result', request_id: pending.requestId, connection_id: pending.connectionId,
          epoch: pending.epoch, capability_id: pending.capabilityId, args_sha256: pending.public.argsSha256,
          confirmation_nonce: pending.nonce, ok: true, result: safe };
    } catch {
      if (control.signal.aborted || this.pending !== pending) return;
      await this.guard.assertCurrent(); this.assertPendingLive(pending);
      result = { type: 'mcp_result', request_id: pending.requestId, connection_id: pending.connectionId,
        epoch: pending.epoch, capability_id: pending.capabilityId, args_sha256: pending.public.argsSha256,
        confirmation_nonce: pending.nonce, ok: false };
    }
    await this.socket.send(result);
    this.finishPending(pending); this.publish('ready', null);
  }

  private receiveCancel(frame: Record<string, unknown>): void {
    exact(frame, ['type', 'request_id', 'reason']);
    if (typeof frame.request_id !== 'string' || !UUID.test(frame.request_id) || typeof frame.reason !== 'string'
      || frame.reason.length < 1 || frame.reason.length > 64 || !this.used.has(frame.request_id)) invalid();
    const pending = this.pending;
    if (pending?.requestId === frame.request_id) {
      this.finishPending(pending); this.publish('ready', null);
    }
  }

  private assertLive(): void {
    if (this.closing || this.socket.closed || Date.now() / 1000 >= this.socketExpiresAt) throw new NativeSocketUnavailable();
  }

  private assertPendingLive(pending: Pending): void {
    this.assertLive();
    if (this.pending !== pending || Date.now() / 1000 >= pending.public.expiresAt) throw new NativeSocketUnavailable();
  }

  private finishPending(pending: Pending): void {
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    if (pending.callTimer) clearTimeout(pending.callTimer);
    pending.expiryTimer = null; pending.callTimer = null; pending.abort?.abort(); pending.abort = null;
    if (this.pending === pending) this.pending = null;
  }

  private cancelPending(): void { if (this.pending) this.finishPending(this.pending); }

  private publish(state: NativeCapabilityState, confirmation: NativeCapabilityConfirmation | null): void {
    this.currentSnapshot = Object.freeze({ state, confirmation });
    try { this.options.onChange(this.currentSnapshot); } catch { /* UI observers cannot affect authority */ }
  }

  private async fail(): Promise<void> {
    if (this.failed) return;
    this.failed = true; this.closing = true; this.cancelPending();
    if (this.authorityTimer) clearTimeout(this.authorityTimer);
    this.authorityTimer = null;
    this.signal?.removeEventListener('abort', this.externalAbort);
    if (this.announced) this.publish('failed', null);
    await this.socket.close().catch(() => undefined);
  }
}

/** Complete the hello/ready binding before exposing a controller or notifying UI observers. */
export async function connectNativeCapabilityBridge(socket: NativeAgentCapabilitySocket, options: NativeCapabilityOptions,
  guard: NativeCapabilityBridgeGuard, signal?: AbortSignal): Promise<NativeCapabilityController> {
  if (!socket || socket.closed || !guard || typeof guard.assertCurrent !== 'function' || typeof guard.accessExpiresAt !== 'number'
    || !Number.isFinite(guard.accessExpiresAt) || (signal !== undefined && !(signal instanceof AbortSignal))) invalid();
  signal?.throwIfAborted();
  const safe = validateNativeCapabilityOptions(options);
  return new CapabilityBridge(socket, safe, safe.tools, guard, signal).start();
}
