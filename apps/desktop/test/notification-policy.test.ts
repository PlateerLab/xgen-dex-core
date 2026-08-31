import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyNotificationPreferenceUpdate,
  defaultNotificationProfile,
  notificationAllowed,
  notificationChatKey,
  notificationProfileForAccount,
  withNotificationProfile,
  type NotificationEvent,
} from '../src/core/notifications';

function event(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: 'e1',
    type: 'chat.completed',
    title: '완료',
    occurredAt: '2026-08-27T00:00:00Z',
    workflowId: 'wf-1',
    interactionId: 'chat-1',
    target: { kind: 'none' },
    ...over,
  };
}

test('기본 정책은 지원 이벤트를 켠다', () => {
  const profile = defaultNotificationProfile();
  assert.equal(notificationAllowed(profile, event()), true);
  assert.equal(profile.events['teams.message'], true);
});

test('이벤트 OFF 는 모든 하위 scope 보다 우선한다', () => {
  const profile = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'event',
    eventType: 'chat.completed',
    enabled: false,
  });
  assert.equal(notificationAllowed(profile, event()), false);
});

test('에이전트 음소거는 그 아래 모든 채팅을 막는다', () => {
  const profile = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'scope',
    scope: 'agent',
    id: 'wf-1',
    muted: true,
    label: '에이전트 1',
  });
  assert.equal(notificationAllowed(profile, event({ interactionId: 'chat-1' })), false);
  assert.equal(notificationAllowed(profile, event({ interactionId: 'chat-2' })), false);
  assert.equal(notificationAllowed(profile, event({ workflowId: 'wf-2' })), true);
});

test('개별 채팅 음소거는 같은 에이전트의 다른 채팅을 막지 않는다', () => {
  const profile = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'scope',
    scope: 'chat',
    id: notificationChatKey('wf-1', 'chat-1'),
    muted: true,
  });
  assert.equal(notificationAllowed(profile, event({ interactionId: 'chat-1' })), false);
  assert.equal(notificationAllowed(profile, event({ interactionId: 'chat-2' })), true);
});

test('Teams 방과 발신자 음소거를 각각 적용한다', () => {
  let profile = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'scope',
    scope: 'teamsRoom',
    id: 'room-1',
    muted: true,
  });
  assert.equal(
    notificationAllowed(profile, event({ type: 'teams.message', teamsRoomId: 'room-1' })),
    false,
  );
  assert.equal(
    notificationAllowed(profile, event({ type: 'teams.message', teamsRoomId: 'room-2' })),
    true,
  );
  profile = applyNotificationPreferenceUpdate(profile, {
    kind: 'scope',
    scope: 'teamsSender',
    id: 'sender-7',
    muted: true,
  });
  assert.equal(
    notificationAllowed(
      profile,
      event({
        type: 'teams.message',
        teamsRoomId: 'room-2',
        senderId: 'sender-7',
      }),
    ),
    false,
  );
});

test('legacy Teams 전체/방 음소거를 최초 계정 프로필로 이관한다', () => {
  const profile = notificationProfileForAccount(undefined, 'server|user', {
    notifications: false,
    mutedRooms: ['room-old'],
  });
  assert.equal(profile.enabled, false);
  assert.equal(profile.mutedTeamsRooms['room-old']?.muted, true);
});

test('계정별 프로필은 서로 섞이지 않는다', () => {
  const muted = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'scope',
    scope: 'agent',
    id: 'wf-1',
    muted: true,
  });
  const settings = withNotificationProfile(undefined, 'server-a|7', muted);
  assert.equal(
    notificationAllowed(notificationProfileForAccount(settings, 'server-b|7'), event()),
    true,
  );
  assert.equal(
    notificationAllowed(notificationProfileForAccount(settings, 'server-a|7'), event()),
    false,
  );
});

test('scope 초기화는 이벤트 설정을 보존한다', () => {
  let profile = applyNotificationPreferenceUpdate(defaultNotificationProfile(), {
    kind: 'event',
    eventType: 'teams.message',
    enabled: false,
  });
  profile = applyNotificationPreferenceUpdate(profile, {
    kind: 'scope',
    scope: 'agent',
    id: 'wf-1',
    muted: true,
  });
  profile = applyNotificationPreferenceUpdate(profile, { kind: 'resetScopes' });
  assert.equal(profile.mutedAgents['wf-1'], undefined);
  assert.equal(profile.events['teams.message'], false);
});
