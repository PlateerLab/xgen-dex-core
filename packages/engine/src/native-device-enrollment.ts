import { NativePlatformSessionClient, type NativeApprovalRequest,
  type NativeDeviceStatus, type NativeTrustOverview } from '@dex/protocol/native-platform-session';
import { NativeDeviceKeyStore, nativeKeyScope, type NativeKeyScope } from './native-device-key-store';
import { DexError } from './errors';
import { withNativeAccount } from './native-account';

export type NativeEnrollmentAction = { action: 'register'; deviceName?: string }
  | { action: 'status' } | { action: 'approvers' } | { action: 'request-approval'; approverDeviceId: string };
export interface NativeEnrollmentOptions {
  origin: string;
  /** Fixed by the owning host, never selected from an RPC operation body. */
  platform?: NativeKeyScope['platform'];
  email: string;
  password: string;
  operation: NativeEnrollmentAction;
  keys: Pick<NativeDeviceKeyStore, 'withIdentity'>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
export type NativeEnrollmentResult = NativeDeviceStatus | NativeApprovalRequest | NativeTrustOverview | null;
export interface NativeAccountEnrollmentResult { user_id: string; result: NativeEnrollmentResult }

/** A fresh, temporary account login; no legacy token is read from or written to a credential file. */
export async function nativeDeviceEnrollment(options: NativeEnrollmentOptions): Promise<NativeEnrollmentResult> {
  return (await nativeAccountDeviceEnrollment(options)).result;
}
export async function nativeAccountDeviceEnrollment(options: NativeEnrollmentOptions): Promise<NativeAccountEnrollmentResult> {
  const platform = options.platform ?? 'cli';
  const origin = nativeKeyScope({ origin: options.origin, platform, userId: '1' }).origin;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return withNativeAccount({ ...options, origin }, async (userId, current) => {
    const scope = nativeKeyScope({ origin, platform, userId });
    const result = await options.keys.withIdentity(scope, options.operation.action === 'register', async (identity) => {
      options.signal?.throwIfAborted();
      const client = new NativePlatformSessionClient({ origin, platform, identity, fetch: fetchImpl, account: { current } });
      if (options.operation.action === 'approvers') return client.trustOverview(options.signal);
      const status = await client.registrationStatus(options.signal);
      if (options.operation.action === 'status') return status;
      if (options.operation.action === 'register') return status ?? client.register(options.operation.deviceName ?? platform, options.signal);
      if (!status || status.state !== 'pending') throw new DexError('usage_error', '해당 플랫폼의 승인 대기 기기가 필요합니다.');
      return client.requestApproval(status.device_id, options.operation.approverDeviceId, options.signal);
    });
    return { user_id: userId, result };
  });
}
