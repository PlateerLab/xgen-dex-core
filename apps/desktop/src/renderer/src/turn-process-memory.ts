/**
 * 끝난 턴의 작업 과정을 이 PC 에 남겼다가 다시 연 답에 되붙인다 — **규칙은 @dex/protocol 이 정본이다.**
 *
 * 저장·짝짓기(대화 id + 답 글)·용량 처리는 패키지에 있고, 여기는 데스크톱 메시지 모양(ChatMsg)에
 * 맞춰 부르는 얇은 층만 남긴다. 웹 채팅이 같은 규칙으로 되붙이므로 두 화면이 같은 대화를 같게 본다.
 */
import {
  answerSignature,
  browserStorage,
  recallTurnProcesses,
  rememberTurnProcess as rememberProcess,
  TURN_PROCESS_CLIP,
  TURN_PROCESS_KEY,
  TURN_PROCESS_MAX,
  type KeyValueStorage,
} from '@dex/protocol/turn-process-memory';
import type { ChatMsg, FlowItem } from './session-store';

export { answerSignature, browserStorage, TURN_PROCESS_CLIP, TURN_PROCESS_KEY, TURN_PROCESS_MAX };
export type { KeyValueStorage };

/** 끝난 턴을 남긴다. 도구를 한 번도 안 쓴 턴·빈 답은 남기지 않는다(되붙일 과정이 없다). */
export function rememberTurnProcess(
  storage: KeyValueStorage | null,
  conversation: string,
  msg: ChatMsg | undefined,
  now: number,
): void {
  if (!msg || msg.role !== 'assistant' || !msg.flow) return;
  rememberProcess(
    storage,
    conversation,
    msg.text,
    { flow: msg.flow, tools: msg.tools, startedAt: msg.startedAt, lastEventAt: msg.lastEventAt },
    now,
  );
}

/** 이력으로 만든 답들에 남겨 둔 과정을 되붙인다. 짝이 없거나 이미 과정이 있는 답은 그대로. */
export function attachTurnProcesses(
  storage: KeyValueStorage | null,
  conversation: string,
  messages: ChatMsg[],
): ChatMsg[] {
  const bySig = recallTurnProcesses(storage, conversation);
  if (bySig.size === 0) return messages;
  return messages.map((m) => {
    if (m.role !== 'assistant' || m.flow || !m.text) return m;
    const e = bySig.get(answerSignature(m.text));
    return e
      ? { ...m, flow: e.flow as FlowItem[], tools: m.tools ?? e.tools, startedAt: e.startedAt, lastEventAt: e.lastEventAt }
      : m;
  });
}
