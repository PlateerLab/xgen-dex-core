/** renderer 의 계정별 알림 설정 캐시. OS 표시는 하지 않고 main 정책만 편집한다. */
import { useSyncExternalStore } from 'react';
import {
  defaultNotificationProfile,
  notificationChatKey,
  type NotificationEventType,
  type NotificationPreferenceUpdate,
  type NotificationPrivacy,
  type NotificationProfile,
  type NotificationScope,
  type NotificationSystemStatus,
} from '@dex/protocol/notifications';
import { xgen } from './bridge';

export interface NotificationSnapshot {
  profile: NotificationProfile;
  loaded: boolean;
  supported: boolean | null;
  platform: NotificationSystemStatus['platform'] | '';
  developmentMode: boolean;
  macCodeSignature?: NotificationSystemStatus['macCodeSignature'];
  error: string;
}

class NotificationStore {
  private snapshot: NotificationSnapshot = {
    profile: defaultNotificationProfile(),
    loaded: false,
    supported: null,
    platform: '',
    developmentMode: false,
    macCodeSignature: undefined,
    error: '',
  };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NotificationSnapshot => this.snapshot;

  private emit(patch: Partial<NotificationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.loading = null;
    this.emit({
      profile: defaultNotificationProfile(),
      loaded: false,
      supported: null,
      platform: '',
      developmentMode: false,
      macCodeSignature: undefined,
      error: '',
    });
  }

  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = Promise.all([xgen.notifications.preferences(), xgen.notifications.status()])
      .then(([profile, status]) => {
        this.emit({
          profile,
          loaded: true,
          supported: status.supported,
          platform: status.platform,
          developmentMode: status.developmentMode,
          macCodeSignature: status.macCodeSignature,
          error: '',
        });
      })
      .catch((error: unknown) => {
        this.emit({
          loaded: true,
          error: error instanceof Error ? error.message : '알림 설정을 불러오지 못했습니다.',
        });
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async update(update: NotificationPreferenceUpdate): Promise<void> {
    try {
      const profile = await xgen.notifications.update(update);
      this.emit({ profile, loaded: true, error: '' });
    } catch (error) {
      this.emit({
        error: error instanceof Error ? error.message : '알림 설정을 저장하지 못했습니다.',
      });
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.update({ kind: 'master', enabled });
  }

  setEvent(eventType: NotificationEventType, enabled: boolean): Promise<void> {
    return this.update({ kind: 'event', eventType, enabled });
  }

  setPrivacy(privacy: NotificationPrivacy): Promise<void> {
    return this.update({ kind: 'privacy', privacy });
  }

  setScope(scope: NotificationScope, id: string, muted: boolean, label?: string): Promise<void> {
    return this.update({ kind: 'scope', scope, id, muted, label });
  }

  setChat(
    workflowId: string,
    interactionId: string,
    muted: boolean,
    label?: string,
  ): Promise<void> {
    return this.setScope('chat', notificationChatKey(workflowId, interactionId), muted, label);
  }

  resetScopes(): Promise<void> {
    return this.update({ kind: 'resetScopes' });
  }
}

export const notificationStore = new NotificationStore();

export function useNotifications(): NotificationSnapshot {
  return useSyncExternalStore(
    notificationStore.subscribe,
    notificationStore.getSnapshot,
    notificationStore.getSnapshot,
  );
}
