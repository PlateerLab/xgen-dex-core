import type { NativeRpcResult, NativeSessionNotification } from '@dex/rpc';
import type { AgentSessionMutationConflict } from '@dex/protocol/agent-session-mutation';
import type { AgentSessionLifecycleConflict } from '@dex/protocol/agent-session-lifecycle';

export type DesktopNativeMethod = 'device' | 'session' | 'watch' | 'conversation' | 'watch-conversation' | 'watch-live'
  | 'submit-turn' | 'stop-turn' | 'agent-sessions' | 'create-agent-session' | 'switch-agent-focus'
  | 'pick-attachments' | 'attachments' | 'upload-attachment' | 'recover-attachment' | 'cancel-attachment'
  | 'discard-attachments' | 'unwatch' | 'cancel'
  | 'capabilities' | 'select-capabilities' | 'capability-approvals' | 'adopt-capability-approval'
  | 'connect-capabilities' | 'capability-status' | 'confirm-capability' | 'disconnect-capabilities';
export type DesktopNativeMutationFailure = {
  outcome: 'rejected'; status: number; conflict?: AgentSessionMutationConflict | AgentSessionLifecycleConflict;
} | { outcome: 'unknown' };
export interface DesktopCapabilityPresence {
  available: boolean;
  reason: 'checking' | 'locked' | 'suspended' | 'inactive' | 'closing' | null;
}
export type DesktopNativeReply = { ok: true; value: (NativeRpcResult | { watching: false }) & { capability_presence?: DesktopCapabilityPresence } }
  | ({ ok: false; code: string; message: string } & (DesktopNativeMutationFailure | { outcome?: never }));
export type DesktopNativeNotice = { type: 'cleared' } | { type: 'update'; value: NativeSessionNotification }
  | { type: 'capability-presence'; presence: DesktopCapabilityPresence };

export interface DesktopNativeBridge {
  request(method: DesktopNativeMethod, params?: Record<string, unknown>): Promise<DesktopNativeReply>;
  onUpdate(listener: (notice: DesktopNativeNotice) => void): () => void;
}
