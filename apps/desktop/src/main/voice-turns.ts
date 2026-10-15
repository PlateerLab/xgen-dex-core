/**
 * 말하는 도중 실행한 발화의 장부 — 음성 세션이 끝나면 여기 남기고, 그 발화 글자가 채팅으로
 * 들어오면(chat:start) 고속 경로가 꺼내 쓴다. 이미 실행한 조작을 서버가 다시 하지 않게 하려는 것이다.
 */
import type { VoiceAction } from './fast-act-voice';

export type VoiceTurn = {
  workflowId: string;
  text: string;
  actions: VoiceAction[];
  /** 최종 판단에서도 처리하지 못한 남은 말 — 서버로 넘길 부분. 없으면 null. */
  unhandled: string | null;
  at: number;
};

const TTL_MS = 60_000;
const turns = new Map<string, VoiceTurn>();
const key = (s: string): string => s.replace(/\s+/g, '');

export function rememberVoiceTurn(t: VoiceTurn): void {
  turns.set(t.workflowId, t);
}

/** 이 에이전트의 마지막 음성 발화가 지금 들어온 글자와 같으면 꺼낸다(한 번만). */
export function takeVoiceTurn(workflowId: string, text: string): VoiceTurn | null {
  const t = turns.get(workflowId);
  if (!t || Date.now() - t.at > TTL_MS || key(t.text) !== key(text)) return null;
  turns.delete(workflowId);
  return t;
}
