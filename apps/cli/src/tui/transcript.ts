import stringWidth from 'string-width';
import { parseAgentTrigger, triggerRowLabel } from '@dex/protocol';
import type { ChatMessage } from './chat-state';

/**
 * 대화를 **줄 단위로** 펼친다.
 *
 * 예전에는 마지막 몇 **개의 메시지**를 잘라 보여 줬다. 한 메시지가 한두 줄이라고
 * 친 셈인데, 실제로는 수십 줄짜리가 온다. 그러면 대화창이 제 높이를 넘어 자라고,
 * ink 은 줄 수를 세어 화면을 지우므로 그 순간부터 지우는 자리와 그리는 자리가
 * 어긋난다 — 글자가 테두리 밖으로 새고, 입력창과 아래 안내줄까지 밟힌다. 대화가
 * 길어질수록 확실히 깨졌다.
 *
 * 그래서 여기서 **먼저 폭에 맞춰 줄로 만든 뒤** 높이만큼만 자른다. 대화창이 자기
 * 높이를 넘는 일이 구조적으로 불가능해지고, 그 덕에 스크롤도 줄 단위로 정확해진다.
 */

export type LineRole = 'label' | 'text' | 'activity' | 'system';

export interface TranscriptLine {
  key: string;
  text: string;
  role: LineRole;
  color?: string;
}

/** 이 줄 앞에 붙는 들여쓰기. 말한 사람 아래로 내용이 정렬된다. */
const INDENT = '  ';

function colorOf(role: ChatMessage['role']): string | undefined {
  if (role === 'user') return 'cyan';
  if (role === 'assistant') return 'green';
  if (role === 'activity') return 'yellow';
  if (role === 'system') return 'red';
  return undefined;
}

function labelOf(role: ChatMessage['role'], agentName: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return agentName;
  if (role === 'activity') return 'Tool';
  return 'System';
}

/**
 * 한 문단을 폭에 맞춰 자른다.
 *
 * 공백에서 끊는 것을 우선하되, 한 낱말이 폭보다 길거나 한국어처럼 공백이 없으면
 * 글자 폭을 세어 끊는다. `String.length` 로는 안 된다 — 한글·이모지는 한 글자가
 * 두 칸이라, 길이로 자르면 줄이 폭을 넘어 결국 대화창이 자란다.
 */
export function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    const flush = (): void => {
      lines.push(line);
      line = '';
      lineWidth = 0;
    };
    // 공백을 낱말에 붙여 두면 줄 끝에서 함께 넘어가 앞줄이 폭을 넘지 않는다.
    for (const word of paragraph.match(/\s+|\S+/g) ?? []) {
      const wordWidth = stringWidth(word);
      if (lineWidth > 0 && lineWidth + wordWidth > width) {
        flush();
        if (/^\s+$/.test(word)) continue; // 줄바꿈 자리의 공백은 버린다
      }
      if (wordWidth <= width) {
        line += word;
        lineWidth += wordWidth;
        continue;
      }
      // 낱말 하나가 폭보다 길다 — 글자 폭을 세어 끊는다.
      for (const char of word) {
        const charWidth = stringWidth(char);
        if (lineWidth + charWidth > width) flush();
        line += char;
        lineWidth += charWidth;
      }
    }
    flush();
  }
  return lines;
}

/**
 * 말한 사람을 가로줄로 못박는다: `── You ────────`.
 *
 * 이름만 굵게 쓰던 때는 대화를 불러오면 어디서 누가 바뀌는지 눈에 들어오지 않았다.
 * 가로줄은 스크롤 도중 아무 데서나 멈춰도 경계가 바로 보인다.
 */
function ruleFor(label: string, width: number): string {
  // 이름이 길면 줄인다. 넘치는 채로 두면 대화창이 자라고, 그 순간 ink 이 지우는
  // 자리와 그리는 자리가 어긋난다 — 에이전트 이름은 사용자가 짓는 값이라 얼마든지
  // 길 수 있다.
  const room = Math.max(0, width - stringWidth('──  '));
  let trimmed = '';
  let used = 0;
  for (const char of label) {
    const charWidth = stringWidth(char);
    if (used + charWidth > room) {
      trimmed = trimmed.slice(0, -1) + '…';
      break;
    }
    trimmed += char;
    used += charWidth;
  }
  const head = `── ${trimmed} `;
  return head + '─'.repeat(Math.max(0, width - stringWidth(head)));
}

export function renderTranscript(
  messages: ChatMessage[],
  agentName: string,
  width: number,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  const bodyWidth = Math.max(1, width - INDENT.length);

  for (const message of messages) {
    const color = colorOf(message.role);

    // [Trigger] 턴 — Job/sub-agent 가 세션을 깨운 주입이다. 사용자 발화가
    // 아니므로 You 블록 대신 활동 줄과 같은 한 줄로 지나간다 (전 앱 공통
    // 계약 — GUI 는 클릭 상세, TUI 는 한 줄 요약).
    if (message.role === 'user') {
      const trig = parseAgentTrigger(message.text);
      if (trig) {
        for (const [index, text] of wrapToWidth(`⚡ ${triggerRowLabel(trig)}`, bodyWidth).entries()) {
          lines.push({
            key: `${message.id}:${index}`,
            text: `${index === 0 ? '' : INDENT}${text}`,
            role: 'activity',
            color: 'yellow',
          });
        }
        continue;
      }
    }

    // 도구 활동은 대화가 아니라 곁다리다. 가로줄까지 두면 진짜 대화가 묻힌다.
    if (message.role === 'activity') {
      for (const [index, text] of wrapToWidth(message.text, bodyWidth).entries()) {
        lines.push({
          key: `${message.id}:${index}`,
          text: `${index === 0 ? '· ' : INDENT}${text}`,
          role: 'activity',
          color,
        });
      }
      continue;
    }

    if (lines.length > 0) lines.push({ key: `${message.id}:gap`, text: '', role: 'text' });
    lines.push({
      key: `${message.id}:label`,
      text: ruleFor(labelOf(message.role, agentName), width),
      role: 'label',
      color,
    });

    // 아직 한 글자도 오지 않은 응답은 빈칸이 아니라 기다리는 중이라고 말해 준다.
    const body = message.text || (message.role === 'assistant' ? '…' : '');
    for (const [index, text] of wrapToWidth(body, bodyWidth).entries()) {
      lines.push({
        key: `${message.id}:${index}`,
        text: INDENT + text,
        role: message.role === 'system' ? 'system' : 'text',
        color: message.role === 'system' ? color : undefined,
      });
    }
  }
  return lines;
}

export interface Viewport {
  lines: TranscriptLine[];
  /** 위로 가려진 줄 수. 0 보다 크면 더 볼 것이 있다는 뜻이다. */
  above: number;
  /** 아래로 가려진 줄 수. 0 이면 맨 아래에 붙어 있다. */
  below: number;
}

/**
 * 높이만큼만 잘라 낸다.
 *
 * `scrollUp` 은 **맨 아래에서 몇 줄 올라갔는지**다. 0 이면 늘 최신이 보인다 — 새
 * 응답이 흘러도 따라간다. 사용자가 올려 둔 동안에는 그 자리를 지킨다.
 */
export function viewportOf(
  lines: TranscriptLine[],
  height: number,
  scrollUp: number,
): Viewport {
  if (height <= 0) return { lines: [], above: lines.length, below: 0 };
  const maximumScroll = Math.max(0, lines.length - height);
  const up = Math.min(Math.max(0, scrollUp), maximumScroll);
  const end = lines.length - up;
  const start = Math.max(0, end - height);
  return { lines: lines.slice(start, end), above: start, below: lines.length - end };
}

/** 올라갈 수 있는 최대치. 이 너머로는 올려 봐야 같은 화면이다. */
export function maximumScroll(lineCount: number, height: number): number {
  return Math.max(0, lineCount - Math.max(0, height));
}
