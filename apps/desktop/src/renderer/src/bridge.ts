/** Typed handle to the preload bridge exposed as `window.xgen`. */
import type { XgenBridge } from '../../preload/index';

declare global {
  interface Window {
    xgen: XgenBridge;
  }
}

// Node 테스트(렌더러 밖)에서 이 모듈을 import 해도 터지지 않도록 window 접근을 가드한다.
// 실제 렌더러에서는 window.xgen 이 항상 있다. copyText 등은 xgen 부재를 이미 null-check 한다.
export const xgen: XgenBridge = (
  typeof window !== 'undefined' ? window.xgen : undefined
) as XgenBridge;

/**
 * 텍스트를 클립보드로 복사한다 — **main 프로세스 clipboard 를 우선** 쓴다.
 * 렌더러의 `navigator.clipboard.writeText` 는 Electron 에서 권한/보안 컨텍스트
 * 때문에 "Write permission denied" 로 조용히 실패한다(채팅 코드블록/진단 복사가
 * 안 되던 원인). main 경유가 실패할 때만 navigator 로 폴백한다. 성공 여부를 돌려주어
 * 호출부가 "복사됨" 표시를 정확히 걸 수 있게 한다.
 */
export async function copyText(text: string): Promise<boolean> {
  const value = String(text ?? '');
  try {
    if (xgen?.clipboard?.write) {
      const ok = await xgen.clipboard.write(value);
      if (ok) return true;
    }
  } catch {
    /* main 경유 실패 — navigator 폴백 */
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
