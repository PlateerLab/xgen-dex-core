/**
 * 대화 목록 소식(이 창 안, 2026-10-10).
 *
 * 채팅 기록 관리 탭에서 지우거나 이름을 바꾸면 사이드바 [채팅] 목록이 곧바로 맞춘다. 서버의 대화 목록 소켓
 * 소식(conversations/changed)도 뒤따라 오지만, 이 창에서 한 일은 그것을 기다리지 않고 바로 보인다.
 */

export type ConversationListLocalEvent =
  | { type: 'removed'; items: Array<{ workflowId: string; interactionId: string }> }
  | { type: 'renamed'; workflowId: string; interactionId: string; title: string; customTitle: boolean }
  | { type: 'purged' };

const EVENT = 'dex:conversation-list';

export function emitConversationListEvent(event: ConversationListLocalEvent): void {
  window.dispatchEvent(new CustomEvent<ConversationListLocalEvent>(EVENT, { detail: event }));
}

export function onConversationListEvent(fn: (event: ConversationListLocalEvent) => void): () => void {
  const handler = (event: Event) => fn((event as CustomEvent<ConversationListLocalEvent>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
