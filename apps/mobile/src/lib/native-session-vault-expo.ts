import * as SecureStore from 'expo-secure-store';
import { requireOptionalNativeModule } from 'expo';
import { createMobileSessionVault, MobileVaultError } from './native-session-vault';

const options: SecureStore.SecureStoreOptions = { keychainService: 'xgen-mobile-platform-v1',
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY, requireAuthentication: false };
export const mobileSessionVault = createMobileSessionVault({
  getItemAsync: (key) => SecureStore.getItemAsync(key, options),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
});
const module = requireOptionalNativeModule<{ newGeneration(): string }>('XgenNativeDevice');
export function mobileSessionGeneration(): string {
  const value = module?.newGeneration();
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new MobileVaultError();
  return value;
}
