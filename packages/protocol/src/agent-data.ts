/**
 * AgentDataApi — 한 에이전트(workflow)의 관측 데이터와 사용자 첨부 업로드.
 *
 * 채팅 헤더의 [...] 메뉴에서 여는 "에이전트 뷰어"가 쓰는 전송 계층이다.
 * 서버(xgen-workflow)의 표준 REST(owner/superuser 권한, 베어러 토큰) 를 그대로
 * 호출하고, **조회(GET)만** 한다 — 생성/삭제/변경 경로는 여기에 없다.
 *
 * 응답은 서버 와이어 포맷(snake_case)을 그대로 타입으로 둔다. 표시 전용 데이터라
 * camelCase 재사상은 이득 없이 매핑 버그만 늘리므로(voice SttPref 와 같은 판단),
 * 렌더러가 서버 필드명을 그대로 읽는다.
 */
import type { ShareAudience } from './shares';
import { HttpClient } from './client';

/** 에이전트 뷰어의 하위 탭 — **단일 정의**.
 *
 * 렌더러(workspace-layout)와 main(config 의 레이아웃 영속 스키마)이 둘 다 쓴다.
 * 예전엔 두 곳에 유니온이 복제돼 있어서, 탭을 하나 늘리면 저장 스키마 쪽이 조용히
 * 안 맞고 레이아웃 복원에서 그 탭만 사라졌다. */
export type AgentViewerSub =
  | 'basic'
  | 'memory'
  | 'tasks'
  | 'tools'
  | 'apps'
  | 'storage'
  | 'fulllog';

/** 올릴 파일 — 바이트, 또는 경로로 흘려보내는 플랫폼(React Native)의 파일 참조. */
export type UploadSource = Uint8Array | { uri: string };

/** `form` 에 파일 한 개를 싣는다 — 바이트면 Blob, 참조면 RN FormData 의 `{ uri, name, type }`. */
export function appendUploadFile(
  form: FormData,
  field: string,
  source: UploadSource,
  filename: string,
  mimeType: string,
): void {
  if (source instanceof Uint8Array) {
    const owned = new Uint8Array(source);
    form.append(field, new Blob([owned.buffer], { type: mimeType }), filename);
    return;
  }
  form.append(field, { uri: source.uri, name: filename, type: mimeType } as unknown as Blob);
}

export interface WorkspaceUploadOptions {
  /**
   * 대화 첨부 폴더 안의 하위 폴더(`KakaoTalk/2026`). 폴더를 구조째 옮길 때 쓴다. 이 값을 모르는 옛 서버는
   * 무시하고 첨부 폴더 바로 아래에 둔다.
   */
  relDir?: string;
  /** 같은 이름이 있으면 덮어쓴다(기본은 `이름(1)` 로 비켜 쓴다). 같은 파일을 다시 옮길 때 쓴다. */
  replace?: boolean;
}

/** 하위 폴더 값 정리 — 빈 칸·`.`·`..` 을 버린다(서버도 다시 검사한다). */
export function workspaceRelDir(value: string | undefined): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

export interface WorkspaceUploadResult {
  ok: boolean;
  workflow_id?: string;
  workspace_path?: string;
  path?: string;
  size?: number;
  sha256?: string;
  seq?: number;
  status?: 'pending_approval';
  request_id?: number;
}

// ── 기본정보(basic-info) ───────────────────────────────────────────
//
// 실행 없이 재구성한 턴 프롬프트 + 도구 표면. 서버는 두 표면(web/connector)을
// 모두 돌려주고 **커넥터 뷰어는 connector 만** 보여 준다 — 이 앱에서 도는 턴이
// 그 표면이기 때문이다. 웹 화면은 반대로 web 만 보여 준다.

export interface BasicInfoPromptSection {
  key: string;
  title: string;
  source: string;
  text: string;
  dynamic: boolean;
  template?: string;
}

export interface BasicInfoToolEntry {
  name: string;
  description: string;
  gateway?: boolean;
}

export interface BasicInfoGroup {
  key: string;
  title: string;
  kind: string;
  gateway?: string | null;
  disclosure?: string | null;
  note?: string;
  tools: BasicInfoToolEntry[];
}

export interface BasicInfoSurface {
  available: boolean;
  note: string;
  prompt: { sections: BasicInfoPromptSection[]; full_prompt: string };
  provision?: {
    exposure: string;
    mode_note: string;
    stages: { key: string; title: string; groups: BasicInfoGroup[] }[];
  };
  tools: BasicInfoToolEntry[];
  native_tools?: { kept: string[]; removed: string[]; note: string } | null;
  skills: { name: string; description: string }[];
}

export interface AgentBasicInfo {
  workflow_id: string;
  provider: string;
  model: string;
  is_cli: boolean;
  surfaces?: { web: BasicInfoSurface; connector: BasicInfoSurface };
  errors: string[];
}

// ── 전체로그(trace) ────────────────────────────────────────────────
export type SpanType =
  | 'agent_input'
  | 'agent_output'
  | 'llm_call'
  | 'tool_call'
  | 'tool_output'
  | 'rag_search'
  | 'file_process'
  | 'error'
  | 'warning'
  | 'info';

export interface Trace {
  trace_id: string;
  status?: string;
  model_name?: string;
  provider?: string;
  total_spans?: number;
  total_tool_calls?: number;
  total_llm_calls?: number;
  duration_ms?: number;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
  interaction_id?: string;
}

export interface Span {
  span_type: SpanType | string;
  span_order?: number;
  tool_name?: string;
  input_data?: unknown;
  output_data?: unknown;
  duration_ms?: number;
  error_message?: string;
  created_at?: string;
  /** 서버가 붙인 부가 정보(JSON 문자열 또는 객체). info span 은 여기에 실행 환경
   *  ``detail`` 을 담는다 — 이 턴의 대화 출처와 붙은 로컬 도구 목록. */
  metadata?: unknown;
}

export interface TraceListResult {
  traces: Trace[];
  total?: number;
  page?: number;
  page_size?: number;
}

export interface TraceDetail {
  trace: Trace;
  spans: Span[];
}

// ── 메모리(geny-memory) ────────────────────────────────────────────
export interface MemoryFile {
  filename: string;
  title?: string;
  category?: string;
  tags?: string[];
  importance?: string;
  char_count?: number;
  modified?: string;
  first_paragraph?: string;
}

export interface MemoryDetail {
  filename: string;
  title?: string;
  body: string;
  category?: string;
  tags?: string[];
  importance?: string;
  frontmatter?: Record<string, unknown>;
  links_to?: string[];
  linked_from?: string[];
  created?: string | null;
  modified?: string | null;
}

export interface MemoryListResult {
  files: MemoryFile[];
  total?: number;
}

// ── 작업(geny-tasks) ──────────────────────────────────────────────
export interface Task {
  task_id: string;
  kind?: string;
  status?: string;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_s?: number | null;
  error?: string;
  interaction_id?: string;
  agent_type?: string;
  sub_agent_id?: string;
  title?: string;
  output_truncated?: boolean;
}

/** 지속 예약 작업(schedule_sessions) — 작업(task)과 다른 객체 계열이지만 같이 온다. */
export interface Job {
  session_id: string;
  name?: string;
  status?: string;
  schedule_type?: string;
  cron_expression?: string;
  interval_seconds?: number | null;
  next_execution_at?: string;
  last_execution_at?: string;
  last_execution_status?: string;
  total_executions?: number;
  failed_executions?: number;
  created_at?: string;
  created_by_agent?: boolean;
  job_kind?: string;
  job_target?: string;
  notify?: boolean;
  prompt?: string;
}

export interface TasksResult {
  tasks: Task[];
  counts?: Record<string, number>;
  total?: number;
  jobs?: Job[];
}

/** 예약 작업 1회 실행 기록. */
export interface JobRun {
  execution_number?: number;
  status?: string;
  scheduled_time?: string;
  started_at?: string;
  completed_at?: string;
  duration_s?: number | null;
  output?: string;
  error_message?: string;
}

export interface JobRunsResult {
  runs: JobRun[];
}

export interface TaskOutput {
  output: string;
  offset?: number;
  next_offset?: number;
  eof?: boolean;
  truncated?: boolean;
  result?: string;
}

// ── 도구(geny-tools, forged) ──────────────────────────────────────
export interface ForgedTool {
  name: string;
  description?: string;
  entrypoint?: string;
  runtime?: string;
  input_schema?: Record<string, unknown>;
  argv?: unknown[];
  /** 키 이름만 — 값(시크릿)은 서버가 절대 노출하지 않는다. */
  env_keys?: string[];
  dependencies?: string[];
  env_id?: string;
  timeout_s?: number;
  enabled?: boolean;
  verified?: boolean;
  last_test_error?: string | null;
  created_at?: string;
  updated_at?: string;
  calls?: number;
  errors?: number;
  last_used_at?: string;
  last_error?: string;
  script_exists?: boolean;
  status?: string;
  checked_at?: string | null;
  problem?: string | null;
  // with_source=true 일 때 병합됨
  source?: string | null;
  source_truncated?: boolean;
  source_error?: string | null;
}

export interface ToolsResult {
  tools: ForgedTool[];
  total?: number;
  enabled?: number;
  broken?: number;
  unknown?: number;
  unverified?: number;
}

// ── 앱(agent-apps, 옛 서버는 agent-artifacts) ─────────────────────────────────────
//
// 에이전트가 만든 React 화면. 새 저장소가 아니라 workspace 의 약속된 폴더
// (`workspace/artifacts/<slug>/`)라, 여기서 만들거나 지우지 않는다 — 만드는 것은
// 에이전트고 파일을 손보는 자리는 스토리지다. 서버가 폴더를 읽어 **검증**해
// 주므로, 틀린 매니페스트도 버려지지 않고 `issues` 로 돌아온다.
//
// 와이어 포맷(snake_case)은 그대로 둔다 — 웹과 같은 응답을 같은 이름으로 읽어야
// 두 화면이 갈라지지 않는다.

/** 앱이 선언한 읽기 전용 API 한 개 — 서버가 이미 검증했다(GET + 허용 접두). */
export interface AppApiDeclaration {
  alias: string;
  path: string;
  method: 'GET';
}

/**
 * 앱의 모양.
 *
 *   project   폴더가 곧 웹사이트다(index.html). 서버가 그대로 서빙한다.
 *   component 예전 모양 — React 한 파일을 프레임이 변환해 돌린다.
 */
export type AppKind = 'service' | 'project' | 'component';

/** service 앱의 선언 — 에이전트가 자기 sandbox 에서 무엇을 어느 포트로 띄우는가. */
export interface AppService {
  command: string
  port: number
  cwd: string
  health: string
}

export interface AppSummary {
  slug: string;
  kind: AppKind;
  /** 여는 주소(서버 기준 경로). 서버가 정한다 — 이름을 앱으로 바꾼 뒤의 서버만 준다(옛 서버는 없음). */
  app_url?: string;
  /** service 일 때의 선언 (아니면 null). */
  service?: AppService | null;
  /** 사이트의 문서 루트 (폴더 자신이면 빈 문자열). project 에만 있다. */
  root: string;
  title: string;
  description: string;
  /** 엔트리 파일. component 에서만 쓴다(사이트는 index.html 이 엔트리다). */
  entry: string;
  /**
   * 지금 **열리는가**. 매니페스트가 멀쩡해도 사람이 배포를 중지했으면 false 다 —
   * 목록의 불빛과 실제로 열리는지가 어긋나면 안 된다.
   */
  ready: boolean;
  /** 사람이 내려놓지 않았는가. false 면 서버가 소스를 주지 않는다. */
  serving: boolean;
  /** 누가 배포를 중지했는지(사용자 id). 배포 중이면 빈 문자열. */
  stopped_by: string;
  stopped_at: number | null;
  /**
   * 로그인 없이 열리는 공개 링크가 있는가.
   *
   * **토큰은 여기 오지 않는다** — 목록은 공유·감독으로 들어온 사람도 읽으므로,
   * 공개됐다는 *사실*과 그 *링크를 쥐는 것*을 구분한다.
   */
  shared: boolean;
  /** 공개 범위(users=XGEN 사용자, public=모두). 공개 중이 아니면 빈 문자열, 옛 서버는 보내지 않는다. */
  share_audience?: ShareAudience | '';
  shared_by: string;
  shared_at: number | null;
  /** epoch 초. 폴더 안에서 가장 최근에 바뀐 파일 기준. */
  updated_at: number | null;
  /**
   * 카드의 미리보기 그림 주소(서버 기준 경로, 로그인 자격으로 받는다). 아직 찍은 적이 없으면 빈 문자열 —
   * 화면은 요청 없이 기본 그림을 그린다. 옛 서버는 이 필드가 없다.
   */
  preview_url?: string;
  /** 미리보기를 올린 시각(epoch 초). `updated_at` 보다 이르면 그림이 낡았다. */
  preview_at?: number | null;
  /** 매니페스트 진단 — 비어 있으면 문제 없음. */
  issues: string[];
}

/** 앱(service)의 지금 상태 — 미리보기를 찍을지 정할 때 본다. */
export interface AppServiceStatus {
  kind: string;
  running: boolean;
  state?: string;
}

/**
 * 서버가 준 미리보기 주소인가 — 앱 API(옛 이름 포함) 아래, `/preview` 로 끝나는 경로(뒤의 `?v=` 허용).
 * 절대 주소·`//host`·`..` 는 받지 않는다.
 */
export function isAppPreviewPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const [pathname] = path.split('?');
  if (pathname.split('/').includes('..')) return false;
  const underApps = ['/api/agentflow/agent-apps/', '/api/agentflow/agent-artifacts/'].some((p) => pathname.startsWith(p));
  return underApps && pathname.endsWith('/preview');
}

/** 서버가 준 앱의 여는 주소(`app_url`)인가 — 앱 API(옛 이름 포함) 아래 `…/app/` 로 끝나는 경로만. */
export function isAppSitePath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return false;
  const [pathname] = path.split('?');
  if (pathname.split('/').includes('..')) return false;
  const underApps = ['/api/agentflow/agent-apps/', '/api/agentflow/agent-artifacts/'].some((p) => pathname.startsWith(p));
  return underApps && /\/app\/?$/.test(pathname);
}

/** 미리보기 그림을 올린 결과. */
export interface AppPreviewState {
  ok: boolean;
  slug: string;
  preview_url: string;
  preview_at: number | null;
}

export interface AppDetail extends AppSummary {
  workflow_id: string;
  /** 사이트 주소 (kind='project' 일 때만, 서버 경로). */
  app_url: string;
  /** 엔트리 파일 원문 (kind='component' 에서 프레임이 변환해 실행한다). */
  source: string;
  /** 선언된 데이터 파일 (경로 → 텍스트). */
  files: Record<string, string>;
  apis: AppApiDeclaration[];
}

export interface AppServingState {
  ok: boolean;
  slug: string;
  serving: boolean;
  stopped_by: string;
  stopped_at: number | null;
}

export interface AppShareState {
  ok: boolean;
  slug: string;
  shared: boolean;
  /** 공개 범위. 공개 중이 아니면 빈 문자열, 옛 서버는 보내지 않는다(그때는 모두에게 공개였다). */
  audience?: ShareAudience | '';
  shared_by: string;
  shared_at: number | null;
  /** 공개 토큰 — **켠 사람에게만** 돌아온다. 목록에는 없다. */
  token: string;
  /** 공개 주소의 경로(서버 기준). 공개 중이 아니면 빈 문자열. */
  path: string;
}

export interface AppListResult {
  workflow_id: string;
  apps: AppSummary[];
  total: number;
  ready: number;
}

// ── 앱 모음(agent-app-store) ─────────────────────────────────────
//
// [앱] 탭의 두 화면이 쓴다: [내 앱](내 에이전트 전부가 만든 앱)과 [앱 스토어](공개 링크로
// 공유된 앱, 누가 만들었든). 웹의 [Agent APP] 화면과 같은 엔드포인트·같은 필드명이다 —
// 두 화면이 같은 것을 다른 말로 보여 주지 않게.
//
// 예전에는 모음 엔드포인트가 없어 데스크톱 main 이 에이전트마다 목록을 물어 모았다.
// 서버가 한 번에 모아 주므로 그 훑기는 없어졌다(못 읽은 에이전트도 서버가 `failed` 로 말한다).

/** [내 앱] 의 한 장 — 에이전트 한 곳의 앱 요약에 그 에이전트를 붙인 것. */
export interface MyApp extends AppSummary {
  workflow_id: string;
  workflow_name: string;
}

export interface MyAppsResult {
  apps: MyApp[];
  /** 앱이 있는 에이전트와 그 수 — 에이전트 고르개의 목록이다. */
  agents: Array<{ workflow_id: string; workflow_name: string; count: number }>;
  total: number;
  /** 공개 중인 앱 수. */
  shared: number;
  /** 목록을 읽지 못한 에이전트 이름 — 조용히 빠뜨리지 않는다. */
  failed: string[];
}

/** [앱 스토어] 의 한 장 — 공개 링크로 공유된 앱. */
export interface StoreApp {
  workflow_id: string;
  slug: string;
  title: string;
  description: string;
  /** AppKind 이지만 서버가 모르는 값을 줄 수도 있어 문자열로 받는다. */
  kind: string;
  workflow_name: string;
  owner_id: number | null;
  owner_name: string;
  /** 공유한 시각 (epoch 초). */
  shared_at: number | null;
  /** 공개 링크의 경로(서버 기준, /share/app/…). 절대 주소는 서버 주소를 아는 쪽이 붙인다. */
  path: string;
  /**
   * 미리보기 그림 주소(서버 기준 경로, 공개 링크의 토큰이 자물쇠라 로그인 없이 받는다). 그림이 없으면
   * 빈 문자열, 옛 서버는 필드가 없다.
   */
  preview_url?: string;
  /** 내가 공유한 앱인가. */
  mine: boolean;
}

export interface AppStoreListResult {
  items: StoreApp[];
  total: number;
  page: number;
  page_size: number;
}

export type AppStoreScope = 'all' | 'mine';

export interface AppStoreListParams {
  search?: string;
  scope?: AppStoreScope;
  page?: number;
  pageSize?: number;
}

export const APP_STORE_API_BASE = '/api/agentflow/agent-app-store';
/** 스토어 한 쪽의 기본 크기 — 웹과 같다. */
export const APP_STORE_PAGE_SIZE = 24;

// ── 스토리지(geny-workspace) ──────────────────────────────────────
export interface WsNode {
  name: string;
  /** workspace 루트 기준 상대 경로. 클라이언트가 이 경로로 트리를 조립한다. */
  path: string;
  is_dir: boolean;
  size?: number | null;
  modified_at?: string;
  origin?: string;
  origin_name?: string;
}

export interface WorkspaceListResult {
  workflow_id: string;
  files: WsNode[];
}

export interface WorkspaceFile {
  workflow_id: string;
  path: string;
  content: string;
  encoding: string;
}

export interface WorkspaceBinary {
  bytes: Uint8Array;
  contentType: string;
}

export type WorkspaceBinaryPurpose = 'chat_attachment';

/**
 * 문서(docx·pptx·xlsx·hwp…)의 서버 렌더 — [파일 저장소] 와 **같은 렌더러**(edit2docs)가 그린 페이지 그림.
 *
 *   svg / png   `pages` 의 각 항목을 `workspacePreviewPage` 로 받는다(스토리지 루트 기준 경로).
 *   pdf         서버가 그리지 않는다 — 원바이트를 받아 화면이 직접 그린다.
 *   unsupported 그릴 수 없는 형식.
 */
export interface WorkspaceDocPreview {
  kind: 'svg' | 'png' | 'pdf' | 'unsupported' | string;
  count: number;
  pages: string[];
}

/** 렌더된 페이지가 사는 곳 — 스토리지 루트의 `.canvas-preview/` 아래만 받는다. */
export const DOC_PREVIEW_PAGE_PREFIX = '.canvas-preview/';

/** `/storage/list` 는 workspace 루트 상대 경로를 돌려주지만 읽기 API는
 * 스토리지 루트 상대(`workspace/...`)를 받는다. 두 계약의 경계를 여기서만
 * 보정해 호출부마다 접두사를 붙였다 뗐다 하지 않게 한다. */
export function workspaceStoragePath(path: string): string {
  const clean = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return clean === 'workspace' || clean.startsWith('workspace/') ? clean : `workspace/${clean}`;
}

/** 앱 API 의 접두. 이름을 앱으로 바꾸기 전(2026-09-28)의 서버는 옛 접두만 안다. */
export const APPS_API_BASE = '/api/agentflow/agent-apps';
export const LEGACY_APPS_API_BASE = '/api/agentflow/agent-artifacts';

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 404;
}

export class AgentDataApi {
  constructor(private http: HttpClient) {}

  /**
   * 이 서버의 앱 API 접두 — 한 번 정해지면 기억한다.
   *
   * 데스크톱 앱은 여러 버전의 서버에 붙는다. 새 접두로 먼저 부르고, 404 인데 옛 접두로는 되면
   * 옛 서버다. 둘 다 404 면(없는 앱) 아무것도 정하지 않는다 — 없는 앱 하나로 옛 서버라고
   * 단정하면 새 서버에서 영영 옛 주소를 쓴다(그래도 동작은 하지만 이름이 어긋난다).
   */
  private appsBase: string | null = null;

  private async viaAppsApi<T>(run: (base: string) => Promise<T>): Promise<T> {
    if (this.appsBase) return run(this.appsBase);
    try {
      const out = await run(APPS_API_BASE);
      this.appsBase = APPS_API_BASE;
      return out;
    } catch (e) {
      if (!isNotFound(e)) throw e;
      let out: T;
      try {
        out = await run(LEGACY_APPS_API_BASE);
      } catch {
        throw e;
      }
      this.appsBase = LEGACY_APPS_API_BASE;
      return out;
    }
  }

  /** 웹에서 같은 앱을 여는 화면 경로 — 옛 서버의 웹에는 새 경로(/app/…)가 없다. */
  appWebPath(workflowId: string, slug: string): string {
    const page = this.appsBase === LEGACY_APPS_API_BASE ? 'artifact' : 'app';
    return `/${page}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}`;
  }

  // ── 전체로그 ──────────────────────────────────────────────────
  /** Paginated execution summaries; existing callers still receive the most recent 50. */
  traceList(workflowId: string, page = 1, pageSize = 50): Promise<TraceListResult> {
    const positiveInt = (value: number, fallback: number) =>
      Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
    const params = new URLSearchParams({
      workflow_id: workflowId,
      page: String(positiveInt(page, 1)),
      page_size: String(Math.min(50, positiveInt(pageSize, 50))),
    });
    return this.http.get<TraceListResult>(`/api/agentflow/trace/list?${params}`);
  }

  /** 트레이스 하나의 스팬(단계) 전부. */
  traceDetail(traceId: string): Promise<TraceDetail> {
    return this.http.get<TraceDetail>(`/api/agentflow/trace/detail/${encodeURIComponent(traceId)}`);
  }

  // ── 메모리 ────────────────────────────────────────────────────
  memoryList(workflowId: string): Promise<MemoryListResult> {
    return this.http.get<MemoryListResult>(
      `/api/agentflow/geny-memory/${encodeURIComponent(workflowId)}/files`,
    );
  }

  /** filename 은 서버에서 `{filename:path}` — 슬래시는 살리고 세그먼트만 인코딩한다. */
  memoryRead(workflowId: string, path: string): Promise<MemoryDetail> {
    const fp = path.split('/').map(encodeURIComponent).join('/');
    return this.http.get<MemoryDetail>(
      `/api/agentflow/geny-memory/${encodeURIComponent(workflowId)}/files/${fp}`,
    );
  }

  // ── 작업 ──────────────────────────────────────────────────────
  tasksList(workflowId: string): Promise<TasksResult> {
    return this.http.get<TasksResult>(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}`,
    );
  }

  /** 예약 작업(job=session_id) 1건의 실행 기록. */
  taskRuns(workflowId: string, sessionId?: string): Promise<JobRunsResult> {
    return this.http.get<JobRunsResult>(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}/job/${encodeURIComponent(sessionId ?? '')}/runs`,
    );
  }

  /** 백그라운드/서브에이전트 작업(task_id) 1건의 출력. */
  taskOutput(workflowId: string, runId: string): Promise<TaskOutput> {
    return this.http.get<TaskOutput>(
      `/api/agentflow/geny-tasks/${encodeURIComponent(workflowId)}/task/${encodeURIComponent(runId)}/output`,
    );
  }

  // ── 세션 수명 ──────────────────────────────────────────────────
  /** '진행 중 대화' 종료 — 서버가 들고 있는 세션 RAM(executor + 라우팅)을 회수한다.
   *  이력은 지우지 않는다(삭제는 세션 종료이지 대화 기록 삭제가 아니다). */
  endSession(workflowId: string, interactionId: string): Promise<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(
      `/api/agentflow/geny-agent/${encodeURIComponent(workflowId)}/end-session`,
      { interaction_id: interactionId },
    );
  }

  // ── 기본정보 ──────────────────────────────────────────────────
  /** 실행 없이 재구성한 턴 프롬프트 + 도구 표면(web/connector 둘 다). */
  basicInfo(workflowId: string): Promise<AgentBasicInfo> {
    return this.http.get<AgentBasicInfo>(
      `/api/agentflow/${encodeURIComponent(workflowId)}/basic-info`,
    );
  }

  // ── 도구 ──────────────────────────────────────────────────────
  toolsList(workflowId: string): Promise<ToolsResult> {
    return this.http.get<ToolsResult>(
      `/api/agentflow/geny-tools/${encodeURIComponent(workflowId)}`,
    );
  }

  /** 제작 도구 하나 — 소스 코드까지. */
  toolGet(workflowId: string, functionId: string): Promise<ForgedTool> {
    return this.http.get<ForgedTool>(
      `/api/agentflow/geny-tools/${encodeURIComponent(workflowId)}/${encodeURIComponent(functionId)}?with_source=true`,
    );
  }

  // ── 앱 ──────────────────────────────────────────────────
  /** 이 에이전트의 앱 목록 (열 수 없는 것도 이유와 함께 온다). */
  /**
   * 격리 프레임(한 파일 앱)의 fetch 를 **대신** 부른다.
   *
   * 프레임에는 네트워크가 없다 — 그래서 앱이 fetch('__xgen/api/prices') 라고
   * 쓰면 "Failed to fetch" 로 죽었다. 여기서 우리 자격으로 대신 부르되 **그 앱의
   * 주소(…/{slug}/app/) 아래만** 부른다. 폴더의 api/*.py·도구·바깥 요청(__xgen/fetch)이
   * 전부 그 아래에 있고 서버가 각각 권한을 따진다. 예전에는 /api/… 전부를 불렀다 —
   * 에이전트가 쓴 코드가 보는 사람의 권한으로 플랫폼 API 에 닿았다.
   */
  appHttp(
    workflowId: string,
    slug: string,
    req: { url: string; method: string; headers: Record<string, string>; body: string | null },
  ): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string | null; bodyB64?: string }> {
    const base = `${this.appsBase ?? APPS_API_BASE}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/app/`;
    const target = new URL(req.url, `http://app.local${base}`);
    if (target.host !== 'app.local' || !target.pathname.startsWith(base)) {
      return Promise.reject(
        new Error(`'${req.url}' 은(는) 이 화면에서 부를 수 없습니다. 앱 안의 주소(__xgen/api/…)나 __xgen/fetch 를 쓰세요`),
      );
    }
    const headers = { ...req.headers };
    delete headers.cookie;
    delete headers.Cookie;
    delete headers.authorization;
    delete headers.Authorization;
    return this.http.raw(req.method, target.pathname + target.search, { headers, body: req.body });
  }

  async appList(workflowId: string): Promise<AppListResult> {
    const res = await this.viaAppsApi((base) =>
      this.http.get<Partial<AppListResult> & { workflow_id: string; total: number; ready: number; artifacts?: AppSummary[] }>(
        `${base}/${encodeURIComponent(workflowId)}/list`,
      ),
    );
    // 이름을 앱으로 바꾸기 전의 서버는 목록을 artifacts 로만 준다.
    const { artifacts, ...rest } = res;
    return { ...rest, apps: rest.apps ?? artifacts ?? [] };
  }

  /** 앱 하나 — 소스·선언된 파일·선언된 API 까지. */
  appGet(workflowId: string, slug: string): Promise<AppDetail> {
    return this.viaAppsApi((base) =>
      this.http.get<AppDetail>(`${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}`),
    );
  }

  /**
   * 배포를 중지하거나 다시 한다(화면 이름 [배포]/[배포 중지], API 필드는 serving) — **지우지 않는다.**
   *
   * 파일은 그대로 있고 에이전트도 계속 고칠 수 있다. 달라지는 것은 하나다:
   * 서버가 이 앱의 소스를 아무에게도 주지 않는다. 그래서 앱·웹·공유 링크가
   * 함께 닫힌다 — 판정이 한 군데라 한쪽만 열려 있는 상태가 없다.
   */
  appSetServing(workflowId: string, slug: string, serving: boolean): Promise<AppServingState> {
    return this.viaAppsApi((base) =>
      this.http.post<AppServingState>(
        `${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/serving`,
        { serving },
      ),
    );
  }

  /**
   * 공개 링크를 만들거나 없앤다 — **로그인 없이 열리는 주소**가 생긴다.
   *
   * 부르기 전에 반드시 사람에게 확인을 받아야 한다. 화면과 그 안의 데이터 파일은
   * 링크를 아는 누구나 보지만, 앱이 선언한 API 는 공개 화면에서 동작하지
   * **않는다** — 그 호출은 보는 사람의 권한으로 나가는데 익명에게는 권한이 없다.
   * 공유는 화면을 보여 주는 것이지 권한을 빌려주는 것이 아니다.
   *
   * 공개 범위(`audience`)는 둘이다: users(XGEN 사용자에게, 로그인한 사람만) / public(모두에게, 로그인 없이).
   * 이미 공유 중이면 **같은 링크**를 두고 범위만 바꾼다. 껐다 다시 켜거나 `rotate` 를 주면 새 토큰이라
   * 이미 나간 링크는 되살아나지 않는다. 옛 서버는 범위를 모른다(그때는 모두에게 공개였다).
   */
  appSetShare(
    workflowId: string,
    slug: string,
    shared: boolean,
    opts: { audience?: ShareAudience; rotate?: boolean } = {},
  ): Promise<AppShareState> {
    const body: Record<string, unknown> = { shared };
    if (opts.audience) body.audience = opts.audience;
    if (opts.rotate) body.rotate = true;
    return this.viaAppsApi((base) =>
      this.http.post<AppShareState>(
        `${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/share`,
        body,
      ),
    );
  }

  /** 지금의 공유 상태와 링크(주인만). 공유 창을 다시 열 때 같은 링크를 보여 준다. */
  appGetShare(workflowId: string, slug: string): Promise<AppShareState> {
    return this.viaAppsApi((base) =>
      this.http.get<AppShareState>(`${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/share`),
    );
  }

  /**
   * [내 앱] — 내 에이전트 전부가 만든 앱(열 수 없는 것도 이유와 함께).
   *
   * 빠진 칸은 비운 값으로 채운다. 화면이 `undefined.length` 로 넘어지는 것보다 "없음" 을
   * 말하는 편이 낫다.
   */
  async appStoreMine(): Promise<MyAppsResult> {
    const res = await this.http.get<Partial<MyAppsResult>>(`${APP_STORE_API_BASE}/mine`);
    const apps = Array.isArray(res?.apps) ? res.apps : [];
    return {
      apps,
      agents: Array.isArray(res?.agents) ? res.agents : [],
      total: typeof res?.total === 'number' ? res.total : apps.length,
      shared: typeof res?.shared === 'number' ? res.shared : apps.filter((a) => a.shared).length,
      failed: Array.isArray(res?.failed) ? res.failed : [],
    };
  }

  /**
   * 카드의 미리보기 그림을 올린다 — 앱을 띄워 찍은 화면(JPEG·PNG·WebP, 1MB 상한).
   *
   * 서버는 앱을 그리지 못한다(샌드박스에 브라우저가 없다). 그래서 앱을 그릴 줄 아는 클라이언트가 찍어
   * 올리고, 웹·데스크톱·모바일의 카드가 모두 이 한 장을 본다. 옛 서버는 404/405 다.
   */
  appPreviewUpload(
    workflowId: string,
    slug: string,
    bytes: Uint8Array,
    mimeType = 'image/jpeg',
  ): Promise<AppPreviewState> {
    return this.http.putBytes<AppPreviewState>(
      `${APPS_API_BASE}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/preview`,
      bytes,
      mimeType,
    );
  }

  /**
   * 서버가 준 미리보기 주소(`preview_url`)의 그림을 받는다. 앱 API 아래의 `/preview` 경로만 받는다 —
   * 화면이 넘긴 임의의 주소를 사용자 자격으로 부르지 않게.
   */
  appPreviewImage(previewUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (!isAppPreviewPath(previewUrl)) return Promise.reject(new Error('미리보기 주소가 아닙니다'));
    return this.http.getBinary(previewUrl, { timeoutMs: 30_000 });
  }

  /** 앱(service)이 지금 도는가 — 미리보기를 찍으려고 멈춘 앱을 깨우지 않는다. 사이트·옛 서버는 running=false. */
  appServiceState(workflowId: string, slug: string): Promise<AppServiceStatus> {
    return this.viaAppsApi((base) =>
      this.http.get<AppServiceStatus>(
        `${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}/service`,
      ),
    );
  }

  /** [앱 스토어] — 공개 링크로 공유된 앱. 배포를 멈췄거나 공유를 끈 앱은 서버가 뺀다. */
  async appStoreList(params: AppStoreListParams = {}): Promise<AppStoreListResult> {
    const positiveInt = (value: unknown, fallback: number) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
    const page = positiveInt(params.page, 1);
    const pageSize = positiveInt(params.pageSize, APP_STORE_PAGE_SIZE);
    const query = new URLSearchParams();
    const search = (params.search ?? '').trim();
    if (search) query.set('search', search);
    query.set('scope', params.scope === 'mine' ? 'mine' : 'all');
    query.set('page', String(page));
    query.set('page_size', String(pageSize));
    const res = await this.http.get<Partial<AppStoreListResult>>(`${APP_STORE_API_BASE}/list?${query}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    return {
      items,
      total: typeof res?.total === 'number' ? res.total : items.length,
      page: typeof res?.page === 'number' ? res.page : page,
      page_size: typeof res?.page_size === 'number' ? res.page_size : pageSize,
    };
  }

  /** 앱 폴더를 지운다 — **되돌릴 수 없다**(원본까지 함께 지워진다). */
  appDelete(workflowId: string, slug: string): Promise<{ ok: boolean }> {
    return this.viaAppsApi((base) =>
      this.http.del<{ ok: boolean }>(`${base}/${encodeURIComponent(workflowId)}/${encodeURIComponent(slug)}`),
    );
  }

  /**
   * 앱이 선언한 alias 를 **사용자 권한으로** 대신 호출한다.
   *
   * 프레임에는 네트워크가 없다. 무엇을 부를지도 프레임이 고르지 못하고 alias 만
   * 말할 수 있으며, 그 alias 가 어떤 경로인지는 서버가 검증해 내려준 선언에만
   * 있다. 여기서 한 번 더 확인하는 이유는 이 함수가 **실제로 호출을 실행하는
   * 곳**이기 때문이다 — 판정과 실행이 같은 자리에 있어야 한쪽만 느슨해지지 않는다.
   */
  async appCallApi(
    apis: AppApiDeclaration[],
    alias: string,
    params?: Record<string, string | number | boolean | undefined> | null,
  ): Promise<unknown> {
    // `async` 인 것이 중요하다. 검사 실패가 **동기 예외**로 나가면 호출부의
    // `.catch` 를 건너뛰고, 프레임은 답을 못 받아 '불러오는 중' 에서 멈춘다 —
    // 거절은 네트워크 실패와 같은 길로 돌아와야 한다.
    const decl = apis.find((a) => a.alias === alias);
    if (!decl) throw new Error(`선언되지 않은 alias 입니다: ${alias}`);
    if (decl.method !== 'GET') throw new Error('읽기(GET)만 허용됩니다');
    if (!decl.path.startsWith('/api/')) throw new Error('허용되지 않은 경로입니다');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) query.set(k, String(v));
    }
    const qs = query.toString();
    if (!qs) return this.http.get<unknown>(decl.path);
    // 선언된 path 에 이미 쿼리가 붙어 있을 수 있다 — 서버는 접두만 보고 통과시키므로
    // `/api/...?page_size=5` 같은 선언이 그대로 온다. 무조건 '?' 를 붙이면 그때
    // 주소가 깨지고, 앱은 이유를 알 수 없는 실패를 본다.
    const sep = decl.path.includes('?') ? '&' : '?';
    return this.http.get<unknown>(`${decl.path}${sep}${qs}`);
  }

  // ── 스토리지 ──────────────────────────────────────────────────
  /** 워크스페이스 전체(평면) 목록 — 파일/폴더 각각 한 항목. `path` 는 예약(미사용). */
  workspaceTree(workflowId: string, _path?: string): Promise<WorkspaceListResult> {
    return this.http.get<WorkspaceListResult>(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/list`,
    );
  }

  /** 텍스트 파일 미리보기. 바이너리/과대 파일은 서버가 415/413 으로 거부한다. */
  workspaceFile(workflowId: string, path: string): Promise<WorkspaceFile> {
    const params = new URLSearchParams({ path: workspaceStoragePath(path) });
    return this.http.get<WorkspaceFile>(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/text?${params}`,
    );
  }

  /**
   * 작업 공간 파일의 원본 주소(서버 기준 경로). 바이트를 직접 받지 않고 **주소로 그리는** 화면(모바일 WebView 의
   * 문서·소리·영상, 그림)이 쓴다 — 로그인은 그 화면이 싣는다.
   */
  workspaceRawPath(workflowId: string, path: string, purpose?: WorkspaceBinaryPurpose): string {
    const encodedPath = workspaceStoragePath(path).split('/').map(encodeURIComponent).join('/');
    const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : '';
    return `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage-raw/${encodedPath}${query}`;
  }

  /** 원바이트 파일 읽기 — 이미지처럼 텍스트 API로 읽을 수 없는 미리보기용. */
  workspaceBinary(
    workflowId: string,
    path: string,
    purpose?: WorkspaceBinaryPurpose,
  ): Promise<WorkspaceBinary> {
    return this.http.getBinary(this.workspaceRawPath(workflowId, path, purpose));
  }

  /**
   * 문서의 페이지 그림 목록 — [파일 저장소] 의 문서 미리보기와 같은 렌더러다. 처음 여는 문서는 서버가 그리는 동안
   * 수십 초가 걸릴 수 있어 넉넉히 기다린다(같은 문서는 다음부터 바로 온다).
   */
  async workspaceDocPreview(workflowId: string, path: string): Promise<WorkspaceDocPreview> {
    const params = new URLSearchParams({ path: workspaceStoragePath(path) });
    const res = await this.http.get<Partial<WorkspaceDocPreview>>(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/doc-preview?${params}`,
      { timeoutMs: 300_000 },
    );
    const pages = Array.isArray(res?.pages) ? res.pages.filter((p): p is string => typeof p === 'string') : [];
    return { kind: String(res?.kind ?? 'unsupported'), count: Number(res?.count ?? pages.length), pages };
  }

  /**
   * 렌더된 페이지 한 장. `page` 는 `workspaceDocPreview` 가 돌려준 경로 그대로다(스토리지 루트 기준 —
   * `workspace/` 를 붙이지 않는다). 렌더 결과가 아닌 곳은 부르지 않는다.
   */
  workspacePreviewPage(workflowId: string, page: string): Promise<WorkspaceBinary> {
    const path = this.workspacePreviewPagePath(workflowId, page);
    if (!path) return Promise.reject(new Error('문서 미리보기 페이지가 아닙니다.'));
    return this.http.getBinary(path);
  }

  /** 렌더된 페이지의 주소(서버 기준 경로). 렌더 결과가 아닌 경로면 빈 문자열. */
  workspacePreviewPagePath(workflowId: string, page: string): string {
    const clean = String(page ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean.startsWith(DOC_PREVIEW_PAGE_PREFIX) || clean.split('/').includes('..')) return '';
    const encodedPath = clean.split('/').map(encodeURIComponent).join('/');
    return `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage-raw/${encodedPath}`;
  }

  /**
   * 대화 첨부를 에이전트의 작업 공간에 올린다 — 실행 전에.
   *
   * `source` 는 바이트(데스크톱·CLI) 또는 **파일 참조 `{ uri }`**(React Native). RN 의 `Blob` 은
   * 바이트로 만들 수 없다("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not
   * supported") — 모바일의 사진·파일 첨부가 전부 여기서 실패했다(2026-10-02). RN 의 FormData 는
   * `{ uri, name, type }` 을 받아 파일을 디스크에서 그대로 흘려보낸다(본문을 JS 메모리에 올리지 않음).
   */
  workspaceUpload(
    workflowId: string,
    source: UploadSource,
    filename: string,
    mimeType: string,
    interactionId: string,
    attachmentId: string,
    opts: WorkspaceUploadOptions = {},
  ): Promise<WorkspaceUploadResult> {
    const form = new FormData();
    appendUploadFile(form, 'file', source, filename, mimeType);
    const query = new URLSearchParams({
      subdir: 'uploads',
      purpose: 'chat_attachment',
      interaction_id: interactionId,
      attachment_id: attachmentId,
    });
    const relpath = workspaceRelDir(opts.relDir);
    if (relpath) query.set('relpath', relpath);
    if (opts.replace) query.set('replace', '1');
    return this.http.upload<WorkspaceUploadResult>(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/upload?${query}`,
      form,
      { timeoutMs: 300_000 },
    );
  }
}
