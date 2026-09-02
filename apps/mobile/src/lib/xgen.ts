/**
 * XGEN 클라이언트 조립 — React Native.
 *
 * WebView 세대와의 차이: RN 의 fetch/WebSocket 은 네이티브라 CORS 제약이
 * 없고, **WebSocket 에 커스텀 헤더를 실을 수 있다** — 게이트웨이 WS 인증을
 * 데스크톱과 동일하게 `Authorization: Bearer` 로 한다 (쿠키/SameSite 핵 폐기).
 *
 * 저장: 자격증명(자동 로그인)은 SecureStore(키체인/키스토어), 일반 설정은
 * AsyncStorage.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
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

export interface SavedCredentials {
  serverUrl: string;
  email: string;
  password: string;
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
  /** 인증 헤더를 실은 WebSocket 팩토리 — chat-ws/tool-bridge 에 주입한다.
   *  토큰 회전을 따라가도록 매 연결 시점의 세션 토큰을 읽는다. */
  wsFactory: (url: string) => WebSocket;
}

export async function saveCredentials(c: SavedCredentials | null): Promise<void> {
  if (c) await SecureStore.setItemAsync(CRED_KEY, JSON.stringify(c));
  else await SecureStore.deleteItemAsync(CRED_KEY);
}

export async function loadCredentials(): Promise<SavedCredentials | null> {
  const v = await SecureStore.getItemAsync(CRED_KEY).catch(() => null);
  if (!v) return null;
  try {
    return JSON.parse(v) as SavedCredentials;
  } catch {
    return null;
  }
}

/** RN WebSocket 은 세 번째 인자로 headers 를 받는다 (lib.dom 타입엔 없어 캐스팅). */
type RnWebSocketCtor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export function buildClient(session: MobileSession, onAuthFailure?: () => void): XgenMobileClient {
  const api = new XgenClient({
    baseUrl: session.serverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    fetch: loggingFetch,
    onAuthFailure,
    // 토큰 회전 시 저장분 갱신 — 다음 WS 연결이 새 토큰 헤더를 집는다.
    onTokensRotated: (accessToken, refreshToken) => {
      session.accessToken = accessToken;
      if (refreshToken !== undefined) session.refreshToken = refreshToken;
      void AsyncStorage.setItem(PREF_KEY, JSON.stringify(session));
    },
  });
  const wsFactory = (url: string): WebSocket => {
    const Ctor = WebSocket as unknown as RnWebSocketCtor;
    return new Ctor(url, null, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  };
  return { api, session, wsFactory };
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
  await AsyncStorage.setItem(PREF_KEY, JSON.stringify(session));
  return session;
}

export async function restoreSession(): Promise<MobileSession | null> {
  const v = await AsyncStorage.getItem(PREF_KEY).catch(() => null);
  if (!v) return null;
  try {
    const session = JSON.parse(v) as MobileSession;
    if (!session.serverUrl || !session.accessToken) return null;
    return session;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(PREF_KEY);
}

export function newInteractionId(workflowId: string): string {
  return `mob-${workflowId}-${Date.now()}`;
}
