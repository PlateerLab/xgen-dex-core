/**
 * OS 알림의 공통 이벤트와 계정별 정책.
 *
 * 이 모듈은 Electron/React 를 전혀 모르며, main 과 renderer 가 같은 이벤트 id 와
 * 음소거 우선순위를 공유하기 위한 순수 경계다. 실제 알림 표시는 main 의
 * notification-center.ts 한 곳에서만 한다.
 */

export const NOTIFICATION_EVENT_DEFAULTS = {
  'chat.completed': true,
  'chat.failed': true,
  'agent.requested': true,
  'teams.message': true,
  'teams.agent_message': true,
  'teams.invited': true,
  'teams.removed': true,
  'system.update_ready': true,
} as const;

export type NotificationEventType = keyof typeof NOTIFICATION_EVENT_DEFAULTS;
export type NotificationPrivacy = 'full' | 'sender-only' | 'hidden';
export type NotificationScope = 'agent' | 'chat' | 'teamsRoom' | 'teamsSender';

export interface NotificationMuteRule {
  muted: true;
  /** 오래된 개별 채팅 규칙을 나중에 정리할 수 있는 기준. */
  updatedAt: number;
  /** 사람이 설정 화면에서 대상을 알아볼 수 있는 best-effort 라벨. */
  label?: string;
}

export interface NotificationProfile {
  /** 계정 전체 hard gate. 미설정/true = 켜짐. */
  enabled: boolean;
  /** 이벤트별 hard gate. scope 의 켜짐이 이 값을 다시 뒤집지는 못한다. */
  events: Record<NotificationEventType, boolean>;
  /** 잠금 화면 노출을 줄이기 위한 본문 공개 수준. */
  privacy: NotificationPrivacy;
  mutedAgents: Record<string, NotificationMuteRule>;
  /** key = notificationChatKey(workflowId, interactionId). */
  mutedChats: Record<string, NotificationMuteRule>;
  mutedTeamsRooms: Record<string, NotificationMuteRule>;
  mutedTeamsSenders: Record<string, NotificationMuteRule>;
}

export interface NotificationSettings {
  version: 1;
  /** key = `<normalized serverUrl>|<userId>`. */
  accounts: Record<string, NotificationProfile>;
}

export type NotificationPreferenceUpdate =
  | { kind: 'master'; enabled: boolean }
  | { kind: 'event'; eventType: NotificationEventType; enabled: boolean }
  | { kind: 'privacy'; privacy: NotificationPrivacy }
  | {
      kind: 'scope';
      scope: NotificationScope;
      id: string;
      muted: boolean;
      label?: string;
    }
  | { kind: 'resetScopes' };

export type NotificationTarget =
  | { kind: 'none' }
  | {
      kind: 'chat';
      workflowId: string;
      workflowName: string;
      interactionId: string;
    }
  | { kind: 'teams'; roomId: string; roomName?: string; messageId?: string }
  | { kind: 'settings'; section: 'notifications' };

export interface NotificationEvent {
  /** 동일 사건을 두 transport 가 전해도 한 번만 보이게 하는 안정 id. */
  id: string;
  type: NotificationEventType;
  title: string;
  body?: string;
  occurredAt: string;
  workflowId?: string;
  workflowName?: string;
  interactionId?: string;
  teamsRoomId?: string;
  teamsMessageId?: string;
  senderId?: string;
  senderName?: string;
  /** OS 알림 센터에서 같은 대화끼리 묶는 키. */
  groupKey?: string;
  target: NotificationTarget;
}

export interface NotificationRendererContext {
  /** split pane 두 곳에 보이는 대화를 모두 싣는다. */
  visibleChats: string[];
  visibleTeamsRooms: string[];
  roomNames?: Record<string, string>;
}

export type NotificationDeliveryReason =
  | 'unsupported'
  | 'disabled'
  | 'visible'
  | 'duplicate'
  | 'macos-unsigned-dev'
  | 'macos-unsigned-app'
  | 'os-denied';

export interface NotificationDeliveryResult {
  /** 테스트에서는 OS 의 show 이벤트를 받은 경우에만 true 다. 일반 publish 는 표시 요청 여부다. */
  shown: boolean;
  reason?: NotificationDeliveryReason;
  /** Electron/OS 원문은 진단용이며 사용자 UI에는 그대로 노출하지 않는다. */
  detail?: string;
}

export interface NotificationSystemStatus {
  supported: boolean;
  platform: NodeJS.Platform;
  /** macOS 개발 실행은 서명되지 않아 UNNotification 이 거부한다. */
  developmentMode: boolean;
  /** ad-hoc 서명은 실행은 가능하지만 Electron 42+의 UNNotification에는 부족하다. */
  macCodeSignature?: 'unsigned' | 'adhoc' | 'signed';
}

function cleanRuleMap(value: unknown): Record<string, NotificationMuteRule> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, NotificationMuteRule> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key || !raw || typeof raw !== 'object') continue;
    const rule = raw as Partial<NotificationMuteRule>;
    if (rule.muted !== true) continue;
    out[key] = {
      muted: true,
      updatedAt: Number.isFinite(rule.updatedAt) ? Number(rule.updatedAt) : 0,
      label: typeof rule.label === 'string' && rule.label.trim() ? rule.label.trim() : undefined,
    };
  }
  return out;
}

export function defaultNotificationProfile(): NotificationProfile {
  return {
    enabled: true,
    events: { ...NOTIFICATION_EVENT_DEFAULTS },
    privacy: 'full',
    mutedAgents: {},
    mutedChats: {},
    mutedTeamsRooms: {},
    mutedTeamsSenders: {},
  };
}

/** 오래된/부분 설정을 현재 완전한 형태로 복원한다. */
export function normalizeNotificationProfile(
  raw: unknown,
  legacy?: { notifications?: boolean; mutedRooms?: string[] },
): NotificationProfile {
  const value = raw && typeof raw === 'object' ? (raw as Partial<NotificationProfile>) : {};
  const eventInput =
    value.events && typeof value.events === 'object'
      ? (value.events as Partial<Record<NotificationEventType, unknown>>)
      : {};
  const events = { ...NOTIFICATION_EVENT_DEFAULTS } as Record<NotificationEventType, boolean>;
  for (const eventType of Object.keys(events) as NotificationEventType[]) {
    if (typeof eventInput[eventType] === 'boolean')
      events[eventType] = eventInput[eventType] as boolean;
  }
  const mutedTeamsRooms = cleanRuleMap(value.mutedTeamsRooms);
  for (const roomId of legacy?.mutedRooms ?? []) {
    if (roomId && !mutedTeamsRooms[roomId]) {
      mutedTeamsRooms[roomId] = { muted: true, updatedAt: 0 };
    }
  }
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : legacy?.notifications !== false,
    events,
    privacy: value.privacy === 'sender-only' || value.privacy === 'hidden' ? value.privacy : 'full',
    mutedAgents: cleanRuleMap(value.mutedAgents),
    mutedChats: cleanRuleMap(value.mutedChats),
    mutedTeamsRooms,
    mutedTeamsSenders: cleanRuleMap(value.mutedTeamsSenders),
  };
}

export function notificationChatKey(workflowId: string, interactionId: string): string {
  return `${encodeURIComponent(workflowId)}:${encodeURIComponent(interactionId)}`;
}

export function notificationScopeMuted(
  profile: NotificationProfile,
  scope: NotificationScope,
  id: string,
): boolean {
  if (!id) return false;
  const map =
    scope === 'agent'
      ? profile.mutedAgents
      : scope === 'chat'
        ? profile.mutedChats
        : scope === 'teamsRoom'
          ? profile.mutedTeamsRooms
          : profile.mutedTeamsSenders;
  return map[id]?.muted === true;
}

/**
 * 정책의 hard-gate 순서. 이벤트 ON 이어도 매칭되는 scope 음소거가 하나라도 있으면
 * 표시하지 않는다. unread 배지 판정은 이 함수와 별개다.
 */
export function notificationAllowed(
  profile: NotificationProfile,
  event: Pick<
    NotificationEvent,
    'type' | 'workflowId' | 'interactionId' | 'teamsRoomId' | 'senderId'
  >,
): boolean {
  if (!profile.enabled || profile.events[event.type] === false) return false;
  if (event.workflowId && notificationScopeMuted(profile, 'agent', event.workflowId)) return false;
  if (
    event.workflowId &&
    event.interactionId &&
    notificationScopeMuted(
      profile,
      'chat',
      notificationChatKey(event.workflowId, event.interactionId),
    )
  ) {
    return false;
  }
  if (event.teamsRoomId && notificationScopeMuted(profile, 'teamsRoom', event.teamsRoomId)) {
    return false;
  }
  if (event.senderId && notificationScopeMuted(profile, 'teamsSender', event.senderId)) {
    return false;
  }
  return true;
}

export function applyNotificationPreferenceUpdate(
  current: NotificationProfile,
  update: NotificationPreferenceUpdate,
  now = Date.now(),
): NotificationProfile {
  const profile = normalizeNotificationProfile(current);
  if (update.kind === 'master') return { ...profile, enabled: update.enabled };
  if (update.kind === 'event') {
    return { ...profile, events: { ...profile.events, [update.eventType]: update.enabled } };
  }
  if (update.kind === 'privacy') return { ...profile, privacy: update.privacy };
  if (update.kind === 'resetScopes') {
    return {
      ...profile,
      mutedAgents: {},
      mutedChats: {},
      mutedTeamsRooms: {},
      mutedTeamsSenders: {},
    };
  }

  const field =
    update.scope === 'agent'
      ? 'mutedAgents'
      : update.scope === 'chat'
        ? 'mutedChats'
        : update.scope === 'teamsRoom'
          ? 'mutedTeamsRooms'
          : 'mutedTeamsSenders';
  const map = { ...profile[field] };
  if (update.muted) {
    map[update.id] = {
      muted: true,
      updatedAt: now,
      label: update.label?.trim() || undefined,
    };
  } else {
    delete map[update.id];
  }
  return { ...profile, [field]: map };
}

export function notificationProfileForAccount(
  settings: NotificationSettings | undefined,
  accountKey: string,
  legacy?: { notifications?: boolean; mutedRooms?: string[] },
): NotificationProfile {
  return normalizeNotificationProfile(settings?.accounts?.[accountKey], legacy);
}

export function withNotificationProfile(
  settings: NotificationSettings | undefined,
  accountKey: string,
  profile: NotificationProfile,
): NotificationSettings {
  return {
    version: 1,
    accounts: {
      ...(settings?.accounts ?? {}),
      [accountKey]: normalizeNotificationProfile(profile),
    },
  };
}
