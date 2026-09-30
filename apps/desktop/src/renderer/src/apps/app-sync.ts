/**
 * 앱 상태가 바뀌었다는 소식 — 두 화면이 서로 다른 말을 하지 않게.
 *
 * 같은 앱이 두 곳에 보인다: [앱] 탭의 카드와 그 에이전트 뷰어의 [앱] 하위 탭. 둘이 나란히
 * 떠 있을 때 한쪽에서 [배포 중지]를 누르면 다른 쪽도 곧바로 알아야 한다. 소식은 세 길로 온다.
 *
 *   같은 창     누른 화면이 announceAppChange 로 알린다 — 서버를 거치지 않아 바로 온다.
 *   다른 곳     웹이나 다른 기기에서 바꾸면 서버가 그 에이전트의 workspace 소켓을 울린다.
 *   주인 목록   서버가 주인의 목록 소켓으로 ``apps`` 소식을 보낸다(생김·지움·배포·공유). 앱이
 *               하나도 없던 에이전트가 처음 만든 앱도 이 길로 [앱] 탭에 곧바로 보인다
 *               (workspace 소켓은 앱이 있는 에이전트만 듣는다).
 *
 * 어느 쪽이든 받는 화면은 **서버에서 다시 읽는다.** 소식에 상태를 실어 나르지 않는 이유는
 * 정본이 서버 하나여야 해서다 — 화면끼리 상태를 건네면 늦게 온 것이 이긴다.
 *
 * 잇단 소식은 모아서 한 번만 읽는다. 에이전트가 파일을 쓰는 동안 소켓은 쉬지 않고 울린다.
 */
import { useEffect, useRef } from 'react';
import { xgen } from '../bridge';
import { subscribeWorkspace, type SubscribeWorkspace } from '../workspace-watch';

type Listener = (workflowId: string, source: unknown) => void;
const listeners = new Set<Listener>();

/** 이 창의 다른 앱 화면들에게 알린다. `source` 는 알린 화면 자신 — 자기 소식은 듣지 않는다. */
export function announceAppChange(workflowId: string, source?: unknown): void {
  for (const fn of [...listeners]) fn(workflowId, source);
}

export function onAppChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 서버가 보낸 ``apps`` 소식을 이 창의 소식으로 옮긴다 — 처음 듣는 화면이 한 번 건다. */
export interface AppsFeed {
  watch?: () => Promise<unknown>;
  onChanged?: (cb: (workflowId: string) => void) => () => void;
}

let feedBound = false;

export function bindServerFeed(feed: AppsFeed | undefined = xgen?.apps): boolean {
  if (feedBound || !feed?.onChanged) return feedBound;
  feedBound = true;
  feed.onChanged((workflowId) => announceAppChange(workflowId));
  void feed.watch?.()?.catch(() => undefined);
  return true;
}

/** 테스트용 — 다음 bindServerFeed 가 다시 건다. */
export function resetServerFeed(): void {
  feedBound = false;
}

export interface AppChangeOptions {
  /** 이 화면 자신(안정된 객체). 같은 값으로 알린 소식은 건너뛴다. */
  self?: unknown;
  /** 이 창의 소식은 에이전트를 가리지 않고 듣는다 — 여러 에이전트를 모아 보는 [앱] 탭. */
  anyAgent?: boolean;
  /** 잇단 소식을 모으는 시간(ms). */
  delayMs?: number;
  /** 테스트가 가짜 소켓을 넣는다. */
  subscribe?: SubscribeWorkspace;
}

/**
 * 이 에이전트들의 앱이 바뀌면 onChange 를 부른다(모아서 한 번). 돌려준 함수로 그만 듣는다.
 */
export function watchAppChanges(
  workflowIds: readonly string[],
  onChange: () => void,
  opts: AppChangeOptions = {},
): () => void {
  const ids = [...new Set(workflowIds.filter(Boolean))];
  const delay = opts.delayMs ?? 400;
  bindServerFeed();
  const subscribe = opts.subscribe ?? subscribeWorkspace;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const fire = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, delay);
  };
  const offs = ids.map((id) => subscribe(id, fire));
  offs.push(
    onAppChange((workflowId, source) => {
      if (opts.self !== undefined && source === opts.self) return;
      if (opts.anyAgent || ids.includes(workflowId)) fire();
    }),
  );
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  };
}

/** watchAppChanges 의 훅 — 에이전트 목록이 그대로면 구독도 그대로 둔다. */
export function useAppChanges(
  workflowIds: readonly string[],
  onChange: () => void,
  opts: Pick<AppChangeOptions, 'self' | 'anyAgent'> = {},
): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = [...new Set(workflowIds.filter(Boolean))].sort().join('\n');
  const { self, anyAgent } = opts;
  useEffect(
    () => watchAppChanges(key ? key.split('\n') : [], () => latest.current(), { self, anyAgent }),
    [key, self, anyAgent],
  );
}
