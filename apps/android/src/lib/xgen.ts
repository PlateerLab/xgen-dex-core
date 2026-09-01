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
  await CapacitorCookies.setCookie({
    url: serverUrl,
    key: 'xgen_access_token',
    value: token,
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
