/**
 * 작업 공간 IDE 를 다시 읽게 하는 신호 — **보이는 에이전트의 IDE 만**.
 *
 * 에이전트가 파일을 쓰는 것은 턴 안에서다. 그 에이전트의 도구 결과·턴 끝, 창으로 돌아올 때(다른 프로그램에서 고쳤을
 * 수 있다), 그리고 숨어 있던 IDE 가 다시 보일 때 알린다. 턴 사건은 여기서 한 번만 듣는다 — IDE 저장소마다 듣고
 * 다른 에이전트의 턴에도 작업 공간 전체를 다시 훑으면, 한 번이라도 연 에이전트 수만큼 일이 불어난다.
 */
import { xd } from '../bridge';

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
const timers = new Map<string, number>();
let visible: string | null = null;
let wired = false;

function fire(agentId: string): void {
  if (agentId !== visible || timers.has(agentId)) return;
  // 잦으면 한 번으로 모은다.
  timers.set(
    agentId,
    window.setTimeout(() => {
      timers.delete(agentId);
      for (const fn of listeners.get(agentId) ?? []) fn();
    }, 400),
  );
}

function wire(): void {
  if (wired || typeof window === 'undefined' || !xd) return;
  wired = true;
  xd.onTurnEvent((event) => {
    if (event.type === 'finished' || (event.type === 'chat' && event.event.kind === 'tool')) fire(event.agentId);
  });
  window.addEventListener('focus', () => visible && fire(visible));
}

/** 이 에이전트의 IDE 를 다시 읽을 때 부른다. 돌려받은 함수로 그만 듣는다. */
export function onIdeActivity(agentId: string, fn: Listener): () => void {
  wire();
  let set = listeners.get(agentId);
  if (!set) listeners.set(agentId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(agentId);
  };
}

/** 지금 보이는 작업 공간 IDE(없으면 null) — 다시 보이게 된 IDE 는 그사이 바뀐 것을 읽는다. */
export function setVisibleIde(agentId: string | null): void {
  if (visible === agentId) return;
  visible = agentId;
  if (agentId) fire(agentId);
}
