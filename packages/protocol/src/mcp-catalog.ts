/**
 * MCP 카탈로그 — 관리자가 미리 다 정의해 둔 MCP(설치 명령 · 런타임 · 변수)를
 * Dexon 이 받아 로컬에 설치하고, 그 사용 기록을 서버에 남긴다.
 *
 * 계약: xgen-core `/api/dashboard/mcp/catalog` (MCP 관리 고도화 공통 계약 2026-11-18 §2).
 *
 * 여기 있는 것은 두 종류다.
 *   1. 서버와 말하는 법 — `/published`(ETag · 304) 와 `/events`(최대 100개 배치).
 *   2. 변수 규칙 — 값 검증 · `{{VAR}}` 치환. 화면(입력 폼)과 메인(설치)이 **같은 답**을
 *      내야 하므로 의존 0 인 이 패키지에 둔다.
 *
 * 비밀 규칙: 이벤트에는 변수 값 · 도구 인자 · 결과 · 토큰을 절대 싣지 않는다. 그 거름은
 * 이벤트를 만드는 쪽(엔진의 보고기)이 하고, 여기서는 모양만 정한다.
 */
import { ApiError, type HttpClient } from './client';

// ── 카탈로그 항목 ────────────────────────────────────────────────────

export type CatalogTransport = 'stdio' | 'http' | 'sse';
export type CatalogRuntimeKind = 'node' | 'python' | 'uv' | 'docker' | 'binary' | 'none';
export type CatalogVariableType =
  'string' | 'secret' | 'url' | 'path' | 'enum' | 'number' | 'boolean';
export type CatalogVariableTarget = 'env' | 'arg' | 'header';
export type CatalogPlatform = 'win32' | 'darwin' | 'linux';

export interface CatalogVariableOption {
  value: string;
  label?: string;
}

export interface CatalogVariable {
  name: string;
  label?: string;
  description?: string;
  type: CatalogVariableType;
  /** 없으면 true(서버 기본값). */
  required?: boolean;
  /** `type: 'secret'` 이면 서버가 true 로 강제한다(클라이언트도 같이 본다). */
  secret?: boolean;
  default?: string | number | boolean | null;
  placeholder?: string | null;
  /** enum 선택지 — 문자열 목록이나 `{value, label}` 목록. */
  options?: Array<string | CatalogVariableOption> | null;
  /** 전체 일치로 검사한다(`^(?:pattern)$`). */
  pattern?: string | null;
  /** env 이면 같은 이름의 환경 변수로도 넣는다. `{{NAME}}` 치환은 target 과 무관하게 어디서든.
   *  비어 있으면 env(서버 기본값과 같다). */
  target?: CatalogVariableTarget | null;
}

/** 서버 기본값: required 는 없으면 true, target 은 없으면 env. */
export function isRequiredVariable(v: CatalogVariable): boolean {
  return v.required !== false;
}

export function variableTarget(v: CatalogVariable): CatalogVariableTarget {
  return v.target || 'env';
}

export interface CatalogLaunchOverride {
  command?: string;
  args?: string[];
}

export interface CatalogLaunch {
  command: string;
  args?: string[];
  platforms?: Partial<Record<CatalogPlatform, CatalogLaunchOverride>> | null;
}

export interface CatalogHttp {
  url: string;
  headers?: Record<string, string> | null;
  auth?: 'none' | 'oauth';
}

export interface CatalogSetupStep {
  command: string;
  args?: string[];
  description?: string;
  /** 선택. 없으면 클라이언트 기본값(10분). */
  timeout_ms?: number;
}

export interface CatalogRuntime {
  kind: CatalogRuntimeKind;
  min_version?: string | null;
}

export interface CatalogPackage {
  registry: 'npm' | 'pypi' | 'none';
  name?: string;
  version?: string;
}

export interface CatalogSpec {
  spec_version: number;
  transport: CatalogTransport;
  runtime: CatalogRuntime;
  package?: CatalogPackage | null;
  launch?: CatalogLaunch | null;
  http?: CatalogHttp | null;
  env?: Record<string, string> | null;
  variables?: CatalogVariable[] | null;
  setup?: CatalogSetupStep[] | null;
  min_dexon_version?: string | null;
}

export interface CatalogItem {
  catalog_id: string;
  name: string;
  description?: string;
  category?: string;
  icon_url?: string | null;
  publisher?: string | null;
  homepage_url?: string | null;
  docs_url?: string | null;
  tags?: string[];
  status?: 'draft' | 'published' | 'hidden';
  visible_roles?: string[];
  revision: number;
  spec: CatalogSpec;
  install_guide?: string | null;
  source?: 'builtin' | 'custom';
  created_at?: string;
  updated_at?: string;
}

/** 저장된 MCP 서버 설정에 붙는 카탈로그 출처 — 업데이트 판단과 사용 기록에 쓴다. */
export interface CatalogServerBinding {
  catalog_id: string;
  revision: number;
  /** 비밀이 아닌 변수 값만(업데이트 때 다시 쓴다). 비밀 값은 키체인에만 있다. */
  values?: Record<string, string>;
}

// ── 이벤트 ──────────────────────────────────────────────────────────

/** 서버가 받는 이벤트 이름 — 고정 목록이고 그 밖은 400 이다. */
export const CATALOG_EVENT_NAMES = [
  'catalog_viewed',
  'install_started',
  'runtime_missing',
  'runtime_install_ok',
  'runtime_install_failed',
  'package_install_ok',
  'package_install_failed',
  'setup_ok',
  'setup_failed',
  'server_test_ok',
  'server_test_failed',
  'install_completed',
  'install_cancelled',
  'server_enabled',
  'server_disabled',
  'server_updated',
  'server_removed',
] as const;
export type CatalogEventName = (typeof CATALOG_EVENT_NAMES)[number];

export function isCatalogEventName(value: unknown): value is CatalogEventName {
  return typeof value === 'string' && (CATALOG_EVENT_NAMES as readonly string[]).includes(value);
}

export interface CatalogDevice {
  device_id: string;
  device_name: string;
  platform: string;
  arch: string;
  dexon_version: string;
}

export interface CatalogEventIn {
  /** 클라이언트 시각(ISO). 서버는 ±1일을 벗어나면 자기 시각을 쓴다. */
  ts: string;
  catalog_id: string;
  revision?: number;
  server_name?: string;
  event: CatalogEventName;
  ok?: boolean;
  runtime?: string;
  runtime_version?: string;
  duration_ms?: number;
  error_code?: string;
  /** 최대 500자. 보내는 쪽이 비밀을 가린 뒤에만 넣는다. */
  error_message?: string;
  tool_count?: number;
  /** 작게 — 단계 이름 · 모드 같은 것만. 값 · 인자 · 결과는 금지. */
  detail?: Record<string, string | number | boolean | null>;
}

/** 한 번에 보낼 수 있는 이벤트 수(서버 상한). */
export const CATALOG_EVENTS_MAX_BATCH = 100;
export const CATALOG_ERROR_MESSAGE_MAX = 500;

// ── 서버 호출 ────────────────────────────────────────────────────────

export const MCP_CATALOG_BASE = '/api/dashboard/mcp/catalog';

export type PublishedCatalogResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; items: CatalogItem[] };

function parseItems(raw: unknown): CatalogItem[] {
  const list = (raw as { items?: unknown })?.items;
  if (!Array.isArray(list)) throw new Error('카탈로그 응답 형식이 올바르지 않습니다.');
  return list
    .filter(
      (item): item is CatalogItem =>
        !!item &&
        typeof (item as CatalogItem).catalog_id === 'string' &&
        typeof (item as CatalogItem).name === 'string' &&
        !!(item as CatalogItem).spec &&
        typeof (item as CatalogItem).spec === 'object',
    )
    .map((item) => ({ ...item, revision: Number(item.revision) || 1 }));
}

/**
 * 게시된 카탈로그를 받는다. `etag` 를 주면 `If-None-Match` 로 보내고, 304 면 목록 없이
 * `notModified: true` 를 돌려준다(부르는 쪽이 캐시를 그대로 쓴다).
 */
export async function fetchPublishedCatalog(
  http: HttpClient,
  etag?: string | null,
): Promise<PublishedCatalogResult> {
  const path = `${MCP_CATALOG_BASE}/published`;
  const res = await http.raw('GET', path, {
    headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) },
    timeoutMs: 20_000,
  });
  const headerTag = res.headers['etag'] ?? res.headers['ETag'] ?? null;
  if (res.status === 304) return { notModified: true, etag: headerTag ?? etag ?? null };
  let parsed: unknown = undefined;
  if (res.body) {
    try {
      parsed = JSON.parse(res.body);
    } catch {
      parsed = res.body;
    }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, `GET ${path} → ${res.status}`, parsed);
  }
  const bodyTag = (parsed as { etag?: unknown })?.etag;
  return {
    notModified: false,
    etag: typeof bodyTag === 'string' && bodyTag ? bodyTag : headerTag,
    items: parseItems(parsed),
  };
}

/** 사용 기록을 보낸다(최대 100개). 서버가 받은 수를 돌려준다. */
export async function sendCatalogEvents(
  http: HttpClient,
  device: CatalogDevice,
  events: CatalogEventIn[],
): Promise<number> {
  if (!events.length) return 0;
  if (events.length > CATALOG_EVENTS_MAX_BATCH) {
    throw new Error(
      `카탈로그 이벤트는 한 번에 ${CATALOG_EVENTS_MAX_BATCH}개까지 보낼 수 있습니다.`,
    );
  }
  const res = await http.post<{ accepted?: number }>(
    `${MCP_CATALOG_BASE}/events`,
    { device, events },
    { timeoutMs: 20_000 },
  );
  return typeof res?.accepted === 'number' ? res.accepted : events.length;
}

export class McpCatalogApi {
  constructor(private http: HttpClient) {}

  published(etag?: string | null): Promise<PublishedCatalogResult> {
    return fetchPublishedCatalog(this.http, etag);
  }

  sendEvents(device: CatalogDevice, events: CatalogEventIn[]): Promise<number> {
    return sendCatalogEvents(this.http, device, events);
  }
}

// ── 변수 규칙 ────────────────────────────────────────────────────────

export type CatalogValue = string | number | boolean | null | undefined;
export type CatalogValues = Record<string, CatalogValue>;

const TEMPLATE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export const CATALOG_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 문자열 안의 `{{NAME}}` 이름들(중복 없이, 나온 순서). */
export function catalogTemplateRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(TEMPLATE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** `{{NAME}}` 를 값으로 바꾼다. 없는 이름은 빈 문자열이 된다(선언 검사는 따로 한다). */
export function substituteCatalogTemplate(text: string, values: Record<string, string>): string {
  return String(text ?? '').replace(TEMPLATE, (_m, name: string) => values[name] ?? '');
}

export function isSecretVariable(v: CatalogVariable): boolean {
  return v.type === 'secret' || v.secret === true;
}

export function catalogVariableOptions(v: CatalogVariable): CatalogVariableOption[] {
  return (v.options ?? []).map((o) =>
    typeof o === 'string'
      ? { value: o, label: o }
      : { value: String(o.value), label: o.label ?? String(o.value) },
  );
}

/** 이 플랫폼에서 실제로 쓸 실행 명령(플랫폼별 덮어쓰기 반영). */
export function catalogLaunchFor(
  spec: CatalogSpec,
  platform: string,
): { command: string; args: string[] } | null {
  const launch = spec.launch;
  if (!launch?.command) return null;
  const override = (launch.platforms ?? {})[platform as CatalogPlatform];
  return {
    command: override?.command || launch.command,
    args: [...(override?.args ?? launch.args ?? [])].map(String),
  };
}

const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;
// 값 안의 제어 문자는 어떤 자리에서도 위험하다 — NUL 은 실행을 깨고, 줄바꿈은 헤더를 쪼갠다.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

export interface CatalogValidation {
  ok: boolean;
  /** 변수 이름 → 사람이 읽는 오류. */
  errors: Record<string, string>;
  /** 문자열로 정규화한 값(기본값 반영). 빈 선택 변수는 빠진다. */
  values: Record<string, string>;
}

function asText(value: CatalogValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * 사용자가 입력한 변수 값을 검사한다 — 필수 · 형식(type) · enum · pattern.
 * `keepSecrets` 는 업데이트처럼 비밀 값을 화면이 모르는 경우: 빈 비밀 값이면
 * "저장된 값 유지" 로 보고 필수 검사를 건너뛴다.
 */
export function validateCatalogValues(
  spec: CatalogSpec,
  input: CatalogValues,
  options: { keepSecrets?: string[] } = {},
): CatalogValidation {
  const errors: Record<string, string> = {};
  const values: Record<string, string> = {};
  const keep = new Set(options.keepSecrets ?? []);
  for (const v of spec.variables ?? []) {
    const raw = input[v.name];
    let text = asText(raw).trim();
    if (
      !text &&
      raw === undefined &&
      v.default !== null &&
      v.default !== undefined &&
      !isSecretVariable(v)
    ) {
      text = asText(v.default).trim();
    }
    if (!text) {
      if (v.type === 'boolean') {
        values[v.name] = 'false';
        continue;
      }
      if (isRequiredVariable(v) && !(isSecretVariable(v) && keep.has(v.name)))
        errors[v.name] = '필수 항목입니다.';
      continue;
    }
    if (CONTROL.test(text)) {
      errors[v.name] = '줄바꿈이나 제어 문자는 넣을 수 없습니다.';
      continue;
    }
    if (text.length > 4096) {
      errors[v.name] = '값이 너무 깁니다(최대 4096자).';
      continue;
    }
    switch (v.type) {
      case 'number':
        if (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
          errors[v.name] = '숫자를 입력하세요.';
          continue;
        }
        break;
      case 'boolean':
        if (!['true', 'false'].includes(text.toLowerCase())) {
          errors[v.name] = '켜기/끄기 값이 올바르지 않습니다.';
          continue;
        }
        text = text.toLowerCase();
        break;
      case 'url': {
        let url: URL | null = null;
        try {
          url = new URL(text);
        } catch {
          url = null;
        }
        if (!url || !['http:', 'https:'].includes(url.protocol)) {
          errors[v.name] = 'http:// 또는 https:// 로 시작하는 주소를 입력하세요.';
          continue;
        }
        break;
      }
      case 'path':
        if (!ABSOLUTE_PATH.test(text)) {
          errors[v.name] = '전체 경로를 입력하거나 [찾아보기]로 고르세요.';
          continue;
        }
        break;
      case 'enum': {
        const allowed = catalogVariableOptions(v).map((o) => o.value);
        if (!allowed.includes(text)) {
          errors[v.name] = '목록에서 고르세요.';
          continue;
        }
        break;
      }
      default:
        break;
    }
    if (v.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(`^(?:${v.pattern})$`);
      } catch {
        re = null; // 관리자 정의 오류는 사용자를 막지 않는다(서버가 저장 때 검사한다).
      }
      if (re && !re.test(text)) {
        errors[v.name] = '형식이 올바르지 않습니다.';
        continue;
      }
    }
    values[v.name] = text;
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** 점으로 나뉜 숫자 버전 비교(`v24.1.0` · `uv 0.13.9` · `3.12` 모두 받는다). */
export function compareLooseVersions(a: string, b: string): number {
  const parse = (s: string) =>
    (String(s).match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 게시된 판이 저장된 판보다 새로우면 "업데이트" 를 보여준다. */
export function catalogUpdateAvailable(
  item: Pick<CatalogItem, 'revision'>,
  binding?: Pick<CatalogServerBinding, 'revision'> | null,
): boolean {
  return !!binding && Number(item.revision) > Number(binding.revision);
}

/** 이 Dexon 이 카탈로그 항목을 설치할 수 있는 버전인가. */
export function catalogSupportsDexon(spec: CatalogSpec, dexonVersion: string): boolean {
  return !spec.min_dexon_version || compareLooseVersions(dexonVersion, spec.min_dexon_version) >= 0;
}
