import type { NativeFocusNotification, NativeRpcResult } from '@dex/rpc';

export type DesktopNativeMethod = 'device' | 'session' | 'watch' | 'unwatch' | 'cancel';
export type DesktopNativeReply = { ok: true; value: NativeRpcResult | { watching: false } }
  | { ok: false; code: string; message: string };
export type DesktopNativeNotice = { type: 'cleared' } | { type: 'update'; value: NativeFocusNotification };

export interface DesktopNativeBridge {
  request(method: DesktopNativeMethod, params?: Record<string, unknown>): Promise<DesktopNativeReply>;
  onUpdate(listener: (notice: DesktopNativeNotice) => void): () => void;
}
