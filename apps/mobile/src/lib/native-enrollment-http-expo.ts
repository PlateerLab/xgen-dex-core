import { requireOptionalNativeModule } from 'expo';
import { createMobileEnrollmentFetch, type MobileEnrollmentHttpModule } from './native-enrollment-http';
const module = requireOptionalNativeModule<MobileEnrollmentHttpModule>('XgenNativeDevice');
export const mobileEnrollmentFetch = (origin: string) => createMobileEnrollmentFetch(module, origin);
