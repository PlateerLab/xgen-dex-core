// 채팅창에 표시할 로컬 MCP 전달 상태 문구와 색상을 계산한다.
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
      label: '로컬 MCP 확인 중',
      title: '로컬 MCP 상태를 확인하고 있습니다.',
    };
  }
  if (!status.enabled) {
    return { tone: 'off', label: '로컬 MCP 꺼짐', title: '환경설정에서 로컬 MCP 사용을 켜세요.' };
  }
  if (!status.connected) {
    return {
      tone: 'pending',
      label: '로컬 MCP 연결 중',
      title: status.error || 'XGEN 서버의 로컬 MCP WebSocket에 연결하고 있습니다.',
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
      label: '로컬 MCP · 도구 없음',
      title: 'XGEN 서버 연결은 정상이나 전달된 로컬 MCP 도구가 없습니다.',
    };
  }
  return {
    tone: 'ok',
    label: `로컬 MCP · 도구 ${status.serverToolCount}개 전달`,
    title: `XGEN 서버가 로컬 MCP 도구 ${status.serverToolCount}개의 수신을 확인했습니다.`,
  };
}
