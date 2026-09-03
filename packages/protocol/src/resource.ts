/**
 * ResourceApi - 에이전트 단위 자원(지식그래프·카탈로그·검색·답).
 *
 * 서버(xgen-documents) `/api/retrieval/resource/*` 를 그대로 부른다. `agent`(workflow_id)를 주면 그 에이전트의
 * 자원 뷰(허브 = 에이전트, 소유·캔버스 설정·턴 실적 결속)이고, 없으면 계정 전체다. 답(`answer`)은 그 에이전트
 * vault 에 기억으로 남아 같은 질문은 기억만으로 답한다 - 웹의 에이전트 상세 [자원] 탭과 같은 표면이다.
 * 응답은 서버 와이어 포맷(snake_case) 그대로다.
 */
import { HttpClient } from './client';

export type ResourceNodeType =
  | 'user' | 'agent' | 'tool' | 'api_tool' | 'memory' | 'collection' | 'file' | 'mcp' | 'device' | 'tool_collection' | 'llm';

export interface ResourceGraphNode {
  id: string;
  type: ResourceNodeType;
  label: string;
  meta: Record<string, unknown>;
}

export interface ResourceGraphEdge {
  source: string;
  target: string;
  kind: string;
  meta?: Record<string, unknown>;
}

export interface ResourceGraphResponse {
  nodes: ResourceGraphNode[];
  edges: ResourceGraphEdge[];
  stats: {
    counts: Record<string, number>;
    node_total: number;
    edge_total: number;
    shared: number;
    scope?: { agent: string; hub: string; found: boolean; label?: string | null };
  };
}

export interface ResourceCatalogItem {
  type: ResourceNodeType;
  name: string;
  status?: string;
  detail?: string;
  context?: string;
  updated_at?: string | null;
  ref?: Record<string, unknown>;
}

export interface ResourceCatalogResponse {
  items: ResourceCatalogItem[];
  counts: Record<string, number>;
  total: number;
  shared: number;
}

export interface ResourceSearchHit {
  id: string;
  type: ResourceNodeType;
  label: string;
  score: number;
  channels?: string[];
  snippet?: string | null;
}

export interface ResourceSearchResponse {
  query: string;
  hits: ResourceSearchHit[];
  channels: string[];
  recall?: { fresh: boolean; hit: { id: string; question?: string; has_answer?: boolean } } | null;
}

export interface ResourceAnswerResponse {
  question: string;
  answer: string;
  from_memory: boolean;
  mode: 'memory' | 'llm' | 'extractive';
  scope?: 'agent' | 'user';
  note_id: string | null;
  saved: boolean;
  answered_at?: string | null;
  sources: Array<{ id: string; type: ResourceNodeType; label: string; snippet?: string; meta?: Record<string, unknown> }>;
}

function withAgent(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export class ResourceApi {
  constructor(private readonly http: HttpClient) {}

  /** 그래프(노드·엣지·카운트). agent 가 있으면 그 에이전트 뷰. */
  graph(agent?: string): Promise<ResourceGraphResponse> {
    return this.http.get<ResourceGraphResponse>(`/api/retrieval/resource/graph${withAgent({ agent })}`);
  }

  /** 유형별 목록 + 카운트. */
  catalog(agent?: string, type?: ResourceNodeType): Promise<ResourceCatalogResponse> {
    return this.http.get<ResourceCatalogResponse>(`/api/retrieval/resource/catalog${withAgent({ agent, type })}`);
  }

  /** 융합 검색(메타·내용·관계·범주·확답) + 기억 선조회. */
  search(q: string, opts: { agent?: string; topK?: number } = {}): Promise<ResourceSearchResponse> {
    return this.http.get<ResourceSearchResponse>(
      `/api/retrieval/resource/search${withAgent({ q, agent: opts.agent, top_k: opts.topK })}`,
    );
  }

  /** 질문 → 답. 같은 질문의 기억이 있으면 기억만으로, 없으면 검색해 답을 만들고 vault 에 남긴다. force 는 기억을 건너뛴다. */
  answer(q: string, opts: { agent?: string; force?: boolean; topK?: number } = {}): Promise<ResourceAnswerResponse> {
    return this.http.post<ResourceAnswerResponse>('/api/retrieval/resource/answer', {
      q, agent: opts.agent ?? null, force: opts.force ?? false, top_k: opts.topK ?? 8, save: true,
    });
  }
}
