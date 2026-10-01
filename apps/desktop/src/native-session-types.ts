import type { NativeRpcResult, NativeSessionNotification } from '@dex/rpc';
import type { AgentSessionMutationConflict } from '@dex/protocol/agent-session-mutation';

export type DesktopNativeMethod = 'device' | 'session' | 'watch' | 'conversation' | 'watch-conversation' | 'watch-live'
  | 'submit-turn' | 'stop-turn' | 'unwatch' | 'cancel';
export type DesktopNativeMutationFailure = {
  outcome: 'rejected'; status: number; conflict?: AgentSessionMutationConflict;
} | { outcome: 'unknown' };
export type DesktopNativeReply = { ok: true; value: NativeRpcResult | { watching: false } }
  | ({ ok: false; code: string; message: string } & (DesktopNativeMutationFailure | { outcome?: never }));
export type DesktopNativeNotice = { type: 'cleared' } | { type: 'update'; value: NativeSessionNotification };

export interface DesktopNativeBridge {
  request(method: DesktopNativeMethod, params?: Record<string, unknown>): Promise<DesktopNativeReply>;
  onUpdate(listener: (notice: DesktopNativeNotice) => void): () => void;
}
