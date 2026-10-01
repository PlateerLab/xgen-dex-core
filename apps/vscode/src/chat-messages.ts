/**
 * 채팅 창의 줄 — 말풍선·도구 줄의 모양과, 지난 턴을 그 모양으로 옮기는 규칙.
 *
 * vscode 모듈에 기대지 않는 순수한 부분만 여기 둔다(웹뷰 공급자에서 떼어 냄) — 그래야 테스트가 직접 부른다.
 */
import { randomUUID } from 'node:crypto';
import { parseAgentTrigger, triggerRowLabel, type AgentTrigger } from '@dex/protocol';
import type { ConversationSnapshot, ToolEvent } from '@dex/rpc';

export type MessageRole = 'user' | 'assistant' | 'activity' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  label: string;
  text: string;
  /** user — 이 턴이 Job/sub-agent 트리거 주입이면 렌더용 파싱 결과.
   *  webview 는 이 필드가 있으면 말풍선 대신 [Trigger] 행을 그린다. */
  trigger?: AgentTrigger & { rowLabel: string };
  /** assistant — 이 답변에서 쓴 도구 이벤트 전부 (전체 로그의 원천, 수신 순). */
  tools?: ToolEvent[];
  /** activity — 클릭하면 열 전체 로그의 위치 (assistant 메시지 id + tools 인덱스). */
  toolRef?: { assistantId: string; index: number };
}

/**
 * 지난 턴 → 말풍선. 서버가 실행 기록에서 되살린 작업 과정(`process`)이 있으면 이 창이 스트림으로 받은 턴과
 * 같은 모양 — 답 아래 도구 줄(호출 하나에 한 줄, 마지막 상태)과 [전체 로그] 의 원천(`tools`) — 으로 그린다.
 * 다른 기기(휴대폰·웹)가 돌린 턴이 끝나면 이 창은 이력으로 다시 그리므로, 이것이 없으면 도구 없이 결과만 남는다.
 */
export function historyTurnMessages(turns: ConversationSnapshot['turns'], agentName: string): ChatMessage[] {
  return turns.flatMap((turn) => {
    const user = message('user', '나', turn.input);
    const assistant = message('assistant', agentName, turn.output);
    const tools = (turn.process ?? []).flatMap((item) => (item.kind === 'tool' ? [item.event] : []));
    if (tools.length === 0) return [user, assistant];
    assistant.tools = tools;
    const rows: ChatMessage[] = [];
    const byCall = new Map<string, ChatMessage>();
    tools.forEach((event, index) => {
      const key = event.toolUseId || event.runId || `${event.toolName ?? 'tool'}#${index}`;
      const existing = byCall.get(key);
      if (existing) {
        existing.text = describeTool(event);
        existing.toolRef = { assistantId: assistant.id, index };
        return;
      }
      const row = message('activity', 'Tool', describeTool(event));
      row.toolRef = { assistantId: assistant.id, index };
      rows.push(row);
      byCall.set(key, row);
    });
    return [user, assistant, ...rows];
  });
}

export function message(role: MessageRole, label: string, text: string): ChatMessage {
  const item: ChatMessage = { id: randomUUID(), role, label, text };
  if (role === 'user') {
    // Job/sub-agent 트리거 주입 턴 — 사용자 발화가 아니므로 렌더가 다르다.
    const trig = parseAgentTrigger(text);
    if (trig) item.trigger = { ...trig, rowLabel: triggerRowLabel(trig) };
  }
  return item;
}

export function describeTool(event: ToolEvent): string {
  const name = event.toolName || 'tool';
  if (event.eventType === 'tool_result') return `${name} · 완료${event.durationMs ? ` · ${event.durationMs}ms` : ''}`;
  if (event.eventType === 'tool_error') return `${name} · 실패${event.error ? ` · ${event.error}` : ''}`;
  return `${name} · 실행 중`;
}
