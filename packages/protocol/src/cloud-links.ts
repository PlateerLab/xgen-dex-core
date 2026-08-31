/**
 * 이 계정에 연결된 에이전트 목록 — **원본은 서버**다.
 *
 * 클라이언트 설정에 있는 것은 사본일 뿐이라, 다른 기기에서 연결을 끊으면 이쪽
 * 사본은 낡는다. 그래서 목록은 언제나 서버에서 읽고, 클라이언트 설정은 "이 기기가
 * 어느 폴더에 동기화하는가" 같은 기기 사정만 들고 있는다.
 */
import { HttpClient } from './client';

export interface CloudLink {
  workflow_id: string;
  label?: string;
  paused?: boolean;
  paused_reason?: string;
  /** 이름 없는 기기는 클라우드에서 자기 폴더를 갖지 못해 파일이 루트에 섞인다.
   *  서버가 그 상태를 이 값으로 알려 준다. */
  needs_reconnect?: boolean;
  [key: string]: unknown;
}

export interface CloudLinksResponse {
  links?: CloudLink[];
  [key: string]: unknown;
}

/** 목록/생성 경로. 자체 전송(재시도·인증서 정책)을 쓰는 호스트가 경로만 필요할 때. */
export const CLOUD_LINKS_PATH = '/api/cloud/links';

/** 링크 하나의 경로. */
export function cloudLinkPath(workflowId: string): string {
  return `${CLOUD_LINKS_PATH}/${encodeURIComponent(workflowId)}`;
}

export class CloudLinksApi {
  constructor(private http: HttpClient) {}

  list(): Promise<CloudLinksResponse> {
    return this.http.get<CloudLinksResponse>('/api/cloud/links');
  }

  create(body: unknown): Promise<unknown> {
    return this.http.post<unknown>('/api/cloud/links', body);
  }

  remove(workflowId: string): Promise<unknown> {
    return this.http.del<unknown>(`/api/cloud/links/${encodeURIComponent(workflowId)}`);
  }
}
