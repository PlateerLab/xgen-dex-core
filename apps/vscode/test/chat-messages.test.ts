/**
 * 다른 기기의 도구 턴이 이 창에서 결과만 남던 문제(2026-10-01 사용자 보고).
 *
 * VS Code 창은 다른 화면(휴대폰·웹)이 돌린 턴이 끝나면 이력으로 다시 그린다. 이력에는 서버가 실행 기록에서
 * 되살린 작업 과정(process)이 있다 — 그것으로 이 창이 스트림으로 받은 턴과 같은 모양(답 + 도구 줄)을 만든다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryTurn } from '@dex/protocol';
import { historyTurnMessages } from '../src/chat-messages';

const turn = (rest: Partial<HistoryTurn>): HistoryTurn => ({
  logId: 1, ioId: 1, interactionId: 'c', workflowId: 'wf', workflowName: 'gitlab',
  input: '', output: '', attachments: [], updatedAt: '', ...rest,
});

test('지난 턴의 작업 과정이 도구 줄과 전체 로그의 원천이 된다', () => {
  const rows = historyTurnMessages(
    [
      turn({
        input: '내 앱 괜찮아?',
        output: '두 앱 모두 정상입니다.',
        ioId: 9,
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'AppList', toolUseId: 'a' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'AppList', toolUseId: 'a', durationMs: 40 } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_call', toolName: 'AppStatus', toolUseId: 'b' } },
          { kind: 'tool', at: 4, event: { eventType: 'tool_error', toolName: 'AppStatus', toolUseId: 'b', error: '중지됨' } },
          { kind: 'text', at: 5, text: '두 앱 모두 정상입니다.' },
        ],
      }),
    ],
    'gitlab',
  );
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant', 'activity', 'activity']);
  assert.deepEqual(rows.slice(2).map((r) => r.text), ['AppList · 완료 · 40ms', 'AppStatus · 실패 · 중지됨'], '호출 하나에 한 줄, 마지막 상태');
  assert.equal(rows[1].tools?.length, 4);
  assert.deepEqual(rows[3].toolRef, { assistantId: rows[1].id, index: 3 }, '줄을 누르면 그 호출의 마지막 사건이 열린다');
});

test('도구를 안 쓴 턴과 옛 서버의 턴은 예전 모양 그대로다', () => {
  const rows = historyTurnMessages([turn({ input: 'ㅎㅇ', output: '안녕하세요' })], 'gitlab');
  assert.deepEqual(rows.map((r) => [r.role, r.text]), [['user', 'ㅎㅇ'], ['assistant', '안녕하세요']]);
  assert.equal(rows[1].tools, undefined);
});

test('호출 id 가 없는 도구도 호출 하나에 한 줄 — "실행 중" 이 남지 않는다', () => {
  const rows = historyTurnMessages(
    [
      turn({
        output: '끝',
        process: [
          { kind: 'tool', at: 1, event: { eventType: 'tool_call', toolName: 'Read' } },
          { kind: 'tool', at: 2, event: { eventType: 'tool_result', toolName: 'Read' } },
          { kind: 'tool', at: 3, event: { eventType: 'tool_call', toolName: 'Read' } },
          { kind: 'tool', at: 4, event: { eventType: 'tool_error', toolName: 'Read', error: '없음' } },
        ],
      }),
    ],
    'gitlab',
  );
  assert.deepEqual(rows.filter((r) => r.role === 'activity').map((r) => r.text), ['Read · 완료', 'Read · 실패 · 없음']);
});
