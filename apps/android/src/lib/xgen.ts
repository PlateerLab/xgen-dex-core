/**
 * XGEN 클라이언트 조립 — 모바일.
 *
 * REST(로그인/에이전트 목록/히스토리)는 @dex/protocol 을 그대로 쓴다 —
 * capacitor.config 의 CapacitorHttp 가 전역 fetch 를 네이티브로 패치하므로
 * WebView CORS 제약이 없다. 실시간(채팅/도구 브리지)은 WebSocket 이고,
 * 게이트웨이 WS 인증은 쿠키 `xgen_access_token` 이다 — 로그인 후
 * CapacitorCookies 로 네이티브 쿠키 저장소에 심으면 WebView WS 가 자동
 * 동봉한다.
 */

import { CapacitorCookies } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { XgenClient } from '@dex/protocol';
import { diagLog, loggingFetch } from './diag';

export interface MobileSession {
  serverUrl: string;
  accessToken: string;
  refreshToken?: string;
  userId: string;
  username: string;
}

const PREF_KEY = 'xgen-session';
const CRED_KEY = 'xgen-credentials';

/** 자동 로그인용 자격증명 (사용자가 켠 경우에만 저장). */
export interface SavedCredentials {
  serverUrl: string;
  email: string;
  password: string;
}

export async function saveCredentials(c: SavedCredentials | null): Promise<void> {
  if (c) await Preferences.set({ key: CRED_KEY, value: JSON.stringify(c) });
  else await Preferences.remove({ key: CRED_KEY });
}

export async function loadCredentials(): Promise<SavedCredentials | null> {
  const r = await Preferences.get({ key: CRED_KEY });
  if (!r.value) return null;
  try {
    return JSON.parse(r.value) as SavedCredentials;
  } catch {
    return null;
  }
}

export function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  return url;
}

export function wsBaseOf(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws');
}

export interface XgenMobileClient {
  api: XgenClient;
  session: MobileSession;
}

async function setAuthCookie(serverUrl: string, token: string): Promise<void> {
  // 게이트웨이 WS(geny-chat / connector-mcp) 인증 재료 — 웹 프론트와 동일 쿠키.
  //
  // ⚠ SameSite: WebView 오리진(https://localhost)에서 게이트웨이로 가는 WS 는
  // **크로스사이트**다 — 기본 SameSite=Lax 쿠키는 핸드셰이크에 실리지 않아
  // 401 → '연결 중' 무한이 된다 (실사고). CapacitorCookies 는 속성 인자가
  // 없지만 네이티브 CookieManager 가 "key=value; 속성..." 전체 문자열을
  // 파싱하므로 value 뒤에 속성을 실어 보낸다. SameSite=None 은 Secure 필수
  // — https 서버에서만 붙인다 (http 사내 게이트웨이는 Lax 로 두되, 그 경우
  // WebView 정책상 WS 쿠키가 막힐 수 있어 https 사용을 권장).
  const secure = serverUrl.startsWith('https://');
  await CapacitorCookies.setCookie({
    url: serverUrl,
    key: 'xgen_access_token',
    value: secure ? `${token}; Path=/; SameSite=None; Secure` : `${token}; Path=/`,
  });
}

export function buildClient(session: MobileSession, onAuthFailure?: () => void): XgenMobileClient {
  const api = new XgenClient({
    baseUrl: session.serverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    fetch: loggingFetch, // 진단 패널에 모든 REST 왕복 기록
    onAuthFailure,
    // 토큰 회전 시 저장분/쿠키 동기화 — WS(채팅/도구 브리지)가 폐기 토큰
    // 쿠키로 403 을 맞지 않게 한다.
    onTokensRotated: (accessToken, refreshToken) => {
      session.accessToken = accessToken;
      if (refreshToken !== undefined) session.refreshToken = refreshToken;
      void setAuthCookie(session.serverUrl, accessToken);
      void Preferences.set({ key: PREF_KEY, value: JSON.stringify(session) });
    },
  });
  return { api, session };
}

export async function login(
  serverUrlRaw: string,
  email: string,
  password: string,
): Promise<MobileSession> {
  const serverUrl = normalizeServerUrl(serverUrlRaw);
  const api = new XgenClient({ baseUrl: serverUrl, fetch: loggingFetch });
  const r = await api.login(email, password);
  diagLog(`로그인 성공: user=${r.userId} (${r.username})`);
  const session: MobileSession = {
    serverUrl,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    userId: String(r.userId),
    username: r.username,
  };
  await setAuthCookie(serverUrl, r.accessToken);
  await Preferences.set({ key: PREF_KEY, value: JSON.stringify(session) });
  return session;
}

export async function restoreSession(): Promise<MobileSession | null> {
  const r = await Preferences.get({ key: PREF_KEY });
  if (!r.value) return null;
  try {
    const session = JSON.parse(r.value) as MobileSession;
    if (!session.serverUrl || !session.accessToken) return null;
    await setAuthCookie(session.serverUrl, session.accessToken);
    return session;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await Preferences.remove({ key: PREF_KEY });
}

export function newInteractionId(workflowId: string): string {
  return `mob-${workflowId}-${Date.now()}`;
}
