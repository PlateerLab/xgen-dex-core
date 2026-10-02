/**
 * 앱 카드의 말과 판정 — 데스크톱 [앱] 탭·모바일 [앱]·에이전트 [앱] 하위 탭이 함께 쓴다.
 *
 * 카드의 모양은 세 화면(웹 포함)이 같다:
 *
 *   [앱 이름] [태그…]
 *   [설명]
 *   [미리보기 그림 — 못 받으면 기본 그림]
 *   [버튼…]
 *
 * 같은 앱을 보여 주므로 같은 말을 해야 한다. 한쪽만 '배포 중지' 라고 하고 다른 쪽이 옛 말을 하면
 * 사람은 두 가지 상태가 있는 줄 안다. 그래서 이름표·상태·태그·확인 문구를 여기 한 곳에 둔다
 * (웹 [Agent APP] 화면의 문구와 같다).
 */
import type { AppSummary, MyApp, StoreApp } from './agent-data';

/**
 * 확인 문구. 켤 때는 **무엇이 열리는지**, 끌 때는 **무엇이 되돌아오지 않는지**를 한 줄로.
 * 길게 적어 봤더니 아무도 안 읽었고, 안 읽히는 확인은 확인이 아니다.
 */
export const APP_CONFIRM = {
  share: '공개 링크를 만들까요?\n링크를 아는 사람은 누구나 로그인 없이 이 화면을 쓸 수 있습니다.',
  unshare: '공개 링크를 닫을까요?\n이미 나간 링크는 되살아나지 않습니다.',
  undeploy: '배포를 중지할까요?\n내용은 그대로 두고 앱과 공개 링크를 닫습니다.',
} as const;

const KIND_LABELS: Record<string, string> = {
  service: '앱',
  project: '사이트',
  component: '화면',
};

/** 앱의 모양 이름. 서버가 모르는 값을 주면 '앱' 으로 부른다(웹과 같다). */
export function appKindLabel(kind: string | null | undefined): string {
  return KIND_LABELS[String(kind ?? '')] ?? KIND_LABELS.service;
}

export type AppStatusKey = 'ready' | 'stopped' | 'broken';

/**
 * 지금 열리는가. 사람이 내린 것(배포 중지)과 코드가 깨진 것(열 수 없음)을 **구분한다** —
 * 앞의 것은 버튼 한 번이면 되고 뒤의 것은 에이전트가 고칠 일이다.
 */
export function appStatus(app: Pick<AppSummary, 'serving' | 'ready'>): {
  key: AppStatusKey;
  label: string;
} {
  if (!app.serving) return { key: 'stopped', label: '배포 중지' };
  if (app.ready) return { key: 'ready', label: '열림' };
  return { key: 'broken', label: '열 수 없음' };
}

/** 태그의 색 계열 — 각 화면이 자기 색으로 칠한다. */
export type AppTagTone = 'kind' | 'ready' | 'stopped' | 'broken' | 'shared' | 'muted';

export interface AppTag {
  label: string;
  tone: AppTagTone;
}

/**
 * [내 앱] 카드의 태그 — 모양, 상태, 공개 여부, 만든 에이전트.
 * 토글이 도는 동안(`pending`)에는 상태를 말하지 않는다 — 곧 다시 읽는 목록이 답한다.
 */
export function myAppTags(app: MyApp, opts?: { pending?: boolean }): AppTag[] {
  const tags: AppTag[] = [{ label: appKindLabel(app.kind), tone: 'kind' }];
  if (!opts?.pending) {
    const status = appStatus(app);
    tags.push({ label: status.label, tone: status.key });
  }
  if (app.shared && app.serving) tags.push({ label: '공개 중', tone: 'shared' });
  if (app.workflow_name) tags.push({ label: app.workflow_name, tone: 'muted' });
  return tags;
}

/** [앱 스토어] 카드의 태그 — 모양, 내 앱인지, 누가 만들었는지. */
export function storeAppTags(app: StoreApp): AppTag[] {
  const tags: AppTag[] = [{ label: appKindLabel(app.kind), tone: 'kind' }];
  if (app.mine) tags.push({ label: '내 앱', tone: 'shared' });
  const who = app.owner_name || '알 수 없는 사용자';
  tags.push({ label: app.workflow_name ? `${who} · ${app.workflow_name}` : who, tone: 'muted' });
  return tags;
}

/** 설명 칸 — 비었으면 비었다고 말한다(빈 줄은 카드가 덜 그려진 것처럼 보인다). */
export function appDescription(app: { description?: string | null }): string {
  return String(app.description ?? '').trim() || '설명이 없습니다';
}

/**
 * 미리보기를 (다시) 찍어야 하는가 — 열리는 사이트·앱인데 그림이 없거나 앱이 그림보다 나중에 바뀌었다.
 * 앱(service)이 지금 도는지는 찍는 쪽이 따로 본다(멈춘 앱을 깨우지 않는다). 화면(component)은 찍지 않는다.
 */
export function needsPreview(
  app: Pick<AppSummary, 'kind' | 'ready' | 'updated_at' | 'preview_url' | 'preview_at'>,
): boolean {
  if (!app.ready || (app.kind !== 'project' && app.kind !== 'service')) return false;
  // 옛 서버는 미리보기를 모른다(필드가 없다).
  if (app.preview_url === undefined) return false;
  if (!app.preview_url) return true;
  return (app.preview_at ?? 0) < (app.updated_at ?? 0);
}
