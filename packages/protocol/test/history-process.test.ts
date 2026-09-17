/**
 * 서버가 되살린 작업 과정 → 화면 순서. 모양이 어긋난 칸 하나 때문에 턴 전체를 잃지 않는다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toHistoryProcess } from '../src/history';

test('글과 도구 사건을 스트림과 같은 모양으로 옮긴다', () => {
  const out = toHistoryProcess([
    { kind: 'text', text: '읽습니다.\n', at: 1000 },
    { kind: 'tool', at: 1500, event: { event_type: 'tool_call', tool_name: 'Read', tool_input: { file_path: 'a.txt' }, tool_use_id: 'u1' } },
    { kind: 'tool', at: 1620, event: { event_type: 'tool_result', tool_name: 'Read', result: 'ok', duration_ms: 120, tool_use_id: 'u1' } },
    { kind: 'tool', at: 1700, event: { event_type: 'tool_error', tool_name: 'Bash', error: 'boom', tool_use_id: 'u2' } },
  ]);
  assert.equal(out?.length, 4);
  assert.deepEqual(out?.[0], { kind: 'text', text: '읽습니다.\n', at: 1000 });
  const call = out?.[1];
  assert.ok(call?.kind === 'tool');
  assert.equal(call.event.eventType, 'tool_call');
  assert.equal(call.event.toolUseId, 'u1');
  assert.deepEqual(call.event.toolInput, { file_path: 'a.txt' });
  const result = out?.[2];
  assert.ok(result?.kind === 'tool');
  assert.equal(result.event.result, 'ok');
  assert.equal(result.event.durationMs, 120);
  const failed = out?.[3];
  assert.ok(failed?.kind === 'tool');
  assert.equal(failed.event.error, 'boom');
});

test('없거나 어긋난 것은 버린다', () => {
  assert.equal(toHistoryProcess(undefined), undefined);
  assert.equal(toHistoryProcess('x'), undefined);
  assert.equal(toHistoryProcess([{ kind: 'nope' }, null]), undefined);
  const out = toHistoryProcess([{ kind: 'text', text: 'a' }, { kind: 'tool', event: 'bad' }]);
  assert.deepEqual(out, [{ kind: 'text', text: 'a', at: 0 }]);
});
