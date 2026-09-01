import type { CapacitorConfig } from '@capacitor/cli';

/**
 * XGEN Dex Android — 설정.
 *
 * - CapacitorHttp: REST(login/목록/히스토리)를 네이티브 HTTP 로 보낸다 —
 *   WebView 교차출처(CORS) 제약을 우회한다. 실시간(채팅/도구 브리지)은
 *   WebSocket 이라 CORS 대상이 아니고 WebView 소켓을 그대로 쓴다.
 * - CapacitorCookies: 게이트웨이 WS 인증은 쿠키(xgen_access_token)다 —
 *   로그인 후 네이티브 쿠키 저장소에 심으면 WebView WS 가 자동 동봉한다.
 * - cleartext: 사내 http:// 게이트웨이 배포 지원 (usesCleartextTraffic).
 */
const config: CapacitorConfig = {
  appId: 'com.plateerlab.xgendex',
  appName: 'XGEN Dex',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  plugins: {
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
  },
};

export default config;
