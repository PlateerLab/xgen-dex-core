/**
 * 아바타가 말하는 것의 계약 — **이 세션에서 라이브로 흐른 텍스트만.**
 *
 * 버그: 대화 기록을 열기만 해도 그 대화의 마지막 답변이 아바타 말풍선/자막에
 * 떠서, 아바타가 방금 말한 것처럼 보였다. 기록을 읽는 것과 말하는 것은 다른 일이다.
 *
 * 멀티세션 리팩터 이후 전사(messages)는 SessionStore 가 소유하지만, 아바타/TTS 는
 * 여전히 **포그라운드 라이브 경로에서만** 나와야 한다. 이 파일은 그 분리가
 * 유지되는지 검사한다 — 되돌아가면 같은 버그가 재발한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Windows 러너는 CRLF 로 체크아웃한다 — \n 고정 검색이 빈 슬라이스를 만들어
// 이 파일의 검사가 윈도우에서만 실패했다 (CI 실증). 줄바꿈을 정규화한다.
const ROOT = join(__dirname, '..');
const CHAT = readFileSync(join(ROOT, 'src/renderer/src/views/Chat.tsx'), 'utf8').replace(/\r\n/g, '\n');
const STORE = readFileSync(join(ROOT, 'src/renderer/src/session-store.ts'), 'utf8').replace(/\r\n/g, '\n');

test('아바타 상태는 messages 가 아니라 liveText 에서 나온다', () => {
  assert.match(CHAT, /streamingText:\s*liveText/, '아바타가 liveText 를 쓰지 않는다');
});

test('liveText 는 스트리밍 중에만 채워진다 (기록/유휴 세션은 빈 값)', () => {
  // liveText 파생부: 스트리밍이 아니면 '' — 기록을 열어도 아바타가 말하지 않는다.
  const memo = CHAT.slice(CHAT.indexOf('const liveText = useMemo'), CHAT.indexOf('const avatarState'));
  assert.ok(memo.length > 0, 'liveText useMemo 파생부를 찾지 못했다');
  assert.match(memo, /if \(!streaming\) return '';/, '스트리밍이 아닐 때 라이브 텍스트를 비우지 않는다');
});

test('TTS 는 스트리밍 델타에서만 큐잉되고, 재마운트 시 기존 답을 다시 읽지 않는다', () => {
  // 세션 전환으로 재마운트되면 마지막 답의 "현재 길이"에서 시작 → 백로그 미낭독.
  // 소리는 한 번 나면 주워 담을 수 없다 — 기록/이미 읽은 부분을 다시 읽으면 안 된다.
  const watcher = CHAT.slice(CHAT.indexOf('const idx = messages.length - 1'), CHAT.indexOf('// Tear down mic'));
  assert.ok(watcher.length > 0, 'TTS 감시 이펙트를 찾지 못했다');
  assert.match(watcher, /spokenRef\.current = last\.text\.length/, '기존 텍스트를 건너뛰지 않는다');
  assert.match(watcher, /if \(last\.streaming\)/, '스트리밍이 아닐 때도 문장을 큐잉한다');
  assert.match(watcher, /enqueueTts\(/);
});

test('전사 로드는 스토어에 있고 음성/자막을 건드리지 않는다', () => {
  // 기록 로딩(loadHistory)은 순수 전사 채움일 뿐 — enqueueTts/liveText 개념이 없다.
  assert.match(STORE, /private async loadHistory/);
  assert.ok(
    !/enqueueTts|liveText|setLiveText/.test(STORE),
    '스토어가 음성/자막(TTS·liveText)을 건드린다 — 기록 로드가 말이 될 수 있다',
  );
});
