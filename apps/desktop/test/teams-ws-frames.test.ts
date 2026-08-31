/**
 * Teams 방 소켓 프레임 → 커넥터 이벤트 매핑.
 *
 * 이 매핑이 틀려도 앱은 **조용히** 동작하는 것처럼 보인다. 프레임을 못 알아보면
 * 그냥 아무 일도 일어나지 않기 때문이다. 실제로 그랬다: `message_updated` 는
 * 서버가 `{message_id, content, edited_at}` 만 보내는데 커넥터가 `frame.message`
 * 를 찾다가 undefined 를 받아 프레임을 통째로 버렸고, 그래서 **남이 고친 메시지가
 * 새로고침 전까지 반영되지 않았다.** 눈으로는 잡히지 않는 종류의 버그다.
 *
 * 서버 프레임의 실제 모양은 `xgen-workflow/controller/teams/message_controller.py`
 * 와 `ws_controller.py` 를 따른다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRoomFrame, handleUserFrame } from '../src/main/teams-ws';
import type { TeamsEvent } from '@dex/protocol';

/** 프레임 하나를 흘려 넣고 나온 이벤트를 모은다. */
function feed(frame: Record<string, unknown>): TeamsEvent[] {
  const out: TeamsEvent[] = [];
  handleRoomFrame('room-1', frame, (event) => out.push(event));
  return out;
}

function feedUser(frame: Record<string, unknown>): TeamsEvent[] {
  const out: TeamsEvent[] = [];
  handleUserFrame(frame, (event) => out.push(event));
  return out;
}

test('message_new: 메시지를 정규화해 올린다', () => {
  const events = feed({
    type: 'message_new',
    message: {
      id: 'm1',
      room_id: 'room-1',
      sender_type: 'user',
      sender_id: '2',
      sender_name: '김철수',
      content: '안녕하세요',
      created_at: '2026-08-24T10:00:00',
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'message');
  if (events[0]?.kind === 'message') {
    assert.equal(events[0].message.senderName, '김철수');
    assert.equal(events[0].roomId, 'room-1');
  }
});

test('⭐ message_updated: 서버가 보내는 납작한 프레임을 버리지 않는다', () => {
  // 서버는 전체 메시지를 보내지 않는다 (message_controller.edit_message).
  const events = feed({
    type: 'message_updated',
    message_id: 'm1',
    content: '고친 본문',
    edited_at: '2026-08-24T10:05:00',
  });
  assert.equal(events.length, 1, '프레임이 버려졌다 — 남의 편집이 반영되지 않는다');
  assert.deepEqual(events[0], {
    kind: 'message_edited',
    roomId: 'room-1',
    messageId: 'm1',
    content: '고친 본문',
    editedAt: '2026-08-24T10:05:00',
  });
});

test('message_updated: 서버가 나중에 전체 메시지를 실어 줘도 받아들인다', () => {
  const events = feed({
    type: 'message_updated',
    message: {
      id: 'm2',
      room_id: 'room-1',
      sender_type: 'user',
      sender_id: '1',
      sender_name: 'admin',
      content: '전체로 온 본문',
      created_at: '2026-08-24T10:00:00',
      edited_at: '2026-08-24T10:06:00',
      is_edited: true,
    },
  });
  assert.equal(events.length, 1);
  if (events[0]?.kind === 'message_edited') {
    assert.equal(events[0].messageId, 'm2');
    assert.equal(events[0].content, '전체로 온 본문');
  } else {
    assert.fail('message_edited 가 아니다');
  }
});

test('message_updated: 대상 id 가 없으면 아무것도 하지 않는다', () => {
  assert.deepEqual(feed({ type: 'message_updated', content: '이건 어디에?' }), []);
});

test('reaction_update: 집계를 그대로 옮긴다', () => {
  const events = feed({
    type: 'reaction_update',
    message_id: 'm1',
    reactions: [{ emoji: '👍', count: 2, user_ids: [1, 2] }],
  });
  assert.equal(events.length, 1);
  if (events[0]?.kind === 'reactions') {
    assert.equal(events[0].messageId, 'm1');
    assert.deepEqual(events[0].reactions, [{ emoji: '👍', count: 2, userIds: [1, 2] }]);
  } else {
    assert.fail('reactions 가 아니다');
  }
});

test('reaction_update: 리액션이 다 지워지면 빈 배열로 알린다', () => {
  const events = feed({ type: 'reaction_update', message_id: 'm1', reactions: [] });
  assert.equal(events.length, 1);
  if (events[0]?.kind === 'reactions') assert.deepEqual(events[0].reactions, []);
});

test('typing_update: 단건 토글로 온다', () => {
  const events = feed({ type: 'typing_update', user_id: 7, username: '홍길동', is_typing: true });
  assert.deepEqual(events[0], {
    kind: 'typing',
    roomId: 'room-1',
    userId: 7,
    username: '홍길동',
    typing: true,
  });
});

test('presence_update: 숫자가 아닌 값은 걸러 낸다', () => {
  const events = feed({ type: 'presence_update', online_user_ids: [1, '2', null, 'x'] });
  assert.equal(events.length, 1);
  if (events[0]?.kind === 'presence') assert.deepEqual(events[0].onlineUserIds, [1, 2]);
});

test('멤버 변경 프레임은 변경 종류와 사용자를 보존한다', () => {
  assert.deepEqual(feed({ type: 'member_added', user_id: 3, username: 'new-user' }), [
    {
      kind: 'members_changed',
      roomId: 'room-1',
      change: 'joined',
      userId: 3,
      username: 'new-user',
      occurredAt: undefined,
    },
  ]);
  assert.deepEqual(
    feed({
      type: 'member_left',
      member: { user_id: 3, username: 'departed-user' },
      created_at: '2026-08-28T14:00:00',
    }),
    [
      {
        kind: 'members_changed',
        roomId: 'room-1',
        change: 'left',
        userId: 3,
        username: 'departed-user',
        occurredAt: '2026-08-28T14:00:00',
      },
    ],
  );
  assert.deepEqual(feed({ type: 'members_updated' }), [
    { kind: 'members_changed', roomId: 'room-1', change: 'updated' },
  ]);
});

test('사용자 소켓의 방 초대 이벤트와 서버 별칭을 방 목록 변경으로 정규화한다', () => {
  for (const type of ['room_invited', 'room_added', 'room_joined', 'room_created']) {
    assert.deepEqual(feedUser({ type, room_id: 'new-room' }), [
      { kind: 'rooms_changed', roomId: 'new-room', reason: 'invited' },
    ]);
  }
});

test('방 삭제 이벤트는 사용자·방 소켓 어느 쪽에서 와도 즉시 제거 이벤트로 정규화한다', () => {
  for (const type of ['room_removed', 'room_deleted', 'room_destroyed', 'room_archived']) {
    assert.deepEqual(feedUser({ type, room_id: 'deleted-room' }), [
      { kind: 'rooms_changed', roomId: 'deleted-room', reason: 'removed' },
    ]);
  }
  assert.deepEqual(feed({ type: 'room_deleted' }), [
    { kind: 'rooms_changed', roomId: 'room-1', reason: 'removed' },
  ]);
  assert.deepEqual(feedUser({ type: 'room_deleted', room: { id: 'nested-room' } }), [
    { kind: 'rooms_changed', roomId: 'nested-room', reason: 'removed' },
  ]);
});

test('모르는 프레임(pong 등)은 조용히 버린다', () => {
  assert.deepEqual(feed({ type: 'pong' }), []);
  assert.deepEqual(feed({}), []);
});
