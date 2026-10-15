/**
 * 에이전트 뷰어 [워크플로우] 탭 캔버스의 주소 규칙(electron 없이 시험할 수 있게 canvas-embed 에서 뗐다).
 */

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 캔버스 주소. 주인은 힌트다: 캔버스가 불러온 결과(owner_user_id)로 다시 정한다(웹 [편집]과 같다). */
export function canvasUrl(server: string, workflowId: string, ownerUserId?: string | null): string {
  const query = new URLSearchParams({ load: workflowId, embed: '1' });
  if (ownerUserId) query.set('user_id', ownerUserId);
  return `${server.replace(/\/+$/, '')}/canvas?${query.toString()}`;
}

/** 붙여도 되는 주소인가: 설정된 서버의 `/canvas` 뿐. */
export function isCanvasUrl(server: string, url: string): boolean {
  const origin = originOf(server);
  if (!origin) return false;
  try {
    const target = new URL(url);
    return target.origin === origin && target.pathname === '/canvas';
  } catch {
    return false;
  }
}
