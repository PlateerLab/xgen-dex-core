/**
 * Teams 실시간 소켓의 **주소**.
 *
 * 소켓을 여는 일은 호스트가 한다(재접속·하트비트·인증서 정책이 호스트마다 다르다).
 * 여기 있는 것은 "어디로 붙는가" 하나뿐이고, 그거면 충분하다 — 서버가 경로를 바꿀 때
 * 고칠 자리가 하나가 된다.
 */

/** 사용자 소켓의 서버 상대 경로. 호스트가 base 를 붙여 쓴다. */
export const TEAMS_USER_SOCKET_PATH = '/api/teams/ws/user';

/** 방 소켓의 서버 상대 경로. */
export function teamsRoomSocketPath(roomId: string): string {
  return `/api/teams/ws/${encodeURIComponent(roomId)}`;
}

function wsBase(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
}

/** 이 사용자의 전역 알림 소켓. */
export function teamsUserSocketUrl(serverUrl: string): string {
  return `${wsBase(serverUrl)}/api/teams/ws/user`;
}

/** 방 하나의 소켓. */
export function teamsRoomSocketUrl(serverUrl: string, roomId: string): string {
  return `${wsBase(serverUrl)}/api/teams/ws/${encodeURIComponent(roomId)}`;
}
