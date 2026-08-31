export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
}

export interface CurrentUser {
  userId: string;
  username: string;
  isSuperuser: boolean;
  roles: string[];
  permissions: string[];
}

export interface LoginResult extends AuthTokens {
  userId: string;
  username: string;
}

export interface Agent {
  id: number;
  workflowId: string;
  workflowName: string;
  nodeCount: number;
  isShared: boolean;
  isDeployed: boolean;
  isCompleted: boolean;
  workflowType: string;
  description: string;
  username: string;
  fullName: string;
  createdAt: string;
  updatedAt: string;
  hasAgentGeny?: boolean;
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface AgentListResult {
  items: Agent[];
  pagination: Pagination;
}

export interface AgentListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  owner?: 'personal' | 'shared';
  includeHarness?: boolean;
}

export interface Citation {
  fileName?: string;
  pageNumber?: number;
  score?: number;
  chunkText?: string;
  [key: string]: unknown;
}

export interface ToolEvent {
  eventType: 'tool_call' | 'tool_start' | 'tool_result' | 'tool_error' | string;
  toolName?: string;
  toolInput?: unknown;
  result?: string;
  resultLength?: number;
  error?: string;
  citations?: Citation[];
  runId?: string;
  indicator?: unknown;
  durationMs?: number;
  timestamp?: string;
  [key: string]: unknown;
}

export interface NodeStatusEvent {
  nodeId: string;
  status: string;
  [key: string]: unknown;
}

export type ChatEvent =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; event: ToolEvent }
  | { kind: 'node_status'; event: NodeStatusEvent }
  | { kind: 'log'; data: unknown }
  | { kind: 'execution_io'; executionIoId: number }
  | { kind: 'download'; data: Record<string, unknown> }
  | { kind: 'ui_command'; surface: 'a2ui' | 'floui'; command: Record<string, unknown> }
  | { kind: 'quota'; level: 'warning' | 'exceeded'; data: Record<string, unknown> }
  | { kind: 'summary'; text: string; data: Record<string, unknown> }
  | { kind: 'error'; detail: string }
  | {
      kind: 'status';
      surface: 'connector_local' | 'server_sandbox' | 'blocked';
      provider?: string;
      workspaceDir?: string;
      reason?: string;
      detail?: string;
    }
  | { kind: 'end' };

export interface ChatRequest {
  workflowId: string;
  workflowName: string;
  input: string | Record<string, unknown> | unknown[];
  interactionId: string;
  selectedCollections?: string[];
  selectedFiles?: (string | Record<string, unknown>)[];
  executionTarget?: 'sandbox';
  includeLogs?: boolean;
  includeNodeStatus?: boolean;
  includeToolEvents?: boolean;
}

export interface HistoryAttachment {
  id?: string | number;
  name: string;
  size: number;
  contentType: string;
  type: 'picture' | 'file';
  path: string;
  bucket: string;
}

export interface HistoryTurn {
  logId: number;
  ioId: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  output: string;
  attachments: HistoryAttachment[];
  updatedAt: string;
}

export interface Conversation {
  id: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  interactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
