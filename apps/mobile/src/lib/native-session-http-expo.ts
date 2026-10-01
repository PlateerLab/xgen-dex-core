import { requireOptionalNativeModule } from 'expo';
import { createMobileSessionFetch, type MobileSessionHttpModule } from './native-session-http';
const module = requireOptionalNativeModule<MobileSessionHttpModule>('XgenNativeDevice');
export const mobileSessionFetch = (origin: string) => createMobileSessionFetch(module, origin);
