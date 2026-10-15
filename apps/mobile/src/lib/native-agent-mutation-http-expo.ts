import { requireOptionalNativeModule } from 'expo';
import {
  createMobileAgentMutationFetch,
  createMobileTurnKey,
  type MobileAgentMutationHttpModule,
} from './native-agent-mutation-http';

const module = requireOptionalNativeModule<MobileAgentMutationHttpModule>('XgenNativeDevice');

export const mobileAgentMutationFetch = (origin: string) => createMobileAgentMutationFetch(module, origin);
export const mobileTurnKey = () => createMobileTurnKey(module);
