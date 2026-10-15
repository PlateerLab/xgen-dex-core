import { requireOptionalNativeModule } from 'expo';
import { createMobileDeviceKeys, type MobileNativeContext, type MobileNativeKeyModule } from './native-device-key';

// Expo Go/web lack the module. Existing login/chat still work; native enrollment must stay closed.
const module = requireOptionalNativeModule<MobileNativeKeyModule>('XgenNativeDevice');
export const mobileDeviceKeys = (current: () => MobileNativeContext | null) => createMobileDeviceKeys(module, current);
