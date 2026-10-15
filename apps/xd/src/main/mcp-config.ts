/**
 * 에이전트의 MCP 서버 설정 — 모양은 Dex 와 같다(`@dex/engine/mcp-types` 의 McpServerConfig), 비밀(stdio 의 env 값·
 * http 의 headers 값)은 Dex 의 `mcp-secrets` 그대로 갈라 XD 의 암호 저장소(`mcp-<에이전트 id>`)에 둔다. 에이전트
 * 설정(options.mcpServers)에는 키 이름만 남는다(값은 '').
 *
 * 엔진으로 넘길 때만 비밀을 되살리고, 서버마다 짧은 이름표(slug)를 붙인다 — 엔진의 도구 이름이
 * `mcp_<이름표>_<도구>` 다(48자 안에 맞추려고 짧게, 런타임이 밑줄로 가르므로 밑줄 없이).
 */
import { createHash } from 'node:crypto';
import type { McpServerConfig as DexMcpServerConfig, McpServerSecrets } from '@dex/engine/mcp-types';
import { splitServerSecrets, withResolvedSecrets } from '@dex/engine/mcp-secrets';

/**
 * Dex 의 모양 + `previousName`: 화면이 이름을 바꾼 서버에 붙여 보낸다 — 비밀이 이름으로 묶여 있어서, 없으면 이름을 바꾸는
 * 순간 저장된 비밀(화면은 값을 모른다)을 잃는다. 저장할 때는 떼어 낸다.
 */
export type McpServerConfig = DexMcpServerConfig & { previousName?: string };

/** 엔진의 서버 한 대(`agent.mcp_servers`) — 비밀이 되살아난 모양. 로그에 남기지 않는다. */
export interface EngineMcpServer {
  slug: string;
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 서버 이름 → 비밀. 암호 저장소에는 이 모양의 JSON 이 들어간다. */
export type McpSecretsByName = Record<string, McpServerSecrets>;

/** 엔진이 받지 않는 이름표(런타임이 기기 도구로 다룬다). */
const RESERVED = new Set(['local', 'mobile', 'web', 'connector', 'test']);

export class McpConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const kv = (value: unknown, what: string): Record<string, string> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new McpConfigError('mcp_bad', `${what} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.trim();
    if (!key) continue;
    out[key] = typeof v === 'string' ? v : String(v ?? '');
  }
  return Object.keys(out).length ? out : undefined;
};

/** 화면이 보낸 목록을 검사해 깨끗한 모양으로 — 이름은 겹치지 않게(대소문자 무시), 주소·명령은 있어야. */
export function cleanMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new McpConfigError('mcp_bad', 'mcpServers must be a list');
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new McpConfigError('mcp_bad', 'mcp server must be an object');
    const r = raw as Record<string, unknown>;
    const name = String(r.name ?? '').trim();
    if (!name || name.length > 60) throw new McpConfigError('mcp_name', 'mcp server needs a name');
    if (seen.has(name.toLowerCase())) throw new McpConfigError('mcp_duplicate', `duplicate mcp server ${name}`);
    seen.add(name.toLowerCase());
    const transport = r.transport === 'http' || r.transport === 'sse' ? r.transport : r.transport === undefined || r.transport === 'stdio' ? 'stdio' : null;
    if (!transport) throw new McpConfigError('mcp_bad', `unknown transport ${String(r.transport)}`);
    if (r.auth === 'oauth') throw new McpConfigError('mcp_oauth', 'oauth mcp servers are not supported');
    const server: McpServerConfig = { name, transport, enabled: r.enabled !== false };
    if (typeof r.previousName === 'string' && r.previousName.trim() && r.previousName.trim() !== name) server.previousName = r.previousName.trim();
    if (transport === 'stdio') {
      const command = String(r.command ?? '').trim();
      const args = Array.isArray(r.args) ? r.args.map(String) : undefined;
      // 엔진과 같은 규칙 — 쪼갠 뒤 실행 파일이 비면(`""` 같은 줄) 그 서버는 띄울 수 없다.
      if (!command || (!args && !splitCommand(command)[0])) throw new McpConfigError('mcp_command', `mcp server ${name} needs a command`);
      server.command = command;
      if (args) server.args = args;
      const env = kv(r.env, 'env');
      if (env) server.env = env;
    } else {
      const url = String(r.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new McpConfigError('mcp_url', `mcp server ${name} needs an http(s) url`);
      server.url = url;
      const headers = kv(r.headers, 'headers');
      if (headers) server.headers = headers;
    }
    return server;
  });
}

/** 저장할 모양 — 비밀 값은 빼고(키만), 비밀은 따로. 값이 빈 칸이면 저장된 값을 그대로 둔다(Dex 와 같은 규칙). */
export function splitMcpSecrets(
  servers: McpServerConfig[],
  stored: McpSecretsByName | null,
): { servers: McpServerConfig[]; secrets: McpSecretsByName } {
  const secrets: McpSecretsByName = {};
  const out = servers.map(({ previousName, ...s }) => {
    // 이름을 바꿨으면 원래 이름의 비밀이 먼저다 — 같은 편집에서 지운 다른 서버의 이름을 새 이름으로 썼어도(맞바꾸기)
    // 남의 비밀이 붙지 않게.
    const saved = (previousName ? stored?.[previousName] : undefined) ?? stored?.[s.name] ?? null;
    const { redacted, secrets: sec } = splitServerSecrets(s, saved);
    if (sec.env || sec.headers) secrets[s.name] = sec;
    return redacted;
  });
  return { servers: out, secrets };
}

/**
 * 한 줄 명령 → [실행 파일, 인자...] — 따옴표(" ')를 알아본다. `args` 를 따로 받은 서버(표준 설정 가져오기)는 쪼개지
 * 않는다(공백·따옴표가 든 인자가 깨진다).
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 이름 → 다듬은 이름표 바탕(소문자·숫자·하이픈 12자). 영문자가 없으면(한글 등) 이름의 해시. */
function slugBase(name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 12)
    .replace(/-+$/, '');
  if (!base) base = `m${createHash('sha1').update(name).digest('hex').slice(0, 7)}`;
  if (RESERVED.has(base)) base = `${base}-mcp`.slice(0, 12);
  return base;
}

/**
 * 이름들 → 이름표들: 소문자·숫자·하이픈, 12자 안. **이름에서만 정한다**(목록 순서와 상관없이) — 지난 턴의 도구 이름이
 * 다른 서버를 가리키지 않게. 다듬은 꼴이 둘 이상 겹치면 그 서버들 모두 이름의 해시를 붙인다.
 */
export function mcpSlugs(names: string[]): string[] {
  const bases = names.map(slugBase);
  const count = new Map<string, number>();
  for (const b of bases) count.set(b, (count.get(b) ?? 0) + 1);
  const taken = new Set<string>();
  return names.map((name, i) => {
    const base = bases[i];
    let slug = (count.get(base) ?? 0) > 1 ? `${base.slice(0, 7).replace(/-+$/, '')}-${createHash('sha1').update(name).digest('hex').slice(0, 4)}` : base;
    // 해시까지 겹치는 일은 거의 없지만, 겹치면 번호로(이때만 순서를 탄다).
    for (let n = 2; taken.has(slug); n += 1) slug = `${base.slice(0, 12 - String(n).length - 1)}-${n}`;
    taken.add(slug);
    return slug;
  });
}

/** 켜 둔 서버만, 비밀을 되살려 엔진의 모양으로. 이름표는 목록 순서로 정한다(이름이 같으면 언제나 같다). */
export function engineMcpServers(servers: McpServerConfig[], secrets: McpSecretsByName | null): EngineMcpServer[] {
  const slugs = mcpSlugs(servers.map((s) => s.name));
  const out: EngineMcpServer[] = [];
  for (const [i, s] of servers.entries()) {
    const slug = slugs[i];
    if (s.enabled === false) continue;
    const full = withResolvedSecrets(s, secrets?.[s.name] ?? null);
    out.push(engineServer(full, slug));
  }
  return out;
}

/** 서버 하나를 엔진의 모양으로(이름표를 정해서) — [연결 확인]도 이것을 쓴다. */
export function engineServer(s: McpServerConfig, slug: string): EngineMcpServer {
  if (s.transport === 'stdio') {
    const argv = s.args ? [String(s.command ?? ''), ...s.args] : splitCommand(String(s.command ?? ''));
    return { slug, label: s.name, transport: 'stdio', command: argv[0] ?? '', args: argv.slice(1), ...(s.env ? { env: s.env } : {}) };
  }
  return { slug, label: s.name, transport: s.transport, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
}

/** 이 에이전트의 비밀(암호 저장소의 `mcp-<id>`) — 망가졌으면 없는 것으로. */
export function parseMcpSecrets(raw: string | null): McpSecretsByName | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpSecretsByName) : null;
  } catch {
    return null;
  }
}

export const mcpSecretId = (agentId: string) => `mcp-${agentId}`;

/** 에이전트의 설정(options.mcpServers) + 비밀 → 엔진의 목록. 설정이 망가졌으면 빈 목록(턴은 MCP 없이 돈다). */
export function agentMcpServers(agent: { id: string; options: Record<string, unknown> }, secret: (id: string) => string | null): EngineMcpServer[] {
  let servers: McpServerConfig[];
  try {
    servers = cleanMcpServers(agent.options?.mcpServers);
  } catch {
    return [];
  }
  if (!servers.length) return [];
  return engineMcpServers(servers, parseMcpSecrets(secret(mcpSecretId(agent.id))));
}
