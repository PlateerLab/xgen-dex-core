/**
 * 다운로드 센터 — XGEN 서버가 배포하는 설치본 목록과 내려받기.
 *
 * 자동 업데이트가 GitHub Release 가 아니라 **사용자의 XGEN 서버**를 볼 수 있어야
 * 하는 이유: 사내망 배포는 GitHub 에 못 나가고, 조직마다 배포 시점을 따로 잡는다.
 * 그래서 서버가 자기 설치본을 들고 있고 클라이언트는 거기서 받는다.
 *
 * 경로가 여기 있어야 하는 이유는 더 단순하다 — 데스크톱만 업데이트하는 것이
 * 아니기 때문이다. CLI 도 확장도 같은 센터에서 자기 것을 받아야 하고, 경로가
 * 앱 안에 박혀 있으면 그때 또 복사된다.
 */
import { HttpClient } from './client';

/** 서버가 들고 있는 설치본 하나. */
export interface InstallerPackage {
  id: string | number;
  /** 'connector' | 'cli' | 'vscode' — 어떤 제품의 설치본인가. */
  product?: string;
  version?: string;
  /** 'win32' | 'darwin' | 'linux' */
  platform?: string;
  arch?: string;
  original_name?: string;
  size?: number;
  /** 내려받은 파일을 검증하는 유일한 근거. 없으면 설치하지 않는다. */
  sha256?: string;
  created_at?: string;
  notes?: string;
}

export interface InstallerListResponse {
  data?: InstallerPackage[];
}

/** 목록 경로 — 자체 전송(진행률·타임아웃)을 쓰는 호스트가 경로만 필요할 때. */
export function installerListPath(product: string): string {
  return `/api/support/v1/installers/list?product=${encodeURIComponent(product)}`;
}

/** 다운로드 경로. 본문이 크고 진행률이 필요해 전송은 호스트가 한다. */
export function installerDownloadPath(id: string | number): string {
  return `/api/support/v1/installers/download/${encodeURIComponent(String(id))}`;
}

export class InstallersApi {
  constructor(private http: HttpClient) {}

  /** 제품별 설치본 목록. 최신 판정은 부르는 쪽이 한다 — 플랫폼·아키텍처·버전
   *  비교 규칙이 제품마다 다르기 때문이다. */
  list(product: string): Promise<InstallerListResponse> {
    return this.http.get<InstallerListResponse>(
      `/api/support/v1/installers/list?product=${encodeURIComponent(product)}`,
    );
  }

  /** 설치본 하나의 다운로드 경로. 본문이 크고 진행률이 필요해 스트림으로 받는다 —
   *  그래서 여기서는 **경로만** 만들고, 실제 전송은 호스트가 자기 방식으로 한다. */
  downloadPath(id: string | number): string {
    return `/api/support/v1/installers/download/${encodeURIComponent(String(id))}`;
  }
}
