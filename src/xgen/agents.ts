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
  workflows?: RawAgent[];
  pagination?: {
    page: number;
    page_size: number;
    total_count: number;
    total_pages: number;
  };
}

function mapAgent(raw: RawAgent): Agent {
  return {
    id: raw.id,
    workflowId: raw.workflow_id,
    workflowName: raw.workflow_name,
    nodeCount: raw.node_count ?? 0,
    isShared: !!raw.is_shared,
    isDeployed: !!raw.is_deployed,
    isCompleted: !!raw.is_completed,
    workflowType: raw.workflow_type ?? 'canvas',
    description: raw.description ?? '',
    username: raw.username ?? '',
    fullName: raw.full_name ?? '',
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
    hasAgentGeny: !!raw.has_agent_geny,
  };
}

export class AgentsApi {
  constructor(private readonly http: HttpClient) {}

  async list(query: AgentListQuery = {}): Promise<AgentListResult> {
    const params = new URLSearchParams();
    params.set('page', String(query.page ?? 1));
    params.set('page_size', String(query.pageSize ?? 24));
    if (query.search) params.set('search', query.search);
    if (query.status) params.set('status', query.status);
    if (query.owner) params.set('owner', query.owner);
    if (query.includeHarness) params.set('include_harness', 'true');
    const response = await this.http.get<RawListResponse>(`/api/agentflow/list/detail?${params}`);
    const items = (response.items ?? response.workflows ?? []).map(mapAgent);
    return {
      items,
      pagination: {
        page: response.pagination?.page ?? query.page ?? 1,
        pageSize: response.pagination?.page_size ?? query.pageSize ?? 24,
        totalCount: response.pagination?.total_count ?? items.length,
        totalPages: response.pagination?.total_pages ?? 1,
      },
    };
  }

  async listAll(query: AgentListQuery = {}, maxPages = 50): Promise<Agent[]> {
    const first = await this.list({ ...query, page: 1 });
    const items = [...first.items];
    for (let page = 2; page <= Math.min(first.pagination.totalPages, maxPages); page += 1) {
      items.push(...(await this.list({ ...query, page })).items);
    }
    return items;
  }
}
