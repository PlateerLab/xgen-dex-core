import { requireOptionalNativeModule } from 'expo';
import { createMobileAgentFetch, type MobileAgentHttpModule } from './native-agent-http';
const module = requireOptionalNativeModule<MobileAgentHttpModule>('XgenNativeDevice');
export const mobileAgentFetch = (origin: string) => createMobileAgentFetch(module, origin);
