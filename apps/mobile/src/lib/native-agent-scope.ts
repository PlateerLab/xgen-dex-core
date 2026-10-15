import { sha256 } from 'js-sha256';
import type { MobileNativeContext, MobileDeviceIdentity } from './native-device-key';
import type { MobilePlatformRecord } from './native-session-vault';

/** Public cursor/write binding; token and refresh generation never enter this scope. */
export function mobileAgentScope(authority: MobileNativeContext, identity: MobileDeviceIdentity, record: MobilePlatformRecord): string {
  return sha256(JSON.stringify(['mobile-focus-v1', authority.origin, authority.userId, authority.authScope,
    identity.installId, record.deviceId, record.sessionId, record.keyThumbprint]));
}
