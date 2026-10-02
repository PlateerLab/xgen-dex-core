/**
 * 채팅 메시지 모델 — 저장된 턴과 흐르는 턴 사건을 Dex 화면 부품이 그리는 `ChatMsg` 로.
 *
 * `ChatMsg`·`FlowItem` 은 Dex 의 모양 그대로다(형만 가져온다). 그래서 작업 과정 타임라인(ProcessTimeline)·
 * 마크다운을 Dex 와 같은 부품으로 그린다. 순수 함수 — 시험이 그대로 부른다.
 */
import type { ChatEvent, ToolEvent } from '@dex/protocol';
import type { ChatMsg, FlowItem } from './dex';
import { errorInfo } from '../../shared/error-info';
import type { XdTurn } from '../../main/store';

export type { ChatMsg };

const toolsOf = (flow: readonly FlowItem[]): ToolEvent[] =>
  flow.filter((f): f is Extract<FlowItem, { kind: 'tool' }> => f.kind === 'tool').map((f) => f.event);

/** 저장된 턴 하나 → [질문, 답]. */
export function turnMessages(turn: XdTurn): [ChatMsg, ChatMsg] {
  const flow = (turn.process ?? []) as FlowItem[];
  const failed = turn.status === 'error';
  const answer: ChatMsg = {
    role: 'assistant',
    text: turn.answer,
    flow,
    tools: toolsOf(flow),
    startedAt: turn.startedAt,
    lastEventAt: turn.endedAt ?? turn.startedAt,
    streaming: turn.status === 'running',
    ...(failed ? { error: true, errorInfo: errorInfo(turn.error?.code ?? 'runtime', turn.error?.message ?? '') } : {}),
    ...(turn.status === 'cancelled' ? { interrupted: true } : {}),
  };
  return [{ role: 'user', text: turn.question, startedAt: turn.startedAt }, answer];
}

/** 막 보낸 턴의 답 자리(아직 아무 사건도 없다). */
export function startLive(at: number): ChatMsg {
  return { role: 'assistant', text: '', flow: [], tools: [], startedAt: at, lastEventAt: at, streaming: true };
}

/** 흐르는 사건 하나를 답에 붙인다(새 객체). 글 조각은 이어 붙인다 — 토큰마다 한 칸이면 타임라인이 부서진다. */
export function applyChatEvent(msg: ChatMsg, ev: ChatEvent, at: number): ChatMsg {
  switch (ev.kind) {
    case 'text': {
      const flow = [...(msg.flow ?? [])];
      const last = flow[flow.length - 1];
      if (last && last.kind === 'text') flow[flow.length - 1] = { ...last, text: last.text + ev.content };
      else flow.push({ kind: 'text', text: ev.content, at });
      return { ...msg, text: msg.text + ev.content, flow, lastEventAt: at };
    }
    case 'tool':
      return {
        ...msg,
        flow: [...(msg.flow ?? []), { kind: 'tool', event: ev.event, at }],
        tools: [...(msg.tools ?? []), ev.event],
        lastEventAt: at,
      };
    case 'error':
      return { ...msg, streaming: false, error: true, errorInfo: ev.info, lastEventAt: at };
    case 'end':
      return { ...msg, streaming: false, lastEventAt: at };
    default:
      return msg;
  }
}

/** 작업 과정이 있는 답인가 — 도구를 쓴 턴만 타임라인으로 그린다(글뿐인 답은 마크다운 그대로). */
export function usedTools(msg: ChatMsg): boolean {
  return (msg.flow ?? []).some((f) => f.kind === 'tool');
}
