/**
 * [앱] 탭과 에이전트 [앱] 하위 탭이 함께 쓰는 순수 규칙 — 이름표·상태·거름·확인 문구.
 *
 * 두 화면이 같은 앱을 보여 주므로 같은 말을 해야 한다. 한쪽만 '배포 중지' 라고 하고
 * 다른 쪽이 옛 말을 하면 사람은 두 가지 상태가 있는 줄 안다. 그래서 문구와 판정을
 * 여기 한 곳에 둔다(웹 [Agent APP] 화면의 문구와 같다).
 */
import type {
  AppServingState,
  AppShareState,
  AppSummary,
  MyApp,
  MyAppsResult,
} from '@dex/protocol';

// 이름표·상태·태그·확인 문구는 모바일과 함께 쓴다 — 한 곳(@dex/protocol/app-card)에 둔다.
export {
  APP_CONFIRM,
  appDescription,
  appKindLabel,
  appStatus,
  myAppTags,
  needsPreview,
  storeAppTags,
} from '@dex/protocol/app-card';
export type { AppStatusKey, AppTag, AppTagTone } from '@dex/protocol/app-card';

/** 앱 한 개를 가리키는 키 — 폴더 이름은 에이전트 안에서만 유일하다. */
export function appKey(app: { workflow_id: string; slug: string }): string {
  return `${app.workflow_id}/${app.slug}`;
}

/** [내 앱] 의 거름 — 에이전트 하나(빈 값이면 전부)와 검색어(이름·설명·에이전트·폴더). */
export function filterMyApps(apps: readonly MyApp[], agent: string, query: string): MyApp[] {
  const q = query.trim().toLowerCase();
  return apps.filter(
    (a) =>
      (!agent || a.workflow_id === agent) &&
      (!q ||
        String(a.title ?? '').toLowerCase().includes(q) ||
        String(a.slug ?? '').toLowerCase().includes(q) ||
        String(a.description ?? '').toLowerCase().includes(q) ||
        String(a.workflow_name ?? '').toLowerCase().includes(q)),
  );
}

/** 에이전트 고르개의 목록. 개수는 옆에 따로 둔다(트리거에는 이름만 보인다). */
export function agentFilterOptions(
  res: MyAppsResult | null,
): Array<{ value: string; label: string; count?: number }> {
  return [
    { value: '', label: '모든 에이전트', count: res?.total },
    ...(res?.agents ?? []).map((a) => ({
      value: a.workflow_id,
      label: a.workflow_name || '이름 없는 에이전트',
      count: a.count,
    })),
  ];
}

/**
 * 고른 에이전트가 목록에 아직 있는가 — 없으면 '모든 에이전트' 로.
 *
 * 앱을 다 지웠거나 계정이 바뀌면 남아 있던 거름이 빈 화면을 만든다. 그러면 사람은
 * 거름 때문인 줄 모르고 앱이 사라졌다고 읽는다.
 */
export function validAgentFilter(res: MyAppsResult | null, agent: string): string {
  if (!agent || !res) return agent;
  return res.agents.some((a) => a.workflow_id === agent) ? agent : '';
}

export function myAppsSummary(res: Pick<MyAppsResult, 'total' | 'shared'>): string {
  return `앱 ${res.total}개 · 공개 ${res.shared}개`;
}

export function storeSummary(total: number): string {
  return `공유된 앱 ${total}개`;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));
}

/**
 * 배포 토글의 **서버 응답**을 앱 한 개에 입힌다 — 낙관적 추측이 아니다.
 *
 * 배포를 멈춘 앱은 서버 규칙상 열리지 않으므로(ready=false) 그것도 함께 반영한다. 다시
 * 켠 앱이 열리는지는 매니페스트에 달려 있어 여기서 정하지 않는다 — 곧 다시 읽는 목록이 말한다.
 */
export function withServing<T extends AppSummary>(app: T, res: AppServingState): T {
  return {
    ...app,
    serving: res.serving,
    stopped_by: res.stopped_by,
    stopped_at: res.stopped_at,
    ready: res.serving ? app.ready : false,
  };
}

/** 공유 토글의 서버 응답을 앱 한 개에 입힌다. 링크(토큰)는 목록에 두지 않는다. */
export function withShare<T extends AppSummary>(app: T, res: AppShareState): T {
  // 공개 범위가 없는 옛 서버는 모두에게 공개였다.
  const audience = res.shared ? (res.audience || 'public') : '';
  return { ...app, shared: res.shared, share_audience: audience, shared_by: res.shared_by, shared_at: res.shared_at };
}

/** [내 앱] 목록에서 앱 한 개만 바꾼다. 없으면 그대로 돌려준다. */
export function patchMyApp(
  res: MyAppsResult,
  workflowId: string,
  slug: string,
  patch: (app: MyApp) => MyApp,
): MyAppsResult {
  let hit = false;
  const apps = res.apps.map((a) => {
    if (a.workflow_id !== workflowId || a.slug !== slug) return a;
    hit = true;
    return patch(a);
  });
  return hit ? { ...res, apps } : res;
}

/** epoch 초 → 사람이 읽는 때. 가까우면 상대 시각, 멀면 날짜. */
export function formatWhen(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((now - d.getTime()) / 60_000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}시간 전`;
  return d.toLocaleDateString('ko-KR');
}
