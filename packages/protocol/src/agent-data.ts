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
import { HttpClient } from './client';

/** 에이전트 뷰어의 하위 탭 — **단일 정의**.
 *
 * 렌더러(workspace-layout)와 main(config 의 레이아웃 영속 스키마)이 둘 다 쓴다.
 * 예전엔 두 곳에 유니온이 복제돼 있어서, 탭을 하나 늘리면 저장 스키마 쪽이 조용히
 * 안 맞고 레이아웃 복원에서 그 탭만 사라졌다. */
export type AgentViewerSub = 'basic' | 'memory' | 'tasks' | 'tools' | 'storage' | 'fulllog';

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

/** `/storage/list` 는 workspace 루트 상대 경로를 돌려주지만 읽기 API는
 * 스토리지 루트 상대(`workspace/...`)를 받는다. 두 계약의 경계를 여기서만
 * 보정해 호출부마다 접두사를 붙였다 뗐다 하지 않게 한다. */
export function workspaceStoragePath(path: string): string {
  const clean = String(path ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return clean === 'workspace' || clean.startsWith('workspace/') ? clean : `workspace/${clean}`;
}

export class AgentDataApi {
  constructor(private http: HttpClient) {}

  // ── 전체로그 ──────────────────────────────────────────────────
  /** 이 에이전트의 실행 트레이스 목록(최근 50). */
  traceList(workflowId: string): Promise<TraceListResult> {
    const params = new URLSearchParams({
      workflow_id: workflowId,
      page: '1',
      page_size: '50',
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

  /** 원바이트 파일 읽기 — 이미지처럼 텍스트 API로 읽을 수 없는 미리보기용. */
  workspaceBinary(
    workflowId: string,
    path: string,
    purpose?: WorkspaceBinaryPurpose,
  ): Promise<WorkspaceBinary> {
    const encodedPath = workspaceStoragePath(path).split('/').map(encodeURIComponent).join('/');
    const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : '';
    return this.http.getBinary(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage-raw/${encodedPath}${query}`,
    );
  }

  /** Image bytes land in this agent's durable workspace before chat execution. */
  workspaceUpload(
    workflowId: string,
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    interactionId: string,
    attachmentId: string,
  ): Promise<WorkspaceUploadResult> {
    const form = new FormData();
    const owned = new Uint8Array(bytes);
    form.append('file', new Blob([owned.buffer], { type: mimeType }), filename);
    return this.http.upload<WorkspaceUploadResult>(
      `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}/storage/upload?subdir=uploads&purpose=chat_attachment&interaction_id=${encodeURIComponent(interactionId)}&attachment_id=${encodeURIComponent(attachmentId)}`,
      form,
      { timeoutMs: 300_000 },
    );
  }
}
