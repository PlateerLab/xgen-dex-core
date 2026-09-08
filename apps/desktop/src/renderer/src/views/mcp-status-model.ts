// 채팅창에 표시할 [로컬 컨트롤] 전달 상태 문구와 색상을 계산한다.
//
// 이름에 대하여: 예전 이름은 "Local PC MCP" 였다. MCP 는 이 기능이 서버에 도구를
// 전하는 **수단**일 뿐인데 이름이 그 수단을 앞세워, 사용자에게는 무슨 기능인지
// 읽히지 않았다. 사람이 읽어야 하는 것은 "이 컴퓨터를 에이전트가 조작한다" 이고,
// 그 이름이 [로컬 컨트롤] 이다. (파일명은 그대로 둔다 — 이름 바꾸기와 파일
// 옮기기를 한 커밋에 섞으면 diff 가 읽히지 않는다.)
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
      label: '로컬 컨트롤 확인 중',
      title: '로컬 컨트롤 상태를 확인하고 있습니다.',
    };
  }
  if (!status.enabled) {
    return { tone: 'off', label: '로컬 컨트롤 꺼짐', title: '환경설정 > 로컬 컨트롤에서 켜세요.' };
  }
  if (!status.connected) {
    return {
      tone: 'pending',
      label: '로컬 컨트롤 연결 중',
      title: status.error || 'XGEN 서버에 이 PC 를 연결하고 있습니다.',
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
      label: '로컬 컨트롤 · 도구 없음',
      title: 'XGEN 서버 연결은 정상이나 전달된 이 PC 의 도구가 없습니다.',
    };
  }
  return {
    tone: 'ok',
    label: `로컬 컨트롤 · 도구 ${status.serverToolCount}개 전달`,
    title: `XGEN 서버가 이 PC 의 도구 ${status.serverToolCount}개의 수신을 확인했습니다.`,
  };
}
