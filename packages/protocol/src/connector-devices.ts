/**
 * 커넥터 기기 목록 — "지금 내 계정에 어떤 커넥터가 붙어 어떤 도구를 몇 개
 * 광고 중인가"의 단일 창구 (xgen-workflow /api/tools/connector-mcp/devices).
 *
 * 멀티 디바이스 커넥터(같은 계정의 데스크톱/CLI/VSCode/모바일 공존)의 상태
 * 대시보드가 이 API 를 그린다. WS 가 붙은 파드 기준의 파드-로컬 관측이다.
 */
import type { HttpClient } from './client';

export interface ConnectorDevice {
  deviceId: string;
  name: string;
  platform: string;
  /** epoch seconds — 없으면 undefined. */
  connectedAt?: number;
  lastActivity?: number;
  toolCount: number;
}

interface RawDevice {
  device_id?: string;
  name?: string;
  platform?: string;
  connected_at?: number | null;
  last_activity?: number | null;
  tool_count?: number;
}

export class ConnectorDevicesApi {
  constructor(private http: HttpClient) {}

  /** 연결된 커넥터 기기 목록 (최근 활동순). */
  async list(): Promise<ConnectorDevice[]> {
    const res = await this.http.get<{ devices?: RawDevice[] }>(
      '/api/tools/connector-mcp/devices',
    );
    return (res.devices ?? []).map((d) => ({
      deviceId: String(d.device_id ?? ''),
      name: String(d.name ?? d.device_id ?? ''),
      platform: String(d.platform ?? ''),
      connectedAt: typeof d.connected_at === 'number' ? d.connected_at : undefined,
      lastActivity: typeof d.last_activity === 'number' ? d.last_activity : undefined,
      toolCount: Number(d.tool_count ?? 0),
    }));
  }
}
