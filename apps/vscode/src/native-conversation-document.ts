import type * as vscode from 'vscode';
import type { NativeSessionViewState } from './native-session-controller';

export const NATIVE_CONVERSATION_SCHEME = 'xgen-dex-native';
export const NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS = 5 * 1024 * 1024;

function bounded(value: string): string {
  if (value.length <= NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS) return value;
  return `${value.slice(0, NATIVE_CONVERSATION_DOCUMENT_MAX_CHARS)}\n\n[표시 한도를 초과한 내용은 생략했습니다.]\n`;
}

/** Plain-text projection only. Credentials, cursors and raw execution envelopes never enter this state. */
export function nativeConversationText(state: NativeSessionViewState): string {
  const lines = ['XGEN Dex 현재 공유 대화', ''];
  if (!state.conversation) {
    const status = state.status === 'waiting' ? '현재 공유 대화를 확인하는 중입니다.'
      : state.status === 'reconnecting' ? '연결을 복구하는 중입니다.'
      : state.status === 'stopped' ? '대화 조회가 중단되었습니다. 인증과 연결을 확인하세요.'
      : '표시할 현재 공유 대화가 없습니다.';
    return `${lines.concat(status, '').join('\n')}`;
  }
  const { snapshot, messages, omittedMessages } = state.conversation;
  if (!snapshot) return `${lines.concat('현재 공유 대화가 없습니다.', '').join('\n')}`;
  const complete = messages.filter((message) => message.content_complete);
  const incomplete = messages.length - complete.length;
  lines.push(`제목: ${snapshot.title}`, `세션: ${snapshot.id}`,
    `최신 턴: ${snapshot.latest_turn?.status ?? '없음'}`, '');
  const notes = [omittedMessages ? `이전 메시지 ${omittedMessages}개 생략` : '',
    !snapshot.message_history_complete ? '전체 메시지 이력이 아님' : '',
    incomplete ? `본문 미완전 메시지 ${incomplete}개 제외` : '', state.hasMore ? '추가 내용 확인 중' : ''].filter(Boolean);
  if (notes.length) lines.push(`참고: ${notes.join(' · ')}`, '');
  if (!complete.length) lines.push('표시할 완전한 메시지가 없습니다.', '');
  complete.forEach((message, index) => {
    lines.push(`메시지 ${index + 1} · ${message.status} · ${message.source}`, '', '[입력]', message.input_text ?? '(없음)', '',
      '[출력]', message.output_text ?? '(없음)', '');
  });
  return bounded(lines.join('\n'));
}

interface ChangeEmitter {
  readonly event: vscode.Event<vscode.Uri>;
  fire(uri: vscode.Uri): void;
  dispose(): void;
}

export class NativeConversationDocument implements vscode.TextDocumentContentProvider, vscode.Disposable {
  readonly onDidChange: vscode.Event<vscode.Uri>;
  private content = nativeConversationText({ status: 'idle', focus: null, conversation: null, hasMore: false });
  constructor(readonly uri: vscode.Uri, private readonly changes: ChangeEmitter,
    private readonly openDocument: (uri: vscode.Uri) => Promise<void>) { this.onDidChange = changes.event; }
  provideTextDocumentContent(): string { return this.content; }
  update(state: NativeSessionViewState): void { this.content = nativeConversationText(state); this.changes.fire(this.uri); }
  show(): Promise<void> { return this.openDocument(this.uri); }
  dispose(): void { this.content = ''; this.changes.dispose(); }
}
