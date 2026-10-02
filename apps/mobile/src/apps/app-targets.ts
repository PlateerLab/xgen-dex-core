/**
 * [열기] 가 어디로 가는가 — 폰 안의 앱 보기(app-viewer)가 여는 주소와 로그인을 정한다(React 없이 시험한다).
 *
 *   내 앱(사이트·앱)   그 앱의 주소를 바로 — 로그인을 싣는다
 *   내 앱(옛 화면)     웹의 앱 화면(/app/…) — 로그인을 싣는다
 *   스토어의 앱        공개 링크 그대로 — 로그인을 싣지 않는다(남의 앱이다)
 */
import { isAppSitePath, type AgentDataApi, type AppSummary, type StoreApp } from '@dex/protocol';
import type { ServerWebContent } from '../lib/server-web-view';
import { serverLink } from '../lib/links';

/** 앱 보기에 필요한 것만 — 시험에서 가짜로 갈아 끼운다. */
export interface AppTargetClient {
  session: { serverUrl: string };
  api: { agentData: Pick<AgentDataApi, 'appWebPath'> };
}

export interface AppViewTarget {
  title: string;
  subtitle?: string;
  content: ServerWebContent;
  /** 기기의 브라우저로 넘길 주소(예전 길). */
  browserUrl: string;
}

/** 내 앱을 폰 안에서 여는 길 — 사이트·앱은 그 주소, 옛 화면은 웹의 앱 화면. 열 수 없으면 null. */
export function myAppTarget(
  client: AppTargetClient,
  app: Pick<AppSummary, 'slug' | 'title' | 'app_url'> & { workflow_id: string; workflow_name?: string },
): AppViewTarget | null {
  const server = client.session.serverUrl;
  const web = serverLink(server, client.api.agentData.appWebPath(app.workflow_id, app.slug));
  const site = isAppSitePath(app.app_url) ? serverLink(server, app.app_url as string) : '';
  const url = site || web;
  if (!url) return null;
  return {
    title: app.title,
    subtitle: app.workflow_name || undefined,
    content: { kind: 'url', url, login: true },
    browserUrl: web || url,
  };
}

/** 스토어의 앱 — 공개 링크(로그인 없이). */
export function storeAppTarget(client: AppTargetClient, app: StoreApp): AppViewTarget | null {
  const url = serverLink(client.session.serverUrl, app.path);
  if (!url) return null;
  return {
    title: app.title,
    subtitle: app.owner_name || undefined,
    content: { kind: 'url', url, login: false },
    browserUrl: url,
  };
}

