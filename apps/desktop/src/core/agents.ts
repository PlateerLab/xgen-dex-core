/**
 * Agent (agentflow) listing — the "Agent 목록" grid.
 *
 * Uses GET /api/agentflow/list/detail (paged) which is exactly what the UI grid
 * shows. Requires the `main.agentflow:read` permission on the logged-in user.
 * The returned {workflowId, workflowName} pair is what identifies an agent for
 * starting a chat. Node-agnostic: agent_geny / agent_xgen / agent_harness all
 * appear here and all chat through the same execute-stream endpoint.
 */
import { HttpClient } from './client';
import type { Agent, AgentListQuery, AgentListResult } from './types';

interface RawAgent {
  id: number;
  workflow_id: string;
  workflow_name: string;
  node_count?: number;
  is_shared?: boolean;
  is_deployed?: boolean;
  is_completed?: boolean;
  workflow_type?: string;
  description?: string;
  username?: string;
  full_name?: string;
  created_at?: string;
  updated_at?: string;
  has_agent_geny?: boolean;
}

interface RawListResponse {
  items?: RawAgent[];
  workflows?: RawAgent[]; // legacy alias
  pagination?: {
    page: number;
    page_size: number;
    total_count: number;
    total_pages: number;
  };
}

function mapAgent(r: RawAgent): Agent {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    nodeCount: r.node_count ?? 0,
    isShared: !!r.is_shared,
    isDeployed: !!r.is_deployed,
    isCompleted: !!r.is_completed,
    workflowType: r.workflow_type ?? 'canvas',
    description: r.description ?? '',
    username: r.username ?? '',
    fullName: r.full_name ?? '',
    createdAt: r.created_at ?? '',
    updatedAt: r.updated_at ?? '',
    hasAgentGeny: !!r.has_agent_geny,
  };
}

export class AgentsApi {
  constructor(private http: HttpClient) {}

  /** Paged agent list matching the UI grid (default page_size 24). */
  async list(query: AgentListQuery = {}): Promise<AgentListResult> {
    const params = new URLSearchParams();
    params.set('page', String(query.page ?? 1));
    params.set('page_size', String(query.pageSize ?? 24));
    if (query.search) params.set('search', query.search);
    if (query.status) params.set('status', query.status);
    if (query.owner) params.set('owner', query.owner);
    if (query.includeHarness) params.set('include_harness', 'true');

    const res = await this.http.get<RawListResponse>(`/api/agentflow/list/detail?${params}`);
    const raw = res.items ?? res.workflows ?? [];
    return {
      items: raw.map(mapAgent),
      pagination: {
        page: res.pagination?.page ?? query.page ?? 1,
        pageSize: res.pagination?.page_size ?? query.pageSize ?? 24,
        totalCount: res.pagination?.total_count ?? raw.length,
        totalPages: res.pagination?.total_pages ?? 1,
      },
    };
  }

  /**
   * Fetch every page and return the full agent list. Convenience for small
   * accounts / pickers; bounded by `maxPages` to avoid runaway loops.
   */
  async listAll(query: AgentListQuery = {}, maxPages = 50): Promise<Agent[]> {
    const first = await this.list({ ...query, page: 1 });
    const all = [...first.items];
    for (let page = 2; page <= Math.min(first.pagination.totalPages, maxPages); page++) {
      const next = await this.list({ ...query, page });
      all.push(...next.items);
    }
    return all;
  }
}
