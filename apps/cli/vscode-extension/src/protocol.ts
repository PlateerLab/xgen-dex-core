export const DEX_PROTOCOL_VERSION = 1;

export interface ProfileSummary {
  name: string;
  serverUrl: string;
  current: boolean;
}

export interface AuthStatus {
  profile: string;
  serverUrl: string;
  authenticated: boolean;
  user?: {
    userId: string;
    username: string;
    isSuperuser: boolean;
    roles: string[];
    permissions: string[];
  };
  reason?: 'missing_session' | 'invalid_session' | 'network';
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

export interface AgentListResult {
  items: Agent[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
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

export interface HistoryTurn {
  logId: number;
  ioId: number;
  interactionId: string;
  workflowId: string;
  workflowName: string;
  input: string;
  output: string;
  attachments: Array<Record<string, unknown>>;
  updatedAt: string;
}

export interface LocalToolsConfig {
  enabled: boolean;
  cwd: string;
  timeoutMs: number;
  allowedRoots: string[];
  blockedCommands: string[];
  allowDangerous: boolean;
}

export interface LocalToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface LocalToolBridgeStatus {
  running: boolean;
  connected: boolean;
  catalogSynced: boolean;
  advertisedTools: number;
  serverTools: number;
  profile?: string;
  serverUrl?: string;
  userId?: string;
  error?: string;
  lastCall?: {
    tool: string;
    ok: boolean;
    durationMs: number;
    at: string;
  };
}

export interface LocalToolsStatus {
  config: LocalToolsConfig;
  tools: LocalToolSchema[];
  bridge: LocalToolBridgeStatus;
}

export interface ToolEvent {
  eventType: string;
  toolName?: string;
  result?: string;
  error?: string;
  runId?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export type ChatEvent =
  | { kind: 'text'; content: string }
  | { kind: 'summary'; text: string; data: Record<string, unknown> }
  | { kind: 'tool'; event: ToolEvent }
  | { kind: 'node_status'; event: { nodeId: string; status: string; [key: string]: unknown } }
  | { kind: 'quota'; level: 'warning' | 'exceeded'; data: Record<string, unknown> }
  | { kind: 'error'; detail: string }
  | { kind: 'status'; surface: string; detail?: string; reason?: string }
  | { kind: 'log'; data: unknown }
  | { kind: 'execution_io'; executionIoId: number }
  | { kind: 'download'; data: Record<string, unknown> }
  | { kind: 'ui_command'; surface: 'a2ui' | 'floui'; command: Record<string, unknown> }
  | { kind: 'end' };

export interface InitializeResult {
  protocolVersion: number;
  server: { name: string; version: string };
  capabilities: {
    profiles: boolean;
    authentication: string[];
    agents: boolean;
    chatStreaming: boolean;
    chatCancellation: boolean;
    history: boolean;
    localTools: boolean;
  };
}

export interface ChatStartResult {
  streamId: string;
  interactionId: string;
  workflowId: string;
  workflowName: string;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface ChatEventNotification {
  streamId: string;
  event: ChatEvent;
}

export interface ChatCompleteNotification {
  streamId: string;
  interactionId: string;
}

export interface ChatErrorNotification {
  streamId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
