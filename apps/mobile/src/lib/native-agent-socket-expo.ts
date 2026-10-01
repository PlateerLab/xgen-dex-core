import { requireOptionalNativeModule } from 'expo';
import { createMobileAgentSocketTransport, type MobileAgentSocketModule } from './native-agent-socket';
const module = requireOptionalNativeModule<MobileAgentSocketModule>('XgenNativeDevice');
export const mobileAgentSocketTransport = (origin: string) => createMobileAgentSocketTransport(module, origin);
