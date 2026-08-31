/**
 * Agent ↔ Teams 다리 — 컨텍스트 봉투와 공유 출처 표식.
 *
 * 이 두 형식이 깨지면 조용히 잘못된 일이 벌어진다: 봉투가 새면 남의 대화가
 * 화면에 노출되고, 표식 파싱이 어긋나면 사람이 쓴 글이 잘려 나간다. 그래서
 * 왕복(build → parse)과 **엉뚱한 입력**을 함께 검증한다.
 */
import assert from 'assert';
import { test } from 'node:test';
import {
  TEAMS_CONTEXT_END,
  TEAMS_CONTEXT_START,
  buildSharedMessage,
  buildTeamsContext,
  formatShareHeader,
  parseSharedMessage,
  prependTeamsContext,
  shareBodyOf,
  stripTeamsContext,
  toContextEntries,
  type TeamsContextEnvelope,
  type TeamsShareRef,
} from '@dex/protocol/teams-bridge';
import { stripBrowserContext } from '@dex/protocol/browser';
import { mapMessage } from '@dex/protocol/teams';
import type { TeamsMessage } from '@dex/protocol';

const ROOM = { id: 'r1', name: '3팀 개발방', isDirect: false };

function msg(over: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    id: 'm1',
    roomId: 'r1',
    senderType: 'user',
    senderId: '7',
    senderName: '김철수',
    content: '타임아웃 이슈 아직인가요?',
    createdAt: '2026-08-24T10:02:00',
    ...over,
  };
}

/** 봉투 안의 JSON 을 다시 꺼낸다 — 테스트가 형식에 직접 기대지 않도록. */
function unwrap(envelope: string): TeamsContextEnvelope {
  assert.ok(envelope.startsWith(TEAMS_CONTEXT_START));
  assert.ok(envelope.endsWith(TEAMS_CONTEXT_END));
  const json = envelope.slice(TEAMS_CONTEXT_START.length, -TEAMS_CONTEXT_END.length).trim();
  return JSON.parse(json) as TeamsContextEnvelope;
}

// ── 컨텍스트 봉투 ────────────────────────────────────────────────

test('toContextEntries: 본문도 첨부도 없는 메시지는 싣지 않는다', () => {
  const entries = toContextEntries([
    msg({ id: 'a', content: '실제 발화' }),
    msg({ id: 'b', content: '   ' }),
    msg({ id: 'c', content: '' }),
  ]);
  assert.deepStrictEqual(
    entries.map((e) => e.text),
    ['실제 발화'],
  );
});

test('toContextEntries: 본문이 비어도 첨부가 있으면 파일 이름으로 싣는다', () => {
  const entries = toContextEntries([
    msg({
      content: '',
      attachments: [
        { id: 'a1', filename: '보고서.xlsx', mime: 'application/x', size: 10, storageKey: 'k1' },
      ],
    }),
  ]);
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0]?.files, ['보고서.xlsx']);
});

test('toContextEntries: 발신자 종류를 함께 싣는다 (사람/에이전트 구분)', () => {
  const entries = toContextEntries([
    msg({ id: 'a', senderType: 'user', content: '질문' }),
    msg({ id: 'b', senderType: 'agent', senderName: 'QA봇', content: '답변' }),
    msg({ id: 'c', senderType: 'system', content: '홍길동 님이 입장했습니다' }),
  ]);
  assert.deepStrictEqual(
    entries.map((e) => e.role),
    ['user', 'agent', 'system'],
  );
});

test('buildTeamsContext: 방 정보와 건수를 봉투에 담는다', () => {
  const entries = toContextEntries([msg({ id: 'a' }), msg({ id: 'b', content: '두번째' })]);
  const envelope = unwrap(buildTeamsContext(ROOM, entries));
  assert.strictEqual(envelope.source, 'xgen-teams');
  assert.deepStrictEqual(envelope.room, ROOM);
  assert.strictEqual(envelope.count, 2);
  assert.strictEqual(envelope.truncated, false);
});

test('buildTeamsContext: 상한을 넘으면 오래된 것부터 버리고 잘렸다고 표시한다', () => {
  // 최근이 문맥이다 — 요약을 시켜도 최근이 결론에 가깝다.
  const entries = toContextEntries(
    Array.from({ length: 40 }, (_, i) => msg({ id: `m${i}`, content: `${i}:${'가'.repeat(50)}` })),
  );
  const envelope = unwrap(buildTeamsContext(ROOM, entries, 1_500));
  assert.strictEqual(envelope.truncated, true);
  assert.ok(envelope.count < 40, '일부가 잘려야 한다');
  assert.ok(envelope.count > 0, '전부 버리면 보낼 이유가 없다');
  // 남은 것은 **뒤쪽(최근)** 이어야 한다.
  const last = envelope.messages[envelope.messages.length - 1];
  assert.ok(last?.text.startsWith('39:'), '가장 최근 메시지는 남아야 한다');
});

test('buildTeamsContext: 한 건이 통째로 상한을 넘어도 무한 루프에 빠지지 않는다', () => {
  const entries = toContextEntries([msg({ content: '나'.repeat(5_000) })]);
  const envelope = unwrap(buildTeamsContext(ROOM, entries, 100));
  assert.strictEqual(envelope.count, 0);
  assert.strictEqual(envelope.truncated, true);
});

test('prependTeamsContext ↔ stripTeamsContext: 사용자 문장이 그대로 돌아온다', () => {
  const envelope = buildTeamsContext(ROOM, toContextEntries([msg()]));
  const decorated = prependTeamsContext('이거 요약해줘', envelope);
  assert.notStrictEqual(decorated, '이거 요약해줘');
  assert.strictEqual(stripTeamsContext(decorated), '이거 요약해줘');
});

test('prependTeamsContext: 봉투가 비면 입력을 건드리지 않는다', () => {
  assert.strictEqual(prependTeamsContext('그냥 질문', ''), '그냥 질문');
});

test('stripTeamsContext: 봉투가 없는 평범한 글은 그대로 둔다', () => {
  const plain = '봉투 얘기를 하는 <xgen_teams_context> 같은 문장이 본문 중간에 있어도';
  assert.strictEqual(stripTeamsContext(plain), plain);
});

test('두 겹 봉투(브라우저 바깥 · Teams 안쪽)는 붙인 역순으로 벗겨진다', () => {
  // session.ts 가 teams → browser 순으로 붙이므로 문자열은 BROWSER…TEAMS…입력.
  // session-store.ts 는 browser → teams 순으로 벗긴다.
  const teams = buildTeamsContext(ROOM, toContextEntries([msg()]));
  const inner = prependTeamsContext('원래 질문', teams);
  const outer = `<xgen_browser_context>\n{"pages":[]}\n</xgen_browser_context>\n${inner}`;
  assert.strictEqual(stripTeamsContext(stripBrowserContext(outer)), '원래 질문');
});

// ── 공유 출처 표식 ───────────────────────────────────────────────

const AGENT_REF: TeamsShareRef = {
  kind: 'agent',
  label: '사내문서 QA',
  workflowId: 'wf-123',
  interactionId: 'ix-456',
};

test('formatShareHeader: 사람이 읽는 문장과 기계용 태그를 한 줄에 담는다', () => {
  const header = formatShareHeader(AGENT_REF);
  // 태그를 모르는 클라이언트(웹 Teams)에서도 출처가 읽혀야 한다.
  assert.ok(header.includes('사내문서 QA'));
  assert.ok(header.includes('에이전트 답변 공유'));
  assert.ok(/⟨xgen:[^⟩]+⟩$/.test(header), '태그가 줄 끝에 있어야 파싱된다');
});

test('buildSharedMessage ↔ parseSharedMessage: 출처와 본문이 왕복한다', () => {
  const body = '원인은 커넥션 풀 고갈입니다.\n\n- 이슈 #482\n- 재현: 동시 200 요청';
  const parsed = parseSharedMessage(buildSharedMessage(AGENT_REF, body));
  assert.ok(parsed);
  assert.deepStrictEqual(parsed.ref, AGENT_REF);
  assert.strictEqual(parsed.body, body);
});

test('parseSharedMessage: 이름에 구분자(·)나 괄호가 있어도 깨지지 않는다', () => {
  // 프로즈가 아니라 percent-encoding 된 태그가 파싱 기준이라서 안전하다.
  const ref: TeamsShareRef = {
    kind: 'agent',
    label: 'A · B ⟨괄호⟩ & =끝',
    workflowId: 'wf/1',
    interactionId: 'ix=2',
  };
  const parsed = parseSharedMessage(buildSharedMessage(ref, '본문'));
  assert.ok(parsed);
  assert.deepStrictEqual(parsed.ref, ref);
  assert.strictEqual(parsed.body, '본문');
});

test('parseSharedMessage: 파일 공유는 kind=file 로 돌아온다', () => {
  const ref: TeamsShareRef = { kind: 'file', label: '보고서.xlsx' };
  const parsed = parseSharedMessage(buildSharedMessage(ref, '파일을 공유합니다.'));
  assert.strictEqual(parsed?.ref.kind, 'file');
  assert.strictEqual(parsed?.ref.label, '보고서.xlsx');
  assert.strictEqual(parsed?.ref.workflowId, undefined);
});

test('parseSharedMessage: 표식이 없는 사람 메시지는 null', () => {
  assert.strictEqual(parseSharedMessage('그냥 사람이 쓴 글'), null);
  assert.strictEqual(parseSharedMessage(''), null);
});

test('parseSharedMessage: 본문 중간의 비슷한 문자열은 표식으로 오인하지 않는다', () => {
  // 첫 줄만 보는 이유 — 오인하면 사람이 쓴 글이 잘려 나간다.
  const text = '이건 사람 글입니다\n🤖 가짜 · 에이전트 답변 공유 ⟨xgen:k=agent&l=가짜⟩';
  assert.strictEqual(parseSharedMessage(text), null);
  assert.strictEqual(shareBodyOf(text), text);
});

test('parseSharedMessage: 라벨이 없는 망가진 태그는 무시한다', () => {
  assert.strictEqual(parseSharedMessage('🤖 · 공유 ⟨xgen:k=agent⟩\n본문'), null);
});

test('buildSharedMessage: 본문이 비어도 표식만으로 유효한 메시지가 된다', () => {
  // 서버가 빈 content 를 거절하므로(min_length=1) 최소 한 줄은 남아야 한다.
  const only = buildSharedMessage({ kind: 'file', label: 'a.pdf' }, '   ');
  assert.ok(only.length > 0);
  assert.strictEqual(parseSharedMessage(only)?.body, '');
});

test('shareBodyOf: 표식을 걷어낸 본문만 돌려준다 (목록 미리보기용)', () => {
  const shared = buildSharedMessage(AGENT_REF, '요약 결과');
  assert.strictEqual(shareBodyOf(shared), '요약 결과');
  assert.strictEqual(shareBodyOf('평범한 글'), '평범한 글');
});

// ── 메모리: 받은 메시지가 추출 본문을 물고 있지 않아야 한다 ──────

test('mapMessage: 첨부의 추출 본문은 렌더러로 넘기지 않는다', () => {
  // 서버는 문서 본문을 최대 50만 자까지 첨부 메타에 실어 보낸다. 그건 보낼 때
  // 되돌려주기 위한 값이지 화면이 쓰는 값이 아니다 — 받은 메시지마다 들고
  // 있으면 방 하나가 수 MB 를 물고 앉는다.
  const mapped = mapMessage({
    id: 'm1',
    room_id: 'r1',
    sender_type: 'user',
    sender_id: '2',
    sender_name: '김철수',
    content: '보고서 올립니다',
    created_at: '2026-08-25T10:00:00',
    attachments: [
      {
        id: 'a1',
        filename: '보고서.pdf',
        mime: 'application/pdf',
        size: 1024,
        storage_key: 'a1.pdf',
        extracted_text: '가'.repeat(100_000),
        truncated: true,
      },
    ],
  });
  const att = mapped.attachments?.[0];
  assert.ok(att, '첨부 자체는 남아야 한다');
  assert.strictEqual(att.filename, '보고서.pdf');
  assert.strictEqual(att.size, 1024);
  assert.strictEqual(att.truncated, true);
  assert.strictEqual(att.extractedText, undefined, '추출 본문이 그대로 실려 왔다');
  // 통째로 직렬화해도 본문 크기가 딸려오지 않아야 한다.
  assert.ok(JSON.stringify(mapped).length < 1_000);
});
