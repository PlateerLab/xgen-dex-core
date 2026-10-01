import type { NativeRpcResult, NativeSessionNotification } from '@dex/rpc';

export type DesktopNativeMethod = 'device' | 'session' | 'watch' | 'conversation' | 'watch-conversation' | 'unwatch' | 'cancel';
export type DesktopNativeReply = { ok: true; value: NativeRpcResult | { watching: false } }
  | { ok: false; code: string; message: string };
export type DesktopNativeNotice = { type: 'cleared' } | { type: 'update'; value: NativeSessionNotification };

export interface DesktopNativeBridge {
  request(method: DesktopNativeMethod, params?: Record<string, unknown>): Promise<DesktopNativeReply>;
  onUpdate(listener: (notice: DesktopNativeNotice) => void): () => void;
}
