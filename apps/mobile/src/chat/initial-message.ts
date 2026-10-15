/**
 * 시작 화면에서 적은 첫 메시지 (2026-10-09).
 *
 * 시작 화면은 대화를 열면서 첫 메시지를 함께 넘긴다. 그런데 채팅 화면은 대화 소켓이 붙어야(구독까지)
 * 보낼 수 있다. 그래서 첫 메시지는 소켓이 **처음 붙는 순간 한 번만** 보낸다. 다시 붙거나(화면을 끄고 켬)
 * 채팅 화면이 새로 그려져도 다시 보내지 않도록, 보낸 표식을 이 모듈 하나가 들고 있다.
 * 대화(에이전트 + 대화 id)가 맞을 때만 꺼낸다: 다른 대화로 옮겨 간 사이 엉뚱한 대화에 가지 않는다.
 */

export interface InitialMessage {
  /** 이 메시지 한 건의 표식. 같은 표식은 두 번 나가지 않는다. */
  id: string;
  workflowId: string;
  interactionId: string;
  text: string;
}

let seq = 0;

export function newInitialMessage(workflowId: string, interactionId: string, text: string, now = Date.now()): InitialMessage {
  seq += 1;
  return { id: `init-${now}-${seq}`, workflowId, interactionId, text };
}

export interface InitialMessageGate {
  /** 이 대화에 보낼 첫 메시지가 아직 안 나갔으면 꺼내고 나간 것으로 적는다. 아니면 null. */
  take(msg: InitialMessage | null | undefined, workflowId: string, interactionId: string): InitialMessage | null;
  /** 이미 꺼냈는가. */
  used(id: string): boolean;
}

export function createInitialMessageGate(): InitialMessageGate {
  const used = new Set<string>();
  return {
    take(msg, workflowId, interactionId) {
      if (!msg || !msg.text.trim()) return null;
      if (msg.workflowId !== workflowId || msg.interactionId !== interactionId) return null;
      if (used.has(msg.id)) return null;
      used.add(msg.id);
      return msg;
    },
    used: (id) => used.has(id),
  };
}

/** 앱 전체에서 하나. 채팅 화면이 다시 그려져도 이 표식은 남는다. */
export const initialMessageGate = createInitialMessageGate();
