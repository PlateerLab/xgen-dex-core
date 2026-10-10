/**
 * 시작 화면과 대화 목록의 규칙. 순수 함수라 시험이 그대로 부른다.
 *
 * 시작 화면: 에이전트를 고르면(기본은 "새 에이전트로 시작", 사이드바 [+] 로 열면 그 에이전트) 입력창이 열린다. 새 에이전트는 이름·제공자·모델이
 * 있어야 하고, 이름은 이 PC 의 다른 에이전트와 겹치면 안 된다(대소문자 무시, 적는 대로 확인).
 * 대화 목록: 모든 에이전트의 대화를 마지막으로 말한 순서로. 제목이 없으면 "새 대화".
 */
import { UNTITLED_CONVERSATION } from '@dex/protocol';
import type { XdConversation, XdConversationListItem } from '../../main/store';

/** 에이전트 고르기의 "새 에이전트로 시작" 값(에이전트 id 와 겹치지 않는다). */
export const NEW_AGENT = '';

export const START_TEXT = {
  heading: '오늘은 무엇을 해볼까요?',
  newAgent: '새 에이전트로 시작',
  nameRequired: '에이전트 이름을 먼저 입력해 주세요.',
  nameTaken: '같은 이름의 에이전트가 이미 있습니다. 다른 이름을 써 주세요.',
  accountRequired: 'AI 제공자를 먼저 연결해 주세요.',
  modelRequired: '모델을 먼저 골라 주세요.',
} as const;

interface NamedAgent {
  id: string;
  name: string;
}

/** 이름 비교 열쇠: 앞뒤 빈칸·대소문자·유니코드 조합 꼴(맥의 한글 NFD)을 가리지 않는다. */
const nameKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

/** 이 이름의 에이전트가 이미 있는가(`exceptId` 는 고치는 중인 자기 자신). 빈 이름은 겹치지 않는다. */
export function agentNameTaken(name: string, agents: readonly NamedAgent[], exceptId?: string | null): boolean {
  const key = nameKey(name);
  if (!key) return false;
  return agents.some((a) => a.id !== exceptId && nameKey(a.name) === key);
}

/** 고른 값이 지금 있는 에이전트인가. 없는 id(그 사이 지워졌다)는 새 에이전트로 본다. */
export function isExistingAgent(agentId: string, agents: readonly NamedAgent[]): boolean {
  return agentId !== NEW_AGENT && agents.some((a) => a.id === agentId);
}

/**
 * 시작 화면이 처음 고르는 에이전트: 사이드바의 [+]·[다른 에이전트] 가 준 에이전트(지금 있으면), 아니면
 * "새 에이전트로 시작".
 */
export function initialStartAgent(preselect: string | null | undefined, agents: readonly NamedAgent[]): string {
  return preselect && isExistingAgent(preselect, agents) ? preselect : NEW_AGENT;
}

export type StartLockReason = 'name' | 'duplicate' | 'account' | 'model';

export interface StartLock {
  reason: StartLockReason;
  message: string;
}

export interface StartChoice {
  agentId: string;
  name: string;
  accountId: string;
  model: string;
}

/** 입력창이 잠기는 까닭(보낼 수 있으면 null). 앞의 것부터 하나만. */
export function startLock(choice: StartChoice, agents: readonly NamedAgent[]): StartLock | null {
  if (isExistingAgent(choice.agentId, agents)) return null;
  if (!choice.name.trim()) return { reason: 'name', message: START_TEXT.nameRequired };
  if (agentNameTaken(choice.name, agents)) return { reason: 'duplicate', message: START_TEXT.nameTaken };
  if (!choice.accountId) return { reason: 'account', message: START_TEXT.accountRequired };
  if (!choice.model.trim()) return { reason: 'model', message: START_TEXT.modelRequired };
  return null;
}

/** 시작 화면에서 [모든 설정] 으로 넘길 때 이미 적은 것. */
export interface AgentDraft {
  name: string;
  description: string;
  accountId: string;
  model: string;
  systemPrompt: string;
}

/** 대화 줄의 제목. 비어 있으면 "새 대화". */
export function conversationTitle(c: Pick<XdConversation, 'title'>): string {
  return c.title.trim() || UNTITLED_CONVERSATION;
}

/** 이름을 바꾼 대화를 목록에서 그 자리 그대로 고친다(순서는 바꾸지 않는다). */
export function replaceConversation(list: XdConversationListItem[], updated: XdConversation): XdConversationListItem[] {
  return list.map((c) => (c.id === updated.id ? { ...c, title: updated.title, updatedAt: updated.updatedAt } : c));
}

export function dropConversation(list: XdConversationListItem[], id: string): XdConversationListItem[] {
  return list.filter((c) => c.id !== id);
}
