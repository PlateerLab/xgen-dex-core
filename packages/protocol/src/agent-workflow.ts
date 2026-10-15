/**
 * 에이전트의 저장된 워크플로우: 데스크톱 에이전트 뷰어의 [개요](Geny 가 아닐 때)와 [워크플로우] 탭이 쓴다.
 *
 * Geny 의 [개요]는 서버가 턴 프롬프트를 다시 조립한 것(basic-info)인데, 그 조립은 Agent Geny 노드에만 있다.
 * Agent Xgen 이나 일반 워크플로우는 저장된 정의를 그대로 읽어 사람이 알아야 할 것만 추린다(웹의
 * WorkflowBasicInfoView 와 같은 판정). 판정은 여기 한 곳에 두고 화면은 그리기만 한다.
 */

/** 노드 파라미터 하나(저장된 모양 그대로). */
export interface WorkflowNodeParam {
  id?: string;
  value?: unknown;
  options?: Array<{ value?: unknown; label?: string; label_ko?: string }>;
}

export interface WorkflowNode {
  id: string;
  data?: {
    id?: string;
    functionId?: string;
    nodeName?: string;
    nodeNameKo?: string;
    parameters?: WorkflowNodeParam[];
    inputs?: Array<{ id?: string; name?: string; name_ko?: string }>;
  };
}

export interface WorkflowEdge {
  source?: { nodeId?: string; portId?: string };
  target?: { nodeId?: string; portId?: string };
}

/** GET /api/agentflow/load/{workflow_id} 를 뷰어가 쓰는 만큼만 추린 것. */
export interface AgentWorkflow {
  workflowId: string;
  workflowName: string;
  /** 주인. 스토어 · 템플릿에서 온 것은 없다(null). */
  ownerUserId: string | null;
  /** 고정(동결)본이면 이름도 정의도 바꿀 수 없다. */
  isFrozen: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Agent Geny 계열(agents/geny · agents/geny-rsi) 노드인가. 메모리 · 작업 · 도구 같은 뷰어 탭은 이 노드의 것이다. */
export function isGenyAgentNode(nodeType: string | undefined | null): boolean {
  return nodeType === 'agents/geny' || nodeType === 'agents/geny-rsi';
}

/** 워크플로우에 Agent Geny 계열 노드가 있는가(서버 목록의 has_agent_geny 와 같은 판정). */
export function workflowHasGeny(workflow: Pick<AgentWorkflow, 'nodes'>): boolean {
  return workflow.nodes.some((node) => isGenyAgentNode(node.data?.id));
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function paramOf(node: WorkflowNode | undefined, id: string): WorkflowNodeParam | undefined {
  return node?.data?.parameters?.find((param) => param.id === id);
}

/** 노드 이름: 한국어 이름이 있으면 그것. */
export function workflowNodeLabel(node: WorkflowNode | undefined): string {
  const data = node?.data;
  if (!data) return node?.id ?? '-';
  return data.nodeNameKo || data.nodeName || data.id || node!.id;
}

export interface WorkflowSummary {
  /** 에이전트 노드(첫 번째). 없으면 일반 워크플로우. */
  agentNodeType: string | null;
  /** "Agent Xgen" · 노드 이름 · "일반 워크플로우". */
  kind: string;
  /** "제공사 · 모델". 고르지 않았으면 빈 문자열. */
  model: string;
  /** 시스템 프롬프트. 에이전트에 그 칸이 없으면 null. */
  prompt: string | null;
  /** 에이전트로 들어오는 연결: 보내는 노드 이름과 받는 포트 이름. */
  connected: Array<{ key: string; name: string; port: string }>;
  nodeCount: number;
  edgeCount: number;
  /** 모든 노드 이름(저장된 순서). */
  nodeNames: Array<{ id: string; name: string; type: string }>;
}

export function summarizeWorkflow(workflow: Pick<AgentWorkflow, 'nodes' | 'edges'>): WorkflowSummary {
  const nodes = workflow.nodes;
  const agent = nodes.find(
    (node) => node.data?.functionId === 'agents' || text(node.data?.id).startsWith('agents/'),
  );
  const provider = text(paramOf(agent, 'provider')?.value);
  const option = paramOf(agent, 'provider')?.options?.find((item) => text(item.value) === provider);
  const providerLabel = option?.label_ko || option?.label || provider;
  const model = provider
    ? text(paramOf(agent, provider === 'azure' ? 'azure_deployment' : `${provider}_model`)?.value)
    : '';
  const promptParam = paramOf(agent, 'system_prompt');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const connected = agent
    ? workflow.edges
        .filter((edge) => edge.target?.nodeId === agent.id && edge.source?.nodeId)
        .map((edge) => {
          const port = agent.data?.inputs?.find((input) => input.id === edge.target?.portId);
          return {
            key: `${edge.source?.nodeId}:${edge.target?.portId}`,
            name: workflowNodeLabel(byId.get(edge.source!.nodeId!)),
            port: port?.name_ko || port?.name || edge.target?.portId || '',
          };
        })
    : [];
  const agentNodeType = agent ? text(agent.data?.id) || null : null;
  return {
    agentNodeType,
    kind: !agent
      ? '일반 워크플로우'
      : agentNodeType === 'agents/xgen'
        ? 'Agent Xgen'
        : workflowNodeLabel(agent),
    model: [providerLabel, model].filter(Boolean).join(' · '),
    prompt: promptParam ? text(promptParam.value) : null,
    connected,
    nodeCount: nodes.length,
    edgeCount: workflow.edges.length,
    nodeNames: nodes.map((node) => ({ id: node.id, name: workflowNodeLabel(node), type: text(node.data?.id) })),
  };
}

/** 서버 로드 응답(content 안 또는 맨 위에 nodes/edges)을 뷰어 모양으로. */
export function toAgentWorkflow(workflowId: string, raw: unknown): AgentWorkflow {
  const res = (raw ?? {}) as Record<string, unknown>;
  const content = ((res.content ?? res) || {}) as { nodes?: unknown; edges?: unknown };
  const owner = res.owner_user_id;
  return {
    workflowId: text(res.workflow_id) || workflowId,
    workflowName: text(res.workflow_name),
    ownerUserId: owner == null || owner === '' ? null : String(owner),
    isFrozen: res.is_frozen === true,
    nodes: Array.isArray(content.nodes) ? (content.nodes as WorkflowNode[]) : [],
    edges: Array.isArray(content.edges) ? (content.edges as WorkflowEdge[]) : [],
  };
}
