/**
 * 에이전트 스토리지가 바뀌었다는 알림 — 렌더러 쪽 구독 창구 하나.
 *
 * 소켓은 main 이 연다(ide-watch.ts, 렌더러는 CSP 로 소켓을 못 연다). 서버는 workspace 가
 * 바뀔 때마다(에이전트가 파일을 썼다, 웹에서 앱을 배포 중지했다 …) `changed` 를 민다.
 * 채팅 [IDE] 의 탐색기와 앱 화면([앱] 탭, 에이전트 [앱] 하위 탭)이 같은 알림을 듣는다.
 *
 * 같은 에이전트를 여러 화면이 들어도 **소켓은 하나**다. 에이전트마다 한 구독 키를 두고
 * 듣는 쪽을 세어, 마지막이 떠날 때 닫는다 — [앱] 탭이 에이전트 여럿을 들을 때 IDE·앱
 * 하위 탭과 같은 에이전트면 소켓이 겹쳐 열리지 않게.
 */
import { xgen } from './bridge';

/** main 의 구독 통로 — preload 의 `xgen.ide` 가 이 모양이다. */
export interface WorkspaceWatchBridge {
  watch(key: string, workflowId: string): void;
  unwatch(key: string): void;
  onChanged(cb: (key: string) => void): () => void;
}

export type SubscribeWorkspace = (workflowId: string, onChange: () => void) => () => void;

export function createWorkspaceWatch(
  bridge: () => WorkspaceWatchBridge | undefined,
): SubscribeWorkspace {
  const channels = new Map<string, { key: string; listeners: Set<() => void> }>();
  const byKey = new Map<string, Set<() => void>>();
  let listening = false;
  let seq = 0;

  return (workflowId, onChange) => {
    const b = bridge();
    if (!b || !workflowId) return () => {};
    if (!listening) {
      listening = true;
      b.onChanged((key) => {
        // 복사해서 돈다 — 듣는 쪽이 알림을 받자마자 구독을 풀 수 있다.
        for (const fn of [...(byKey.get(key) ?? [])]) fn();
      });
    }
    let channel = channels.get(workflowId);
    if (!channel) {
      seq += 1;
      channel = { key: `ws:${workflowId}:${seq}`, listeners: new Set() };
      channels.set(workflowId, channel);
      byKey.set(channel.key, channel.listeners);
      b.watch(channel.key, workflowId);
    }
    const own = channel;
    // 같은 함수를 두 번 걸어도 두 구독이다 — 하나를 풀 때 다른 하나가 같이 사라지지 않게.
    const entry = () => onChange();
    own.listeners.add(entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      own.listeners.delete(entry);
      if (own.listeners.size > 0 || channels.get(workflowId) !== own) return;
      channels.delete(workflowId);
      byKey.delete(own.key);
      b.unwatch(own.key);
    };
  };
}

/** 앱 전체가 쓰는 구독 — 테스트는 createWorkspaceWatch 로 가짜 통로를 넣는다. */
export const subscribeWorkspace: SubscribeWorkspace = createWorkspaceWatch(() => xgen?.ide);
