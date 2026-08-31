/**
 * 표준 MCP 설정 JSON 가져오기/내보내기 — Claude Desktop·Cursor·mcp.json 등이
 * 공유하는 `{"mcpServers": {...}}` 형태를 그대로 붙여넣어 등록한다.
 *
 * 지원 입력 형태 (전부 허용):
 *   { "mcpServers": { "name": {...} } }     ← 표준
 *   { "servers": { "name": {...} } }        ← VS Code 변형
 *   { "name": {...}, "name2": {...} }       ← 맵만 붙여넣기
 *   { "command": "...", "args": [...] }     ← 서버 하나 (이름은 호출자가 지정)
 *
 * 서버 항목:
 *   stdio : command(+args, env)            — 대부분의 예제
 *   http  : url(+headers) / type: http|sse|streamable-http
 *   비활성: disabled: true  또는  enabled: false
 *
 * argv 충실도: command 와 args 를 **분리 보존**한다 (문자열로 합쳤다가 다시
 * 쪼개면 공백·따옴표가 든 인자가 깨진다). 표시용 명령줄은 따로 만든다.
 */

export interface ImportedServer {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** stdio: 실행 파일 (args 와 분리). 표시용 문자열은 displayCommand. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ImportResult {
  servers: ImportedServer[];
  /** 치명적이지 않은 경고 (건너뛴 항목 등). */
  warnings: string[];
}

export class McpImportError extends Error {}

/** 공백·따옴표가 있으면 인용해 사람이 읽을 명령줄로 (mcp-manager tokenize 호환). */
export function toDisplayCommand(command: string, args: readonly string[] = []): string {
  const quote = (s: string): string => {
    if (s === '') return '""';
    if (!/[\s"']/.test(s)) return s;
    if (!s.includes('"')) return `"${s}"`;
    if (!s.includes("'")) return `'${s}'`;
    return `"${s.replace(/"/g, '')}"`; // 양쪽 따옴표 혼재 — 표시용 근사치
  };
  return [command, ...args].map(quote).join(' ');
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    out[k] = typeof val === 'string' ? val : String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

function parseEntry(name: string, raw: unknown, warnings: string[]): ImportedServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${name}: 서버 항목이 객체가 아니라 건너뜁니다.`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const declaredType = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const command = typeof o.command === 'string' ? o.command.trim() : '';

  // disabled: true (Cursor/VS Code) 또는 enabled: false
  const enabled = o.disabled === true ? false : o.enabled === false ? false : true;

  if (url && (!command || declaredType.includes('http') || declaredType === 'sse')) {
    return {
      name,
      transport: declaredType === 'sse' ? 'sse' : 'http',
      url,
      headers: asStringMap(o.headers),
      enabled,
    };
  }
  if (!command) {
    warnings.push(`${name}: command 도 url 도 없어 건너뜁니다.`);
    return null;
  }
  const rawArgs = Array.isArray(o.args) ? o.args : [];
  const args = rawArgs
    .filter((a) => a !== null && a !== undefined)
    .map((a) => (typeof a === 'string' ? a : String(a)));
  return {
    name,
    transport: 'stdio',
    command,
    args: args.length ? args : undefined,
    env: asStringMap(o.env),
    enabled,
  };
}

/** 붙여넣은 JSON → 서버 목록. 파싱 불가면 McpImportError. */
export function parseMcpConfig(text: string, fallbackName = 'server'): ImportResult {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new McpImportError('붙여넣은 내용이 비어 있습니다.');
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (e) {
    throw new McpImportError(
      `JSON 형식이 아닙니다 — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new McpImportError('최상위가 JSON 객체여야 합니다.');
  }
  const root = data as Record<string, unknown>;
  const mapCandidate = root.mcpServers ?? root.servers;
  const warnings: string[] = [];

  // 서버 하나만 붙여넣은 경우
  if (!mapCandidate && (typeof root.command === 'string' || typeof root.url === 'string')) {
    const one = parseEntry(fallbackName, root, warnings);
    if (!one) throw new McpImportError(warnings[0] ?? '서버 정의를 읽지 못했습니다.');
    return { servers: [one], warnings };
  }

  const map = (mapCandidate ?? root) as Record<string, unknown>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new McpImportError('mcpServers 가 객체가 아닙니다.');
  }
  const servers: ImportedServer[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const clean = name.trim();
    if (!clean) {
      warnings.push('이름이 빈 항목을 건너뜁니다.');
      continue;
    }
    const parsed = parseEntry(clean, raw, warnings);
    if (parsed) servers.push(parsed);
  }
  if (!servers.length) {
    throw new McpImportError(
      warnings.length
        ? `가져올 서버가 없습니다 — ${warnings[0]}`
        : '가져올 서버가 없습니다 (mcpServers 가 비어 있습니다).',
    );
  }
  return { servers, warnings };
}

/** 현재 서버 목록 → 표준 JSON (다른 도구에 붙여넣기용). */
export function toMcpConfigJson(
  servers: readonly ImportedServer[],
): string {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of servers) {
    const entry: Record<string, unknown> = {};
    if (s.transport === 'http' || s.transport === 'sse') {
      entry.type = s.transport;
      entry.url = s.url ?? '';
      if (s.headers && Object.keys(s.headers).length) entry.headers = s.headers;
    } else {
      entry.command = s.command ?? '';
      if (s.args?.length) entry.args = s.args;
      if (s.env && Object.keys(s.env).length) entry.env = s.env;
    }
    if (s.enabled === false) entry.disabled = true;
    out[s.name] = entry;
  }
  return JSON.stringify({ mcpServers: out }, null, 2);
}
