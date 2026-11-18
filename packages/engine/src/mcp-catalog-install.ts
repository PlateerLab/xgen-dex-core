/**
 * MCP 카탈로그 설치 — 카탈로그 항목 + 사용자가 넣은 변수 값 → 이 PC 에서 도는 MCP 서버.
 *
 *   값 검사 → 서버 설정 만들기 → 런타임 확인(없으면 동의 받고 자동 설치) → 실행 파일 확정
 *   → 사용자 승인(실행 파일 · 인자 · 환경 키 · setup) → setup 단계 → 연결 시험(도구 목록)
 *   → 저장 → 완료
 *
 * 이 파일은 **순서와 기록**만 안다. 창 · 대화 상자 · 키체인 · 설정 파일은 호스트가 deps 로
 * 준다(데스크톱 메인). 그래서 상태 기계 전체를 가짜 deps 로 시험할 수 있다.
 *
 * 기록 규칙(공통 계약 §2.4): 이벤트에는 변수 값 · 인자 · 도구 결과를 싣지 않는다. 오류 문구는
 * 이 설치의 비밀 값으로 가린 뒤 500자로 자른다(보고기가 한 번 더 자른다).
 */
import type {
  CatalogEventIn,
  CatalogEventName,
  CatalogItem,
  CatalogValues,
} from '@dex/protocol/mcp-catalog';
import {
  catalogLaunchFor,
  catalogSupportsDexon,
  catalogTemplateRefs,
  isSecretVariable,
  substituteCatalogTemplate,
  validateCatalogValues,
  variableTarget,
} from '@dex/protocol/mcp-catalog';
import type { McpServerConfig } from './mcp-types';
import { McpSecretRedactor } from './mcp-redaction';
import type { RuntimeEnsureResult, RuntimePlan, RuntimeProgress } from './mcp-runtime-manager';
import { RuntimeInstallError } from './mcp-runtime-manager';
import type { RunProcessResult } from './proc-run';

/** 저장된 서버 설정의 카탈로그 출처. protocol 의 CatalogServerBinding 과 같은 모양. */
export interface McpCatalogBinding {
  catalog_id: string;
  revision: number;
  values?: Record<string, string>;
}

/** 카탈로그 비밀 변수의 원래 값을 두는 키체인 항목 이름(업데이트 때 다시 쓴다). */
export const CATALOG_VARS_PREFIX = '__catalogvars__';
export function catalogVarsKey(serverName: string): string {
  return `${CATALOG_VARS_PREFIX}${serverName}`;
}

export type CatalogErrorCode =
  | 'validation'
  | 'spec_invalid'
  | 'dexon_too_old'
  | 'exec_not_found'
  | 'setup_failed'
  | 'setup_timeout'
  | 'test_failed'
  | 'save_failed'
  | 'user_cancelled'
  | 'consent_denied'
  | 'runtime_install_failed'
  | RuntimeInstallError['code'];

export class CatalogInstallError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
    this.name = 'CatalogInstallError';
  }
}

// ── 설정 만들기 ──────────────────────────────────────────────────────

export interface RenderedSetupStep {
  command: string;
  args: string[];
  description?: string;
  timeoutMs: number;
}

export interface RenderedCatalogServer {
  /** 실제 값이 들어 있는 설정(저장 때 env · headers 값은 키체인으로 간다). */
  config: McpServerConfig & { catalog: McpCatalogBinding };
  /** 비밀 변수 이름 → 값(키체인 전용). */
  secretValues: Record<string, string>;
  /** 비밀이 아닌 변수 값(설정의 catalog.values 에 남는다). */
  plainValues: Record<string, string>;
  setup: RenderedSetupStep[];
}

// Playwright 의 브라우저 받기(약 170MB)처럼 오래 걸리는 단계가 있다 — 넉넉히.
const DEFAULT_SETUP_TIMEOUT_MS = 20 * 60_000;
const MAX_SETUP_TIMEOUT_MS = 30 * 60_000;

/** 검사를 통과한 값으로 서버 설정을 만든다. 카탈로그 정의가 잘못됐으면 spec_invalid. */
export function renderCatalogServer(
  item: CatalogItem,
  values: Record<string, string>,
  opts: { platform: string; serverName: string },
): RenderedCatalogServer {
  const spec = item.spec;
  const variables = spec.variables ?? [];
  const declared = new Set(variables.map((v) => v.name));
  const secretNames = new Set(variables.filter(isSecretVariable).map((v) => v.name));
  const secretValues: Record<string, string> = {};
  const plainValues: Record<string, string> = {};
  for (const v of variables) {
    const value = values[v.name];
    if (value === undefined || value === '') continue;
    if (secretNames.has(v.name)) secretValues[v.name] = value;
    else plainValues[v.name] = value;
  }
  const checkRefs = (text: string, where: string, allowSecret: boolean) => {
    for (const ref of catalogTemplateRefs(text)) {
      if (!declared.has(ref))
        throw new CatalogInstallError(
          'spec_invalid',
          `카탈로그 정의 오류: ${where} 의 {{${ref}}} 는 선언되지 않은 변수입니다.`,
        );
      if (!allowSecret && secretNames.has(ref)) {
        // 실행 인자 · 주소는 설정 파일에 평문으로 남는다 — 비밀은 env · 헤더로만 넘긴다.
        throw new CatalogInstallError(
          'spec_invalid',
          `카탈로그 정의 오류: 비밀 변수 ${ref} 는 ${where} 에 쓸 수 없습니다(환경 변수나 헤더로만 전달).`,
        );
      }
    }
  };
  /** 인자 하나가 `{{X}}` 뿐인데 값이 비었으면 그 인자를 뺀다(선택 변수). */
  const renderArgs = (args: string[], where: string) => {
    const out: string[] = [];
    for (const arg of args) {
      checkRefs(arg, where, false);
      const only = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/.exec(arg);
      if (only && !values[only[1]]) continue;
      out.push(substituteCatalogTemplate(arg, values));
    }
    return out;
  };

  const binding: McpCatalogBinding = {
    catalog_id: item.catalog_id,
    revision: Number(item.revision) || 1,
    ...(Object.keys(plainValues).length ? { values: plainValues } : {}),
  };
  const config: McpServerConfig & { catalog: McpCatalogBinding } = {
    name: opts.serverName,
    transport: spec.transport,
    enabled: true,
    catalog: binding,
  };
  if (spec.transport === 'stdio') {
    const launch = catalogLaunchFor(spec, opts.platform);
    if (!launch?.command)
      throw new CatalogInstallError(
        'spec_invalid',
        '카탈로그 정의 오류: 실행 명령(launch.command)이 없습니다.',
      );
    checkRefs(launch.command, '실행 명령', false);
    config.command = substituteCatalogTemplate(launch.command, values).trim();
    config.args = renderArgs(launch.args, '실행 인자');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.env ?? {})) {
      checkRefs(String(v), `환경 변수 ${k}`, true);
      env[k] = substituteCatalogTemplate(String(v), values);
    }
    for (const v of variables) {
      // target 이 비어 있으면 env(서버 기본값). 비운 선택 변수는 아예 넣지 않는다.
      if (variableTarget(v) === 'env' && values[v.name]) env[v.name] = values[v.name];
    }
    for (const [k, v] of Object.entries(env)) if (!v) delete env[k];
    if (Object.keys(env).length) config.env = env;
  } else {
    const http = spec.http;
    if (!http?.url)
      throw new CatalogInstallError(
        'spec_invalid',
        '카탈로그 정의 오류: 주소(http.url)가 없습니다.',
      );
    checkRefs(http.url, '주소', false);
    config.url = substituteCatalogTemplate(http.url, values).trim();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(http.headers ?? {})) {
      checkRefs(String(v), `헤더 ${k}`, true);
      const refs = catalogTemplateRefs(String(v));
      // 선택 변수가 비어 "Bearer " 만 남는 헤더는 보내지 않는다.
      if (refs.length && refs.every((r) => !values[r])) continue;
      headers[k] = substituteCatalogTemplate(String(v), values);
    }
    if (Object.keys(headers).length) config.headers = headers;
    if (http.auth === 'oauth') config.auth = 'oauth';
  }
  const setup: RenderedSetupStep[] = (spec.setup ?? []).map((step, i) => {
    if (!step?.command)
      throw new CatalogInstallError(
        'spec_invalid',
        `카탈로그 정의 오류: setup ${i + 1} 의 명령이 없습니다.`,
      );
    checkRefs(step.command, `setup ${i + 1} 명령`, false);
    const timeout = Number(step.timeout_ms);
    return {
      command: substituteCatalogTemplate(step.command, values).trim(),
      args: renderArgs((step.args ?? []).map(String), `setup ${i + 1} 인자`),
      description: step.description,
      timeoutMs:
        Number.isFinite(timeout) && timeout > 0
          ? Math.min(timeout, MAX_SETUP_TIMEOUT_MS)
          : DEFAULT_SETUP_TIMEOUT_MS,
    };
  });
  return { config, secretValues, plainValues, setup };
}

/** 카탈로그 id 로 서버 이름을 짓는다. 이미 있으면 `-2`, `-3` … ('local' 은 예약). */
export function catalogServerName(catalogId: string, existing: string[]): string {
  const base =
    catalogId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp';
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  taken.add('local');
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

// ── 설치 상태 기계 ────────────────────────────────────────────────────

/** 화면의 단계: 런타임 확인 → 설치 → 설정 → 연결 테스트 → 완료. */
export type CatalogInstallStage = 'check' | 'install' | 'setup' | 'test' | 'done';
export const CATALOG_INSTALL_STAGES: CatalogInstallStage[] = [
  'check',
  'install',
  'setup',
  'test',
  'done',
];

export interface CatalogInstallProgress {
  stage: CatalogInstallStage;
  status: 'running' | 'ok' | 'failed' | 'skipped' | 'cancelled';
  message?: string;
  percent?: number;
  /** 지금 도는 프로세스(setup · 서버 기동)의 출력 꼬리 — 비밀은 가려져 있다. */
  lines?: string[];
}

export type CatalogEventDraft = Omit<
  CatalogEventIn,
  'ts' | 'catalog_id' | 'revision' | 'server_name'
> & {
  event: CatalogEventName;
};

export interface CatalogConfirmInstall {
  config: McpServerConfig;
  setup: RenderedSetupStep[];
  mode: 'install' | 'update';
}

export interface CatalogTestResult {
  ok: boolean;
  tools?: Array<{ name: string }>;
  error?: string;
  hints?: string[];
}

export interface CatalogInstallDeps {
  planRuntime(
    kind: CatalogItem['spec']['runtime']['kind'],
    minVersion: string | undefined,
    command: string | undefined,
  ): Promise<RuntimePlan>;
  /** 받을 런타임(무엇을 · 어디서 · 얼마나)을 보여 주고 동의를 받는다. */
  confirmRuntime(plan: RuntimePlan): Promise<boolean>;
  ensureRuntime(
    plan: RuntimePlan,
    onProgress: (p: RuntimeProgress) => void,
    signal: AbortSignal,
  ): Promise<RuntimeEnsureResult>;
  /** 실행 파일을 절대 경로로 확정한다(없으면 ExecNotFoundError). */
  canonicalize(config: McpServerConfig): Promise<McpServerConfig>;
  /** 확정된 실행 파일 · 인자 · 환경 키 · setup 을 보여 주고 승인을 받는다. */
  confirmInstall(input: CatalogConfirmInstall): Promise<boolean>;
  runSetup(
    step: RenderedSetupStep,
    env: Record<string, string> | undefined,
    signal: AbortSignal,
    onOutput: (tail: string) => void,
  ): Promise<RunProcessResult>;
  test(config: McpServerConfig, onLines: (lines: string[]) => void): Promise<CatalogTestResult>;
  save(
    config: McpServerConfig & { catalog: McpCatalogBinding },
    secretValues: Record<string, string>,
    mode: 'install' | 'update',
  ): Promise<void>;
  emit(event: CatalogEventIn): void;
  progress(p: CatalogInstallProgress): void;
  now?: () => number;
}

export interface CatalogInstallRequest {
  item: CatalogItem;
  values: CatalogValues;
  serverName: string;
  mode: 'install' | 'update';
  platform: string;
  dexonVersion: string;
  /** 업데이트: 화면이 비워 둔 비밀 변수는 키체인에 있던 값을 쓴다. */
  storedSecrets?: Record<string, string>;
}

export interface CatalogInstallResult {
  ok: boolean;
  cancelled?: boolean;
  stage?: CatalogInstallStage;
  code?: CatalogErrorCode | string;
  message?: string;
  hints?: string[];
  fieldErrors?: Record<string, string>;
  manual?: RuntimePlan['manual'];
  serverName: string;
  toolCount?: number;
  tools?: string[];
  /** OAuth 서버 — 저장했지만 브라우저 인가를 해야 연결된다. */
  needsAuthorization?: boolean;
  log: string[];
}

const LOG_MAX = 400;

export async function runCatalogInstall(
  req: CatalogInstallRequest,
  deps: CatalogInstallDeps,
  signal: AbortSignal,
): Promise<CatalogInstallResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { item, serverName, mode } = req;
  const spec = item.spec;
  const log: string[] = [];
  let redactor = new McpSecretRedactor();
  const note = (line: string) => {
    for (const l of redactor.text(line, 4000).split(/\r?\n/)) if (l.trim()) log.push(l);
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
  };
  const runtimeKind = spec.runtime?.kind ?? 'none';
  const emit = (e: CatalogEventDraft) => {
    const out: CatalogEventIn = {
      ...e,
      ts: new Date(now()).toISOString(),
      catalog_id: item.catalog_id,
      revision: Number(item.revision) || 1,
      server_name: serverName,
    };
    if (out.error_message) out.error_message = redactor.text(out.error_message, 500);
    try {
      deps.emit(out);
    } catch {
      /* 기록 실패가 설치를 막지 않는다 */
    }
  };
  let stage: CatalogInstallStage = 'check';
  const progress = (p: Omit<CatalogInstallProgress, 'stage'> & { stage?: CatalogInstallStage }) => {
    const next: CatalogInstallProgress = { ...p, stage: p.stage ?? stage };
    if (next.message) next.message = redactor.text(next.message, 2000);
    if (next.lines) next.lines = next.lines.map((l) => redactor.text(l, 500));
    try {
      deps.progress(next);
    } catch {
      /* 화면이 닫혀도 설치는 계속된다 */
    }
  };
  const fail = (
    code: CatalogErrorCode | string,
    message: string,
    extra: Partial<CatalogInstallResult> = {},
  ): CatalogInstallResult => {
    const safe = redactor.text(message, 2000);
    note(`실패(${code}): ${safe}`);
    for (const h of extra.hints ?? []) note(`  · ${h}`);
    progress({ status: 'failed', message: safe });
    return {
      ok: false,
      stage,
      code,
      message: safe,
      serverName,
      log,
      ...extra,
      hints: extra.hints?.map((h) => redactor.text(h, 500)),
    };
  };
  const cancelled = (
    where: string,
    code: 'user_cancelled' | 'consent_denied' = 'user_cancelled',
  ): CatalogInstallResult => {
    emit({
      event: 'install_cancelled',
      ok: false,
      error_code: code,
      runtime: runtimeKind,
      duration_ms: now() - started,
      detail: { stage: where, mode },
    });
    note(
      code === 'consent_denied'
        ? '사용자가 승인하지 않아 설치를 멈췄습니다.'
        : '사용자가 설치를 취소했습니다.',
    );
    progress({ status: 'cancelled', message: '취소했습니다.' });
    return {
      ok: false,
      cancelled: true,
      stage,
      code,
      message: '설치를 취소했습니다.',
      serverName,
      log,
    };
  };

  // 1. 값 검사 · 설정 만들기 — 아직 아무것도 시작하지 않았으므로 기록하지 않는다(화면 검사와 같다).
  if (!catalogSupportsDexon(spec, req.dexonVersion)) {
    return fail(
      'dexon_too_old',
      `이 항목은 Dexon ${spec.min_dexon_version} 이상이 필요합니다(지금 ${req.dexonVersion}). 앱을 업데이트하세요.`,
    );
  }
  const stored = req.storedSecrets ?? {};
  const merged: CatalogValues = { ...req.values };
  for (const v of spec.variables ?? []) {
    if (isSecretVariable(v) && !String(merged[v.name] ?? '') && stored[v.name])
      merged[v.name] = stored[v.name];
  }
  const checked = validateCatalogValues(spec, merged);
  if (!checked.ok) {
    return {
      ok: false,
      stage,
      code: 'validation',
      message: '입력값을 확인하세요.',
      fieldErrors: checked.errors,
      serverName,
      log,
    };
  }
  let rendered: RenderedCatalogServer;
  try {
    rendered = renderCatalogServer(item, checked.values, { platform: req.platform, serverName });
  } catch (e) {
    const err = e as CatalogInstallError;
    return fail(err.code ?? 'spec_invalid', err.message);
  }
  // 비밀 변수 값 자체를 가린다 — 헤더 "Bearer <값>" 도 이 값이 들어 있으므로 함께 가려진다.
  redactor = new McpSecretRedactor({ env: rendered.secretValues });

  emit({
    event: 'install_started',
    ok: true,
    runtime: runtimeKind,
    detail: { mode, transport: spec.transport },
  });
  note(
    `${item.name} (${item.catalog_id} r${item.revision}) ${mode === 'update' ? '업데이트' : '설치'} 시작 — 서버 이름 ${serverName}`,
  );

  try {
    // 2. 런타임 확인
    stage = 'check';
    progress({ status: 'running', message: '런타임을 확인하고 있습니다…' });
    const command = rendered.config.transport === 'stdio' ? rendered.config.command : undefined;
    const plan = await deps.planRuntime(
      runtimeKind,
      spec.runtime?.min_version ?? undefined,
      command,
    );
    if (signal.aborted) return cancelled('check');
    note(`런타임: ${plan.summary}`);
    for (const f of plan.found)
      note(
        `  · ${f.component} ${f.version} (${f.source === 'managed' ? '앱 설치' : '시스템'}) ${f.path}`,
      );
    if (!plan.ready) {
      emit({
        event: 'runtime_missing',
        ok: false,
        runtime: plan.kind,
        error_code: plan.manual
          ? 'runtime_manual_required'
          : plan.unsupported
            ? 'runtime_unsupported'
            : undefined,
        detail: {
          auto: !plan.manual && !plan.unsupported,
          min_version: plan.minVersion ?? null,
          downloads: plan.downloads.map((d) => `${d.component}@${d.version}`).join(',') || null,
        },
      });
    }
    if (plan.manual) {
      return fail('runtime_manual_required', plan.manual.summary, {
        manual: plan.manual,
        hints: [...plan.manual.steps, `안내: ${plan.manual.url}`],
      });
    }
    if (plan.unsupported) return fail('runtime_unsupported', plan.unsupported);
    progress({ status: 'ok', message: plan.summary });

    // 3. 런타임 설치(필요할 때만, 동의 받고)
    stage = 'install';
    if (plan.downloads.length) {
      progress({ status: 'running', message: '내려받을 런타임을 확인해 주세요.' });
      const agreed = await deps.confirmRuntime(plan);
      if (!agreed) return cancelled('install', 'consent_denied');
      if (signal.aborted) return cancelled('install');
      for (const d of plan.downloads) note(`내려받기: ${d.label} ${d.version} — ${d.url}`);
      try {
        const res = await deps.ensureRuntime(
          plan,
          (p) => {
            const label =
              p.component === 'node' ? 'Node.js' : p.component === 'uv' ? 'uv' : 'Python';
            const text =
              p.phase === 'download'
                ? `${label} 내려받는 중… ${p.percent ?? 0}%`
                : p.phase === 'verify'
                  ? `${label} 무결성 확인 중…`
                  : p.phase === 'extract'
                    ? `${label} 압축 푸는 중…`
                    : p.phase === 'test'
                      ? `${label} 실행 시험 중…`
                      : (p.message ?? `${label} 설치 중…`);
            progress({ status: 'running', message: text, percent: p.percent });
            if (p.phase !== 'download') note(text);
          },
          signal,
        );
        for (const r of res.installed) {
          emit({
            event: 'runtime_install_ok',
            ok: true,
            runtime: r.component,
            runtime_version: r.version,
            duration_ms: r.durationMs,
          });
          note(`설치됨: ${r.component} ${r.version} (${Math.round(r.durationMs / 1000)}초)`);
        }
      } catch (e) {
        if (signal.aborted || (e as RuntimeInstallError).code === 'cancelled')
          return cancelled('install');
        const err = e as RuntimeInstallError;
        const code = err instanceof RuntimeInstallError ? err.code : 'runtime_install_failed';
        emit({
          event: 'runtime_install_failed',
          ok: false,
          runtime: err.runtime ?? plan.kind,
          error_code: code,
          error_message: err.message,
        });
        return fail(code, `런타임 설치에 실패했습니다 — ${err.message}`, {
          hints: err.hints?.length ? err.hints : undefined,
        });
      }
      progress({ status: 'ok', message: '런타임을 설치했습니다.' });
    } else {
      progress({ status: 'skipped', message: '설치할 런타임이 없습니다.' });
    }

    // 4. 실행 파일 확정 → 승인
    let canonical: McpServerConfig;
    const setup: RenderedSetupStep[] = [];
    try {
      canonical = await deps.canonicalize(rendered.config);
      for (const step of rendered.setup) {
        const c = await deps.canonicalize({
          name: `${serverName}-setup`,
          transport: 'stdio',
          command: step.command,
          args: step.args,
        });
        setup.push({ ...step, command: c.command ?? step.command, args: c.args ?? step.args });
      }
    } catch (e) {
      const err = e as Error & { hints?: string[] };
      const notFound = err.name === 'ExecNotFoundError';
      emit({
        event: 'runtime_missing',
        ok: false,
        runtime: runtimeKind,
        error_code: notFound ? 'exec_not_found' : 'spec_invalid',
        error_message: err.message,
        detail: { auto: false },
      });
      return fail(notFound ? 'exec_not_found' : 'spec_invalid', err.message, { hints: err.hints });
    }
    const finalConfig = { ...canonical, catalog: rendered.config.catalog } as McpServerConfig & {
      catalog: McpCatalogBinding;
    };
    stage = 'setup';
    progress({ status: 'running', message: '설치 내용을 확인해 주세요.' });
    const approved = await deps.confirmInstall({ config: finalConfig, setup, mode });
    if (!approved) return cancelled('confirm', 'consent_denied');
    if (signal.aborted) return cancelled('setup');

    // 5. setup 단계
    if (setup.length) {
      for (let i = 0; i < setup.length; i++) {
        const step = setup[i];
        const label = step.description || `setup ${i + 1}/${setup.length}`;
        progress({ status: 'running', message: `${label}…` });
        note(`setup ${i + 1}: ${step.command} ${step.args.join(' ')}`);
        const t0 = now();
        let res: RunProcessResult;
        try {
          res = await deps.runSetup(step, finalConfig.env, signal, (tail) =>
            progress({
              status: 'running',
              message: `${label}…`,
              lines: tail.split(/\r?\n/).filter(Boolean).slice(-12),
            }),
          );
        } catch (e) {
          res = {
            code: null,
            signal: null,
            stdout: '',
            stderr: (e as Error).message,
            timedOut: false,
            aborted: false,
          };
        }
        if (res.aborted || signal.aborted) return cancelled('setup');
        const tail = `${res.stdout}\n${res.stderr}`.trim().split(/\r?\n/).slice(-20);
        for (const l of tail) note(`  | ${l}`);
        if (res.timedOut || res.code !== 0) {
          const code = res.timedOut ? 'setup_timeout' : 'setup_failed';
          const msg = res.timedOut
            ? `${label} — ${Math.round(step.timeoutMs / 60000)}분 안에 끝나지 않았습니다.`
            : `${label} — 종료 코드 ${res.code ?? res.signal ?? '?'}`;
          emit({
            event: 'setup_failed',
            ok: false,
            runtime: runtimeKind,
            error_code: code,
            error_message: `${msg}\n${tail.slice(-3).join('\n')}`,
            duration_ms: now() - t0,
            detail: { step: i + 1, steps: setup.length },
          });
          return fail(code, `설정 단계가 실패했습니다: ${msg}`, { hints: tail.slice(-6) });
        }
        emit({
          event: 'setup_ok',
          ok: true,
          runtime: runtimeKind,
          duration_ms: now() - t0,
          detail: { step: i + 1, steps: setup.length },
        });
      }
      progress({ status: 'ok', message: '설정을 마쳤습니다.' });
    } else {
      progress({ status: 'skipped', message: '추가 설정 단계가 없습니다.' });
    }

    // 6. 연결 시험 — 첫 실행이면 npx/uvx 가 패키지를 내려받는다(출력이 계속 나오면 기다린다).
    stage = 'test';
    let tools: string[] = [];
    const oauth = finalConfig.transport !== 'stdio' && finalConfig.auth === 'oauth';
    if (oauth) {
      // OAuth 서버는 토큰이 없어 시험 연결이 늘 실패한다 — 저장한 뒤 [인가]로 연결한다(기존 테스트와 같은 규칙).
      note('OAuth 서버: 연결 시험 대신 저장 후 브라우저 인가가 필요합니다.');
      progress({ status: 'skipped', message: 'OAuth 서버는 저장한 뒤 [인가]로 연결합니다.' });
    } else {
      progress({
        status: 'running',
        message:
          '서버를 띄워 연결을 시험합니다… (처음이면 패키지를 내려받느라 몇 분 걸릴 수 있습니다)',
      });
      const t0 = now();
      const testing = deps.test(finalConfig, (lines) =>
        progress({ status: 'running', message: '연결 시험 중…', lines }),
      );
      const aborted = new Promise<'aborted'>((resolve) => {
        if (signal.aborted) resolve('aborted');
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const outcome = await Promise.race([testing, aborted]);
      if (outcome === 'aborted') return cancelled('test');
      const tested = outcome as CatalogTestResult;
      if (!tested.ok) {
        emit({
          event: 'server_test_failed',
          ok: false,
          runtime: runtimeKind,
          error_code: 'test_failed',
          error_message: tested.error ?? '연결 실패',
          duration_ms: now() - t0,
        });
        return fail(
          'test_failed',
          `연결 시험에 실패했습니다 — ${tested.error ?? '원인을 알 수 없습니다'}`,
          { hints: tested.hints },
        );
      }
      tools = (tested.tools ?? []).map((t) => t.name);
      emit({
        event: 'server_test_ok',
        ok: true,
        runtime: runtimeKind,
        tool_count: tools.length,
        duration_ms: now() - t0,
      });
      note(
        `연결됨 · 도구 ${tools.length}개${tools.length ? `: ${tools.slice(0, 20).join(', ')}` : ''}`,
      );
      progress({ status: 'ok', message: `연결됨 · 도구 ${tools.length}개` });
    }
    if (signal.aborted) return cancelled('test');

    // 7. 저장
    stage = 'done';
    progress({ status: 'running', message: '저장하고 있습니다…' });
    try {
      await deps.save(finalConfig, rendered.secretValues, mode);
    } catch (e) {
      emit({
        event: 'install_cancelled',
        ok: false,
        runtime: runtimeKind,
        error_code: 'save_failed',
        error_message: (e as Error).message,
        duration_ms: now() - started,
        detail: { stage: 'save', mode },
      });
      return fail('save_failed', `저장하지 못했습니다 — ${(e as Error).message}`);
    }
    emit({
      event: mode === 'update' ? 'server_updated' : 'install_completed',
      ok: true,
      runtime: runtimeKind,
      ...(oauth ? {} : { tool_count: tools.length }),
      duration_ms: now() - started,
      detail: { mode, ...(oauth ? { needs_authorization: true } : {}) },
    });
    note(`완료 (${Math.round((now() - started) / 1000)}초)`);
    progress({
      status: 'ok',
      message:
        mode === 'update'
          ? '업데이트했습니다.'
          : '설치를 마쳤습니다. 에이전트가 이 도구를 쓸 수 있습니다.',
    });
    return {
      ok: true,
      stage,
      serverName,
      toolCount: tools.length,
      tools,
      log,
      ...(oauth ? { needsAuthorization: true } : {}),
    };
  } catch (e) {
    // 예상하지 못한 오류 — 어느 단계에서 끝났는지 남긴다.
    if (signal.aborted) return cancelled(stage);
    emit({
      event: 'install_cancelled',
      ok: false,
      runtime: runtimeKind,
      error_code: 'unexpected',
      error_message: (e as Error).message,
      duration_ms: now() - started,
      detail: { stage, mode },
    });
    return fail('unexpected', (e as Error).message);
  }
}

// ── 저장 전후 비교 → 사용 기록 ─────────────────────────────────────────

function comparable(cfg: McpServerConfig): string {
  // 이름 · 켜짐 · 카탈로그 판을 뺀 실행 모양. 비밀 값은 저장 형태에서 이미 비어 있다.
  const {
    enabled: _enabled,
    catalog: _catalog,
    ...rest
  } = cfg as McpServerConfig & { catalog?: unknown };
  void _enabled;
  void _catalog;
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return JSON.stringify(stable(rest));
}

/**
 * 사용자가 MCP 서버 목록을 저장했을 때(켜기 · 끄기 · 삭제 · 직접 편집), 카탈로그로 설치한
 * 서버의 변화를 이벤트로 바꾼다. 카탈로그 출처가 없는 서버는 기록하지 않는다.
 * 같은 이름이 남았는데 카탈로그 출처가 사라졌으면(JSON 붙여넣기로 덮음) 제거로 본다.
 */
export function catalogSaveEvents(
  prev: McpServerConfig[],
  next: McpServerConfig[],
  now: () => number = Date.now,
): CatalogEventIn[] {
  const ts = new Date(now()).toISOString();
  const after = new Map(next.filter((s) => s?.name).map((s) => [s.name, s]));
  const out: CatalogEventIn[] = [];
  for (const before of prev) {
    const binding = before?.catalog;
    if (!binding?.catalog_id) continue;
    const base = {
      ts,
      catalog_id: binding.catalog_id,
      revision: binding.revision,
      server_name: before.name,
    };
    const cur = after.get(before.name);
    if (!cur || cur.catalog?.catalog_id !== binding.catalog_id) {
      out.push({
        ...base,
        event: 'server_removed',
        ok: true,
        detail: { reason: cur ? 'detached' : 'removed' },
      });
      continue;
    }
    const wasOn = before.enabled !== false;
    const isOn = cur.enabled !== false;
    if (wasOn !== isOn)
      out.push({ ...base, event: isOn ? 'server_enabled' : 'server_disabled', ok: true });
    if (comparable(before) !== comparable(cur)) {
      out.push({
        ...base,
        revision: cur.catalog?.revision ?? binding.revision,
        event: 'server_updated',
        ok: true,
        detail: { source: 'manual' },
      });
    }
  }
  return out;
}
