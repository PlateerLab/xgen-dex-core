/** Teams 순수 모델 — 메시지 병합·낙관적 전송·안 읽음·발화 묶기. */
import assert from 'assert';
import { test } from 'node:test';
import {
  PENDING_PREFIX,
  applyReactions,
  badgeText,
  dropPending,
  filterRooms,
  isPending,
  mergeMessages,
  memberDepartureMessage,
  messageTime,
  removeDepartedMember,
  settlePending,
  shouldShowRoomRefreshLoading,
  sortRooms,
  MAX_ROOM_MESSAGES,
  applyEdit,
  formatBytes,
  isPreviewableImage,
  messagePreview,
  startsGroup,
  unreadCount,
} from '../src/renderer/src/views/teams-store';
import { buildSharedMessage } from '@dex/protocol/teams-bridge';
import { directRoomNameForViewer, TeamsApi, teamsAttachmentRejectReason } from '@dex/protocol/teams';
import type { TeamsMember, TeamsMessage, TeamsRoom } from '@dex/protocol';

function msg(id: string, createdAt: string, over: Partial<TeamsMessage> = {}): TeamsMessage {
  return {
    id,
    roomId: 'r1',
    senderType: 'user',
    senderId: '7',
    senderName: '홍길동',
    content: id,
    createdAt,
    ...over,
  };
}

function room(id: string, over: Partial<TeamsRoom> = {}): TeamsRoom {
  return {
    id,
    name: id,
    routerMode: 'chat',
    isDirect: false,
    createdAt: '2026-08-01T00:00:00',
    createdBy: 1,
    ...over,
  };
}

test('mergeMessages: 시간 오름차순으로 합치고 중복 id 는 나중 것이 이긴다', () => {
  const current = [msg('b', '2026-08-21T10:01:00'), msg('a', '2026-08-21T10:00:00')];
  const incoming = [
    msg('c', '2026-08-21T10:02:00'),
    msg('b', '2026-08-21T10:01:00', { content: '편집됨', isEdited: true }),
  ];
  const merged = mergeMessages(current, incoming);
  assert.deepStrictEqual(
    merged.map((m) => m.id),
    ['a', 'b', 'c'],
  );
  assert.strictEqual(merged[1].content, '편집됨');
  assert.strictEqual(merged[1].isEdited, true);
});

test('mergeMessages: 빈 입력은 기존 배열을 그대로 돌려준다 (불필요한 리렌더 방지)', () => {
  const current = [msg('a', '2026-08-21T10:00:00')];
  assert.strictEqual(mergeMessages(current, []), current);
});

test('removeDepartedMember: 퇴장자를 즉시 제거하고 중복 이벤트는 무시한다', () => {
  const members: TeamsMember[] = [
    { userId: 1, username: 'admin', role: 'owner', isOnline: true, joinedAt: '' },
    {
      userId: 2,
      username: 'departed',
      fullName: '퇴장 사용자',
      role: 'member',
      isOnline: false,
      joinedAt: '',
    },
  ];
  const removed = removeDepartedMember(members, 2);
  assert.deepStrictEqual(
    removed.members.map((member) => member.userId),
    [1],
  );
  assert.strictEqual(removed.departed?.fullName, '퇴장 사용자');
  assert.strictEqual(removeDepartedMember(removed.members, 2).members, removed.members);
});

test('mergeMessages: 로컬 퇴장 안내는 서버 시스템 메시지가 오면 중복 없이 교체한다', () => {
  const member: TeamsMember = {
    userId: 2,
    username: 'departed',
    fullName: '퇴장 사용자',
    role: 'member',
    isOnline: false,
    joinedAt: '',
  };
  const local = memberDepartureMessage('r1', member, '2026-08-28T14:00:00', '1');
  const server = msg('server-left', '2026-08-28T14:00:00', {
    senderType: 'system',
    senderId: '',
    senderName: '시스템',
    content: '퇴장 사용자 님이 퇴장했습니다.',
  });
  assert.deepStrictEqual(
    mergeMessages([local], [server]).map((message) => message.id),
    ['server-left'],
  );
  assert.deepStrictEqual(
    mergeMessages([server], [local]).map((message) => message.id),
    ['server-left'],
  );
});

test('settlePending: 임시 메시지를 서버 확정본으로 교체한다', () => {
  const pendingId = `${PENDING_PREFIX}1`;
  const list = [msg('a', '2026-08-21T10:00:00'), msg(pendingId, '2026-08-21T10:01:00')];
  assert.strictEqual(isPending(list[1]), true);
  const settled = settlePending(list, pendingId, msg('srv-1', '2026-08-21T10:01:00'));
  assert.deepStrictEqual(
    settled.map((m) => m.id),
    ['a', 'srv-1'],
  );
});

test('settlePending: WS 가 먼저 도착해 확정본이 이미 있어도 중복되지 않는다', () => {
  const pendingId = `${PENDING_PREFIX}1`;
  const server = msg('srv-1', '2026-08-21T10:01:00');
  // 서버 응답보다 message_new 가 먼저 들어온 상황.
  const list = mergeMessages([msg(pendingId, '2026-08-21T10:01:00')], [server]);
  const settled = settlePending(list, pendingId, server);
  assert.deepStrictEqual(
    settled.map((m) => m.id),
    ['srv-1'],
  );
});

test('dropPending: 전송 실패한 임시 메시지만 걷어낸다', () => {
  const pendingId = `${PENDING_PREFIX}9`;
  const list = [msg('a', '2026-08-21T10:00:00'), msg(pendingId, '2026-08-21T10:01:00')];
  assert.deepStrictEqual(
    dropPending(list, pendingId).map((m) => m.id),
    ['a'],
  );
});

test('applyReactions: 대상 메시지만 갈아끼우고, 없으면 배열을 그대로 둔다', () => {
  const list = [msg('a', '2026-08-21T10:00:00'), msg('b', '2026-08-21T10:01:00')];
  const next = applyReactions(list, 'b', [{ emoji: '👍', count: 2, userIds: [1, 2] }]);
  assert.strictEqual(next[0].reactions, undefined);
  assert.strictEqual(next[1].reactions?.[0].emoji, '👍');
  assert.strictEqual(applyReactions(list, 'zzz', []), list);
});

test('applyReactions: 빈 집계는 undefined 로 정리한다 (마지막 리액션 해제)', () => {
  const list = [
    msg('a', '2026-08-21T10:00:00', { reactions: [{ emoji: '👍', count: 1, userIds: [1] }] }),
  ];
  assert.strictEqual(applyReactions(list, 'a', [])[0].reactions, undefined);
});

test('unreadCount: 내 메시지와 시스템 안내는 세지 않는다', () => {
  const messages = [
    msg('a', '2026-08-21T10:00:00', { senderId: '7' }), // 내 것
    msg('b', '2026-08-21T10:01:00', { senderId: '9' }), // 남의 것
    msg('c', '2026-08-21T10:02:00', { senderType: 'system', senderId: '' }),
    msg('d', '2026-08-21T10:03:00', { senderId: '9' }),
  ];
  assert.strictEqual(unreadCount(messages, undefined, '7'), 2);
});

test('unreadCount: 마지막 열람 시각 이후만 센다', () => {
  const messages = [
    msg('a', '2026-08-21T10:00:00', { senderId: '9' }),
    msg('b', '2026-08-21T10:05:00', { senderId: '9' }),
  ];
  assert.strictEqual(unreadCount(messages, '2026-08-21T10:00:00', '7'), 1);
  assert.strictEqual(unreadCount(messages, '2026-08-21T10:05:00', '7'), 0);
});

test('badgeText: 0 은 빈 문자열, 999 초과는 잘라 표시', () => {
  assert.strictEqual(badgeText(0), '');
  assert.strictEqual(badgeText(3), '3');
  assert.strictEqual(badgeText(1200), '999+');
});

test('sortRooms: 최근 대화가 위, 없으면 생성 시각 기준', () => {
  const rooms = [
    room('old', { lastMessageAt: '2026-08-20T09:00:00' }),
    room('fresh', { lastMessageAt: '2026-08-21T09:00:00' }),
    room('never', { createdAt: '2026-08-19T00:00:00' }),
  ];
  assert.deepStrictEqual(
    sortRooms(rooms).map((r) => r.id),
    ['fresh', 'old', 'never'],
  );
});

test('filterRooms: 이름과 설명을 대소문자 없이 검색한다', () => {
  const rooms = [room('팀 회의실'), room('Random', { description: '잡담 방' })];
  assert.deepStrictEqual(
    filterRooms(rooms, 'random').map((r) => r.id),
    ['Random'],
  );
  assert.deepStrictEqual(
    filterRooms(rooms, '잡담').map((r) => r.id),
    ['Random'],
  );
  assert.strictEqual(filterRooms(rooms, '  ').length, 2);
});

test('방 목록 갱신: 조회 완료된 빈 목록은 백그라운드 동기화 때 로딩 화면으로 바꾸지 않는다', () => {
  assert.strictEqual(shouldShowRoomRefreshLoading(true, true), false);
  assert.strictEqual(shouldShowRoomRefreshLoading(true, false), true);
  assert.strictEqual(shouldShowRoomRefreshLoading(false, true), true);
});

test('directRoomNameForViewer: 1:1 방은 나를 제외한 상대 이름으로 보인다', () => {
  const direct = room('dm', { name: '서버에 박제된 B', isDirect: true });
  const members: TeamsMember[] = [
    {
      userId: 1,
      username: 'A',
      fullName: '에이 사용자',
      role: 'owner',
      isOnline: true,
      joinedAt: '',
    },
    {
      userId: 2,
      username: 'B',
      fullName: '비 사용자',
      role: 'member',
      isOnline: true,
      joinedAt: '',
    },
  ];
  assert.strictEqual(directRoomNameForViewer(direct, members, '1'), '비 사용자');
  assert.strictEqual(directRoomNameForViewer(direct, members, '2'), '에이 사용자');
});

test('directRoomNameForViewer: 그룹방과 상대를 찾지 못한 DM은 서버 이름을 유지한다', () => {
  const members: TeamsMember[] = [
    { userId: 1, username: 'A', role: 'owner', isOnline: true, joinedAt: '' },
  ];
  assert.strictEqual(
    directRoomNameForViewer(room('group', { name: '개발방' }), members, '1'),
    '개발방',
  );
  assert.strictEqual(
    directRoomNameForViewer(room('dm', { name: '기존 이름', isDirect: true }), members, '1'),
    '기존 이름',
  );
});

test('TeamsApi.leaveRoom: 마지막 멤버는 별도 삭제 동작 없이 방을 자동 정리한다', async () => {
  const calls: string[] = [];
  const api = new TeamsApi({
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return {
        data: [
          {
            user_id: 1,
            username: 'admin',
            role: 'owner',
            is_online: true,
            joined_at: '',
          },
        ],
      };
    },
    del: async (path: string) => {
      calls.push(`DELETE ${path}`);
      return {};
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return {};
    },
  } as never);

  await api.leaveRoom('last-room');
  assert.deepStrictEqual(calls, [
    'GET /api/teams/rooms/last-room/members',
    'DELETE /api/teams/rooms/last-room',
  ]);
});

test('TeamsApi.leaveRoom: 다른 멤버가 남아 있으면 일반 나가기를 호출한다', async () => {
  const calls: string[] = [];
  const api = new TeamsApi({
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return {
        data: [
          { user_id: 1, username: 'admin', role: 'owner' },
          { user_id: 2, username: 'member', role: 'member' },
        ],
      };
    },
    del: async (path: string) => {
      calls.push(`DELETE ${path}`);
      throw new Error('not allowed');
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return {};
    },
  } as never);

  await api.leaveRoom('group-room');
  assert.deepStrictEqual(calls, [
    'GET /api/teams/rooms/group-room/members',
    'POST /api/teams/rooms/group-room/leave',
  ]);
});

test('TeamsApi.leaveRoom: 마지막 방 자동 정리가 실패해도 일반 나가기로 폴백한다', async () => {
  const calls: string[] = [];
  const api = new TeamsApi({
    get: async (path: string) => {
      calls.push(`GET ${path}`);
      return { data: [{ user_id: 1, username: 'admin', role: 'owner' }] };
    },
    del: async (path: string) => {
      calls.push(`DELETE ${path}`);
      throw new Error('not allowed');
    },
    post: async (path: string) => {
      calls.push(`POST ${path}`);
      return {};
    },
  } as never);

  await api.leaveRoom('fallback-room');
  assert.deepStrictEqual(calls, [
    'GET /api/teams/rooms/fallback-room/members',
    'DELETE /api/teams/rooms/fallback-room',
    'POST /api/teams/rooms/fallback-room/leave',
  ]);
});

test('startsGroup: 같은 사람이 3분 안에 이어 말하면 머리를 다시 그리지 않는다', () => {
  const first = msg('a', '2026-08-21T10:00:00', { senderId: '9' });
  const soon = msg('b', '2026-08-21T10:01:00', { senderId: '9' });
  const later = msg('c', '2026-08-21T10:10:00', { senderId: '9' });
  const other = msg('d', '2026-08-21T10:01:10', { senderId: '5' });

  assert.strictEqual(startsGroup(first, undefined), true);
  assert.strictEqual(startsGroup(soon, first), false);
  assert.strictEqual(startsGroup(later, soon), true);
  assert.strictEqual(startsGroup(other, soon), true);
});

test('startsGroup: 시스템 메시지는 항상 독립 줄', () => {
  const sys1 = msg('s1', '2026-08-21T10:00:00', { senderType: 'system', senderId: '' });
  const sys2 = msg('s2', '2026-08-21T10:00:10', { senderType: 'system', senderId: '' });
  assert.strictEqual(startsGroup(sys2, sys1), true);
});

test('messageTime: 해석 불가한 시각은 빈 문자열 (화면에 Invalid Date 를 띄우지 않는다)', () => {
  assert.strictEqual(messageTime(''), '');
  assert.strictEqual(messageTime('not-a-date'), '');
  assert.notStrictEqual(messageTime('2026-08-21T10:00:00'), '');
});

test('mergeMessages: 낙관적 메시지는 시각 표기가 달라도 항상 맨 뒤에 놓인다', () => {
  // 서버는 타임존 없는 로컬 표기, 임시 메시지는 UTC 'Z' 표기 — 문자열로 나란히
  // 정렬하면 방금 보낸 말이 대화 맨 위로 튀어 오른다.
  const server = msg('srv', '2026-08-21T15:04:05');
  const pending = msg(`${PENDING_PREFIX}1`, '2026-08-21T06:04:05.123Z');
  assert.deepStrictEqual(
    mergeMessages([server], [pending]).map((m) => m.id),
    ['srv', `${PENDING_PREFIX}1`],
  );
});

// ── 첨부 표시 헬퍼 ───────────────────────────────────────────────

test('formatBytes: 사람이 읽는 단위로 줄인다 (0 바이트도 정상)', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(1024 * 1024 * 3.5), '3.5 MB');
  // 10 이상은 소수점을 버린다 — 목록에서 자릿수가 흔들리지 않게.
  assert.strictEqual(formatBytes(1024 * 1024 * 42), '42 MB');
  assert.strictEqual(formatBytes(Number.NaN), '');
});

test('isPreviewableImage: svg 는 미리보기에서 제외한다', () => {
  const base = { id: 'a', filename: 'x', size: 1, storageKey: 'k' };
  assert.strictEqual(isPreviewableImage({ ...base, mime: 'image/png' }), true);
  assert.strictEqual(isPreviewableImage({ ...base, mime: 'image/svg+xml' }), false);
  assert.strictEqual(isPreviewableImage({ ...base, mime: 'application/pdf' }), false);
});

test('messagePreview: 공유 메시지는 출처 표식을 걷어낸 본문을 보여 준다', () => {
  const shared = buildSharedMessage(
    { kind: 'agent', label: 'QA봇', workflowId: 'w', interactionId: 'i' },
    '요약 결과입니다\n두번째 줄',
  );
  assert.strictEqual(
    messagePreview(msg('m', '2026-08-24T10:00:00', { content: shared })),
    '요약 결과입니다',
  );
});

test('messagePreview: 본문이 없으면 첨부 이름으로 대신한다', () => {
  const withFile = msg('m', '2026-08-24T10:00:00', {
    content: '',
    attachments: [
      { id: 'a', filename: '보고서.xlsx', mime: 'application/x', size: 1, storageKey: 'k' },
    ],
  });
  assert.strictEqual(messagePreview(withFile), '📎 보고서.xlsx');
  assert.strictEqual(messagePreview(undefined), '');
});

// ── 업로드 사전 검증 (서버 415/413 을 미리 막는다) ───────────────

test('teamsAttachmentRejectReason: 허용 확장자는 통과한다', () => {
  assert.strictEqual(teamsAttachmentRejectReason('보고서.xlsx', 1024), null);
  assert.strictEqual(teamsAttachmentRejectReason('MEMO.PDF', 1024), null);
});

test('teamsAttachmentRejectReason: 허용되지 않은 형식과 확장자 없음을 막는다', () => {
  assert.ok(teamsAttachmentRejectReason('악성.exe', 10)?.includes('.exe'));
  assert.ok(teamsAttachmentRejectReason('확장자없음', 10)?.includes('확장자 없음'));
});

test('teamsAttachmentRejectReason: 서버 상한(50MB)을 넘으면 올리기 전에 막는다', () => {
  const over = 50 * 1024 * 1024 + 1;
  assert.ok(teamsAttachmentRejectReason('큰파일.pdf', over)?.includes('50MB'));
  assert.strictEqual(teamsAttachmentRejectReason('딱맞음.pdf', 50 * 1024 * 1024), null);
});

// ── 편집 반영은 "패치" 여야 한다 ─────────────────────────────────

test('applyEdit: 본문만 갈아끼우고 답장 인용·첨부는 지키다', () => {
  // 서버는 편집 결과로 온전한 메시지를 주지 않는다 — WS 프레임은 content 만,
  // PATCH 응답은 답장 스냅샷이 빠진 원본 행이다. 통째로 덮으면 답장을 편집한
  // 순간 "무엇에 답한 것인지" 가 화면에서 사라진다.
  const before = msg('m1', '2026-08-24T10:00:00', {
    content: '원래 본문',
    replyToId: 'm0',
    replyToSenderName: '김철수',
    replyToContent: '원본 질문',
    attachments: [
      { id: 'a', filename: 'x.pdf', mime: 'application/pdf', size: 1, storageKey: 'k' },
    ],
  });
  const after = applyEdit([before], 'm1', '고친 본문', '2026-08-24T10:05:00')[0];
  assert.strictEqual(after?.content, '고친 본문');
  assert.strictEqual(after?.isEdited, true);
  assert.strictEqual(after?.editedAt, '2026-08-24T10:05:00');
  assert.strictEqual(after?.replyToSenderName, '김철수');
  assert.strictEqual(after?.replyToContent, '원본 질문');
  assert.strictEqual(after?.attachments?.length, 1);
});

test('applyEdit: 빈 본문은 프레임 누락이므로 기존 본문을 지우지 않는다', () => {
  const before = msg('m1', '2026-08-24T10:00:00', { content: '살아 있어야 함' });
  const after = applyEdit([before], 'm1', '')[0];
  assert.strictEqual(after?.content, '살아 있어야 함');
});

test('applyEdit: 대상이 없으면 배열을 그대로 돌려준다 (불필요한 리렌더 방지)', () => {
  const list = [msg('m1', '2026-08-24T10:00:00')];
  assert.strictEqual(applyEdit(list, 'nope', '무엇이든'), list);
});

// ── 메모리: 한 방이 무한히 커지지 않는다 ─────────────────────────

test('mergeMessages: 상한을 넘으면 오래된 것부터 버린다', () => {
  // 위로 스크롤하면 계속 불러오고 실시간 메시지도 계속 쌓인다. 상한이 없으면
  // 오래 켜 둔 방이 무한히 커진다.
  // 시각은 **단조 증가**여야 한다. 순환시키면 정렬 순서가 생성 순서와 달라져
  // 테스트가 엉뚱한 것을 검증하게 된다.
  const stamp = (i: number): string => {
    const h = String(Math.floor(i / 3600) % 24).padStart(2, '0');
    const m = String(Math.floor(i / 60) % 60).padStart(2, '0');
    const sec = String(i % 60).padStart(2, '0');
    return `2026-08-25T${h}:${m}:${sec}`;
  };
  const many = Array.from({ length: MAX_ROOM_MESSAGES + 50 }, (_, i) =>
    msg(`m${String(i).padStart(4, '0')}`, stamp(i)),
  );
  const merged = mergeMessages([], many);
  assert.strictEqual(merged.length, MAX_ROOM_MESSAGES);
  // 남은 것은 뒤쪽(최근)이어야 한다 — 최근이 대화이고 과거는 스크롤로 다시 온다.
  assert.strictEqual(merged[merged.length - 1]?.id, many[many.length - 1]?.id);
});

test('mergeMessages: 상한 이하면 그대로 둔다', () => {
  const few = [msg('a', '2026-08-25T10:00:00'), msg('b', '2026-08-25T10:01:00')];
  assert.strictEqual(mergeMessages([], few).length, 2);
});
