import { requireOptionalNativeModule } from 'expo';
import {
  createMobileAgentLifecycleFetch,
  type MobileAgentLifecycleHttpModule,
} from './native-agent-lifecycle-http';

const module = requireOptionalNativeModule<MobileAgentLifecycleHttpModule>('XgenNativeDevice');

export const mobileAgentLifecycleFetch = (origin: string) => createMobileAgentLifecycleFetch(module, origin);
