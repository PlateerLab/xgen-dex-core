/**
 * IDE 보기 — 서버(xgen-workflow `geny_ide`)와 말하는 법.
 *
 * IDE 는 에이전트의 스토리지·샌드박스를 편집기처럼 보여 주는 보기다. 파일 목록은 스토리지와
 * **같은 경로**(`/storage/list`)를 쓰고, 편집기·터미널·찾기·소스 제어만 `/ide/*` 로 간다.
 * 권한은 스토리지와 같다(에이전트 주인 또는 관리자). 고정된 에이전트는 보기만 한다.
 */
import { ApiError, type HttpClient } from './client';

export interface IdeSessionResponse {
  workflow_id: string;
  ready: boolean;
  readonly: boolean;
  terminals: { id: string; cwd?: string; shell?: string; running?: boolean; attached?: number }[];
  user?: { id?: string; name?: string };
  limits?: { editor_max_bytes?: number; raw_max_bytes?: number };
}

export interface IdeFileResponse {
  path: string;
  content_b64: string;
  sha: string;
  size: number;
  mtime?: number;
}

export interface IdeSaveRequest {
  path: string;
  content_b64: string;
  /** `''` = 새 파일(이미 있으면 409), `null` = 조건 없이, sha = 그 판일 때만. */
  base_sha: string | null;
}

export interface IdeSaveResponse {
  path: string;
  sha: string;
  bytes: number;
  published: { seq?: number | null; changed: number; deleted: number; conflicts: string[]; refused: string[]; error?: string | null };
}

export interface IdeStorageEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number | null;
  modified_at: string;
  origin: string;
  origin_name: string;
}

/** 서버 오류를 화면이 쓸 모양으로 — `{code, message, 그 밖의 상세}`. */
export interface IdeFailure {
  status: number;
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

const STATUS_CODE: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  503: 'sandbox_unavailable',
  504: 'timeout',
};

export function ideFailureOf(err: unknown): IdeFailure {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | string | undefined;
    const detail = typeof body === 'object' && body ? body.detail : body;
    if (detail && typeof detail === 'object') {
      const d = detail as Record<string, unknown>;
      return {
        status: err.status,
        code: String(d.code ?? STATUS_CODE[err.status] ?? 'error'),
        message: String(d.message ?? d.detail ?? '요청을 처리하지 못했습니다'),
        detail: d,
      };
    }
    return {
      status: err.status,
      code: STATUS_CODE[err.status] ?? 'error',
      message: typeof detail === 'string' && detail ? detail : '요청을 처리하지 못했습니다',
      detail: {},
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const timeout = /abort|timeout/i.test(message);
  return {
    status: 0,
    code: timeout ? 'timeout' : 'network',
    message: timeout ? '서버가 제때 답하지 않았습니다' : '서버에 연결하지 못했습니다',
    detail: {},
  };
}

function base(workflowId: string): string {
  return `/api/agentflow/geny-workspace/${encodeURIComponent(workflowId)}`;
}

/** 터미널 소켓의 서버 상대 경로 — 호스트가 ws(s) base 를 붙인다. */
export function ideTerminalSocketPath(
  workflowId: string,
  termId: string,
  q: { rows: number; cols: number; cwd?: string; create?: boolean },
): string {
  const params = new URLSearchParams({ rows: String(q.rows), cols: String(q.cols) });
  if (q.cwd) params.set('cwd', q.cwd);
  if (q.create === false) params.set('create', '0');
  return `/api/agentflow/ws/geny-ide/${encodeURIComponent(workflowId)}/terminal/${encodeURIComponent(termId)}?${params}`;
}

export class IdeApi {
  constructor(private readonly http: HttpClient) {}

  session(workflowId: string): Promise<IdeSessionResponse> {
    // 차가운 샌드박스는 붙는 데(보관본 복원) 시간이 걸린다.
    return this.http.post<IdeSessionResponse>(`${base(workflowId)}/ide/session`, {}, { timeoutMs: 120_000 });
  }

  /** 탐색기 — 스토리지 목록 그대로. */
  files(workflowId: string): Promise<{ workflow_id: string; files: IdeStorageEntry[] }> {
    return this.http.get(`${base(workflowId)}/storage/list`);
  }

  read(workflowId: string, path: string): Promise<IdeFileResponse> {
    return this.http.get(`${base(workflowId)}/ide/file?${new URLSearchParams({ path })}`, { timeoutMs: 60_000 });
  }

  save(workflowId: string, body: IdeSaveRequest): Promise<IdeSaveResponse> {
    return this.http.json('PUT', `${base(workflowId)}/ide/file`, body, { timeoutMs: 120_000 });
  }

  stat(workflowId: string, paths: string[]): Promise<{ entries: Record<string, { kind: string; size?: number; mtime?: number; sha?: string }> }> {
    return this.http.post(`${base(workflowId)}/ide/stat`, { paths });
  }

  async raw(workflowId: string, path: string): Promise<Uint8Array> {
    const out = await this.http.getBinary(`${base(workflowId)}/ide/raw?${new URLSearchParams({ path })}`);
    return out.bytes;
  }

  /** 내려받기 주소(서버 상대) — 브라우저가 바로 여는 곳에서 쓴다. */
  rawPath(workflowId: string, path: string, download = false): string {
    const q = new URLSearchParams({ path });
    if (download) q.set('download', 'true');
    return `${base(workflowId)}/ide/raw?${q}`;
  }

  fs(workflowId: string, op: Record<string, unknown>): Promise<{ ok: boolean; is_dir?: boolean }> {
    return this.http.post(`${base(workflowId)}/ide/fs`, op, { timeoutMs: 120_000 });
  }

  search(workflowId: string, q: Record<string, unknown>): Promise<unknown> {
    return this.http.post(`${base(workflowId)}/ide/search`, q, { timeoutMs: 120_000 });
  }

  replace(workflowId: string, q: Record<string, unknown>): Promise<unknown> {
    return this.http.post(`${base(workflowId)}/ide/replace`, q, { timeoutMs: 180_000 });
  }

  /** git 동작 하나. 네트워크를 타는 것(풀·푸시·복제)은 오래 걸릴 수 있다. */
  git(workflowId: string, args: Record<string, unknown>): Promise<unknown> {
    return this.http.post(`${base(workflowId)}/ide/git`, args, { timeoutMs: 620_000 });
  }

  terminals(workflowId: string): Promise<{ terminals: IdeSessionResponse['terminals'] }> {
    return this.http.get(`${base(workflowId)}/ide/terminals`);
  }

  closeTerminal(workflowId: string, termId: string): Promise<{ closed: boolean }> {
    return this.http.json('DELETE', `${base(workflowId)}/ide/terminals/${encodeURIComponent(termId)}`);
  }
}
