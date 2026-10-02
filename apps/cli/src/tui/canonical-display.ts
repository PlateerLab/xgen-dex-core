import { stripVTControlCharacters } from 'node:util';
import { wrapToWidth, type TranscriptLine } from './transcript';
import type { CanonicalTuiView } from './canonical-types';

/** Server text is data, never a terminal instruction (including OSC clipboard/hyperlinks). */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\t/g, '    ');
}

export function displayLine(value: string, width: number): string {
  return wrapToWidth(terminalText(value).replace(/\n/g, ' '), Math.max(2, width))[0] ?? '';
}

export function canonicalTranscript(view: CanonicalTuiView, width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const append = (key: string, text: string, role: TranscriptLine['role'], color?: string) => {
    for (const [index, line] of wrapToWidth(terminalText(text), Math.max(2, width)).entries()) {
      lines.push({ key: `${key}:${index}`, text: line, role, color });
    }
  };
  if (!view.conversation?.snapshot) {
    const text = view.error ? '검증된 대화를 표시할 수 없습니다. CLI Platform Session 상태를 확인하세요.'
      : view.busy || view.hasMore ? '현재 공유 대화를 확인하고 있습니다.'
      : view.status === 'stopped' ? '연결을 중단하여 대화를 지웠습니다. R 또는 W로 다시 연결하세요.'
      : view.conversation ? '현재 공유 대화가 없습니다. 다른 Canonical 화면에서 대화를 선택한 뒤 R로 조회하세요.'
      : 'R로 현재 공유 대화를 조회하거나 W로 실시간 연결을 시작하세요.';
    append('empty', text, 'system');
    return lines;
  }
  for (const message of view.conversation.messages) {
    append(`${message.turn_id}:label`, `── ${message.source === 'user' ? '사용자' : message.source === 'subagent_report' ? '하위 에이전트 보고' : '출처 미확인'} · ${message.status}`, 'label', 'cyan');
    if (!message.content_complete) {
      append(`${message.turn_id}:partial`, '[본문이 불완전하여 표시하지 않습니다.]', 'system', 'yellow');
      continue;
    }
    if (message.input_text !== null) append(`${message.turn_id}:input`, message.input_text, 'text');
    if (message.output_text !== null) {
      append(`${message.turn_id}:answer`, '── 응답', 'label', 'green');
      append(`${message.turn_id}:output`, message.output_text, 'text');
    }
  }
  if (!lines.length) append('waiting', '완료된 메시지가 없습니다. 실행 중인 본문은 완료 후 조회합니다.', 'system');
  return lines;
}
