import { NativePlatformSessionClient, type NativeApprovalRequest,
  type NativeDeviceStatus, type NativeTrustOverview } from '@dex/protocol/native-platform-session';
import { NativeDeviceKeyStore, nativeKeyScope } from './native-device-key-store';
import { DexError } from './errors';
import { withNativeAccount } from './native-account';

export type NativeEnrollmentAction = { action: 'register'; deviceName?: string }
  | { action: 'status' } | { action: 'approvers' } | { action: 'request-approval'; approverDeviceId: string };
export interface NativeEnrollmentOptions {
  origin: string;
  email: string;
  password: string;
  operation: NativeEnrollmentAction;
  keys: Pick<NativeDeviceKeyStore, 'withIdentity'>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
export type NativeEnrollmentResult = NativeDeviceStatus | NativeApprovalRequest | NativeTrustOverview | null;

/** A fresh, temporary account login; no legacy token is read from or written to a credential file. */
export async function nativeDeviceEnrollment(options: NativeEnrollmentOptions): Promise<NativeEnrollmentResult> {
  const origin = nativeKeyScope({ origin: options.origin, platform: 'cli', userId: '1' }).origin;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return withNativeAccount({ ...options, origin }, async (userId, current) => {
    const scope = nativeKeyScope({ origin, platform: 'cli', userId });
    return options.keys.withIdentity(scope, options.operation.action === 'register', async (identity) => {
      options.signal?.throwIfAborted();
      const client = new NativePlatformSessionClient({ origin, platform: 'cli', identity, fetch: fetchImpl, account: { current } });
      if (options.operation.action === 'approvers') return client.trustOverview(options.signal);
      const status = await client.registrationStatus(options.signal);
      if (options.operation.action === 'status') return status;
      if (options.operation.action === 'register') return status ?? client.register(options.operation.deviceName ?? 'CLI', options.signal);
      if (!status || status.state !== 'pending') throw new DexError('usage_error', '승인 대기 중인 CLI 기기가 필요합니다.');
      return client.requestApproval(status.device_id, options.operation.approverDeviceId, options.signal);
    });
  });
}
