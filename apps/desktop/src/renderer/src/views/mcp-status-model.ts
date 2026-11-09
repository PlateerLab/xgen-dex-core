// 채팅창(디버그)에 표시할 "이 PC 연결" 상태 문구와 색상을 계산한다.
//
// 이 연결은 로그인하면 늘 켜져 있다. 에이전트가 이 PC 의 파일·터미널을 쓸 수
// 있는지는 연결이 아니라 대화마다 채팅 헤더의 [폴더 연결]이 정한다 — 그래서 여기
// 문구는 "켜라"가 아니라 연결과 도구 전달이 제대로 되는지만 말한다.
import {
  UNSUPPORTED_CONNECTOR_PROTOCOL,
  unsupportedConnectorProtocolNotice,
} from '@dex/protocol/connector-protocol';
import type { McpBridgeStatusLike } from '../../../preload/index';

export type McpChatStatus = {
  tone: 'off' | 'pending' | 'ok';
  label: string;
  title: string;
};

export function mcpChatStatus(status: McpBridgeStatusLike | null): McpChatStatus {
  if (!status) {
    return {
      tone: 'pending',
      label: '이 PC 연결 확인 중',
      title: '이 PC와 XGEN 서버의 연결 상태를 확인하고 있습니다.',
    };
  }
  if (!status.enabled) {
    return { tone: 'off', label: '이 PC 연결 안 됨', title: '로그인하면 이 PC를 XGEN 서버에 연결합니다.' };
  }
  if (!status.connected) {
    return {
      tone: 'pending',
      label: '이 PC 연결 중',
      title: status.error || 'XGEN 서버에 이 PC 를 연결하고 있습니다.',
    };
  }
  if (status.error === UNSUPPORTED_CONNECTOR_PROTOCOL) {
    return {
      tone: 'off',
      label: '서버 업데이트 필요',
      title: unsupportedConnectorProtocolNotice(),
    };
  }
  if (!status.catalogSynced) {
    return {
      tone: 'pending',
      label: '도구 전달 확인 중',
      title: 'WebSocket은 연결됐지만 XGEN 서버의 최신 도구 카탈로그 수신 확인을 기다리고 있습니다.',
    };
  }
  if (status.serverToolCount === 0) {
    return {
      tone: 'pending',
      label: '이 PC 연결됨 · 도구 없음',
      title: 'XGEN 서버 연결은 정상이나 전달된 이 PC 의 도구가 없습니다.',
    };
  }
  return {
    tone: 'ok',
    label: `이 PC 연결됨 · 도구 ${status.serverToolCount}개 전달`,
    title: `XGEN 서버가 이 PC 의 도구 ${status.serverToolCount}개의 수신을 확인했습니다.`,
  };
}

/**
 * 채팅창에 **항상**(디버그가 아니어도) 띄울 안내 — 서버가 이 DeX 의 도구 연결 방식(v2)을 모른다.
 *
 * 이때 에이전트는 도구를 보지만 부르면 바로 실패한다. 위 상태 단추는 MCP 디버그를 켠 사람만 보므로,
 * 처음 쓰는 사람은 이유를 모른 채 "브라우저가 안 된다"만 겪었다(2026-11-06 체험존).
 */
export function mcpServerMismatchNotice(status: McpBridgeStatusLike | null): string | null {
  if (!status?.enabled || !status.connected) return null;
  return status.error === UNSUPPORTED_CONNECTOR_PROTOCOL ? unsupportedConnectorProtocolNotice() : null;
}
