/** 단 하나의 OS 알림 출구 — 정책/중복/포커스/클릭 이동을 한 곳에서 보장한다. */
import { app, Notification, type NotificationConstructorOptions } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  notificationAllowed,
  notificationChatKey,
  type NotificationEvent,
  type NotificationProfile,
  type NotificationRendererContext,
  type NotificationTarget,
  type NotificationDeliveryResult,
  type NotificationSystemStatus,
} from '../core/notifications';

export interface NotificationCenterDeps {
  profile: () => NotificationProfile;
  isWindowFocused: () => boolean;
  revealWindow: () => void;
  navigate: (target: NotificationTarget) => void;
}

export interface NotificationPublishOptions {
  /** 업데이트 설치처럼 클릭이 deep-link 대신 함수를 실행하는 경우. */
  onClick?: () => void;
  /** 설정의 테스트 알림에서만 쓴다. */
  bypassPolicy?: boolean;
  bypassVisibility?: boolean;
  /** 설정의 테스트 알림이 실제 OS 수락/거부를 기다릴 때만 쓴다. */
  onShow?: () => void;
  onFailed?: (error: string) => void;
}

export type NotificationPublishResult = NotificationDeliveryResult;

const DEDUPE_TTL_MS = 10 * 60_000;
const MAX_DEDUPE = 500;
const execFileAsync = promisify(execFile);
let macSignaturePromise: Promise<'unsigned' | 'adhoc' | 'signed'> | null = null;

function macAppBundlePath(): string | null {
  const marker = '.app/Contents/MacOS/';
  const index = process.execPath.indexOf(marker);
  return index < 0 ? null : process.execPath.slice(0, index + 4);
}

async function macCodeSignature(): Promise<'unsigned' | 'adhoc' | 'signed'> {
  if (process.platform !== 'darwin') return 'unsigned';
  if (macSignaturePromise) return macSignaturePromise;
  macSignaturePromise = (async () => {
    const appPath = macAppBundlePath();
    if (!appPath) return 'unsigned';
    try {
      // codesign -d 는 서명 정보를 stderr 에 쓴다. CMS Authority가 있고
      // Signature=adhoc 가 아니어야 UNNotification이 식별 가능한 앱 서명이다.
      const result = await execFileAsync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
      const output = `${result.stdout}\n${result.stderr}`;
      if (/Signature=adhoc/i.test(output) || /flags=.*adhoc/i.test(output)) return 'adhoc';
      return /Authority=|TeamIdentifier=(?!not set)/i.test(output) ? 'signed' : 'unsigned';
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string };
      const output = `${detail.stdout ?? ''}\n${detail.stderr ?? ''}`;
      if (/Signature=adhoc/i.test(output) || /flags=.*adhoc/i.test(output)) return 'adhoc';
      return 'unsigned';
    }
  })();
  return macSignaturePromise;
}

function visibleFor(event: NotificationEvent, context: NotificationRendererContext): boolean {
  if (event.workflowId && event.interactionId) {
    return context.visibleChats.includes(
      notificationChatKey(event.workflowId, event.interactionId),
    );
  }
  return !!event.teamsRoomId && context.visibleTeamsRooms.includes(event.teamsRoomId);
}

function displayText(
  event: NotificationEvent,
  profile: NotificationProfile,
): { title: string; body: string } {
  if (profile.privacy === 'hidden') {
    return { title: 'XGen Dex', body: '새 알림이 있습니다.' };
  }
  if (profile.privacy === 'sender-only') {
    return {
      title: event.senderName || event.workflowName || event.title || 'XGen Dex',
      body: '새 알림이 있습니다.',
    };
  }
  return {
    title: platformText(String(event.title || 'XGen Dex'), 100, 80),
    // macOS 는 긴 본문을 빨리 자르므로 세 플랫폼 공통으로 짧게 유지한다.
    body: platformText(String(event.body || '새 알림이 있습니다.'), 220, 160),
  };
}

/** macOS UNNotification 의 256-byte 제한 안에 title/body 가 함께 머물도록 자른다. */
function platformText(value: string, maxCharacters: number, macMaxBytes: number): string {
  const text = value.slice(0, maxCharacters);
  if (process.platform !== 'darwin' || Buffer.byteLength(text, 'utf8') <= macMaxBytes) return text;
  let out = '';
  for (const character of text) {
    if (Buffer.byteLength(out + character, 'utf8') > macMaxBytes) break;
    out += character;
  }
  return out;
}

export class NotificationCenter {
  private context: NotificationRendererContext = {
    visibleChats: [],
    visibleTeamsRooms: [],
    roomNames: {},
  };
  private live = new Map<string, Notification>();
  private seen = new Map<string, number>();
  private pendingTarget: NotificationTarget | null = null;

  constructor(private readonly deps: NotificationCenterDeps) {}

  setContext(context: Partial<NotificationRendererContext> | null | undefined): void {
    const visibleChats = Array.isArray(context?.visibleChats) ? context.visibleChats : [];
    const visibleTeamsRooms = Array.isArray(context?.visibleTeamsRooms)
      ? context.visibleTeamsRooms
      : [];
    this.context = {
      visibleChats: [...new Set(visibleChats.filter(Boolean))],
      visibleTeamsRooms: [...new Set(visibleTeamsRooms.filter(Boolean))],
      roomNames: { ...(context?.roomNames ?? {}) },
    };
  }

  roomName(roomId: string): string | undefined {
    return this.context.roomNames?.[roomId];
  }

  async status(): Promise<NotificationSystemStatus> {
    return {
      supported: Notification.isSupported(),
      platform: process.platform,
      developmentMode: !app.isPackaged,
      macCodeSignature: process.platform === 'darwin' ? await macCodeSignature() : undefined,
    };
  }

  consumePendingTarget(): NotificationTarget | null {
    const target = this.pendingTarget;
    this.pendingTarget = null;
    return target;
  }

  publish(
    event: NotificationEvent,
    options: NotificationPublishOptions = {},
  ): NotificationPublishResult {
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };
    const profile = this.deps.profile();
    if (!options.bypassPolicy && !notificationAllowed(profile, event)) {
      return { shown: false, reason: 'disabled' };
    }
    if (
      !options.bypassVisibility &&
      this.deps.isWindowFocused() &&
      visibleFor(event, this.context)
    ) {
      return { shown: false, reason: 'visible' };
    }
    this.pruneSeen();
    if (this.seen.has(event.id)) return { shown: false, reason: 'duplicate' };
    this.seen.set(event.id, Date.now());

    const text = displayText(event, profile);
    const notificationOptions: NotificationConstructorOptions = {
      title: text.title,
      body: text.body,
      silent: false,
    };
    if (process.platform === 'darwin' || process.platform === 'win32') {
      notificationOptions.id = event.id;
      if (event.groupKey) notificationOptions.groupId = event.groupKey;
    }
    if (process.platform === 'linux' || process.platform === 'win32') {
      notificationOptions.timeoutType = 'default';
      notificationOptions.urgency = event.type.endsWith('failed') ? 'critical' : 'normal';
    }

    const notification = new Notification(notificationOptions);
    const cleanup = (): void => {
      if (this.live.get(event.id) === notification) this.live.delete(event.id);
    };
    notification.on('click', () => {
      this.deps.revealWindow();
      if (options.onClick) {
        options.onClick();
      } else if (event.target.kind !== 'none') {
        // renderer 가 재로딩 중이면 consumePendingTarget()이 같은 목적지를 받는다.
        this.pendingTarget = event.target;
        this.deps.navigate(event.target);
      }
      cleanup();
    });
    notification.once('show', () => options.onShow?.());
    notification.once('close', cleanup);
    notification.once('failed', (_event, error) => {
      const detail = String(error || '알 수 없는 OS 알림 오류');
      console.warn(`[notification] 표시 실패 type=${event.type} id=${event.id}: ${detail}`);
      options.onFailed?.(detail);
      // OS 가 표시를 거부했다면 같은 이벤트의 재시도까지 중복으로 막지 않는다.
      this.seen.delete(event.id);
      cleanup();
    });
    this.live.set(event.id, notification);
    notification.show();
    return { shown: true };
  }

  async test(): Promise<NotificationDeliveryResult> {
    // Electron 42+의 macOS 구현은 UNNotification 기반이다. node_modules 의
    // Electron.app 로 실행하는 dev 모드는 유효한 앱 서명이 없어 반드시 실패한다.
    if (process.platform === 'darwin') {
      const signature = await macCodeSignature();
      if (signature !== 'signed') {
        return {
          shown: false,
          reason: app.isPackaged ? 'macos-unsigned-app' : 'macos-unsigned-dev',
        };
      }
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: NotificationDeliveryResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      const requested = this.publish(
        {
          id: `notification-test-${Date.now()}`,
          type: 'agent.requested',
          title: 'XGen Dex 테스트 알림',
          body: '알림이 정상적으로 표시되고 있습니다.',
          occurredAt: new Date().toISOString(),
          target: { kind: 'settings', section: 'notifications' },
        },
        {
          bypassPolicy: true,
          bypassVisibility: true,
          onShow: () => finish({ shown: true }),
          onFailed: (detail) => finish({ shown: false, reason: 'os-denied', detail }),
        },
      );
      if (!requested.shown) finish(requested);
      // 일부 Linux 데스크톱은 show 이벤트를 돌려주지 않는다. API 요청 자체가
      // 성공했다면 기존 동작처럼 성공으로 처리하되 macOS/Windows 실패 이벤트를 기다린다.
      if (!settled) timer = setTimeout(() => finish({ shown: true }), 1_500);
    });
  }

  private pruneSeen(): void {
    const cutoff = Date.now() - DEDUPE_TTL_MS;
    for (const [id, at] of this.seen) {
      if (at < cutoff || this.seen.size > MAX_DEDUPE) this.seen.delete(id);
    }
  }
}
