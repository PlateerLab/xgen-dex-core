/**
 * DevicePort 의 React Native(Expo) 구현 — 모바일 도구가 기기 기능에 닿는 곳.
 *
 * 파일은 여기 없다 — 대화에 연결한 폴더를 folder-fs 가 다룬다.
 */

import * as Battery from 'expo-battery';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { Platform, Share as RnShare } from 'react-native';
import type { DevicePort, PermissionState } from './mobile-tools';

function normalizePermission(granted: boolean, canAskAgain?: boolean): PermissionState {
  if (granted) return 'granted';
  return canAskAgain === false ? 'denied' : 'denied';
}

export const rnPort: DevicePort = {
  async notify(title, body) {
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: null, // 즉시
    });
  },
  async clipboardRead() {
    return Clipboard.getStringAsync();
  },
  async clipboardWrite(text) {
    await Clipboard.setStringAsync(text);
  },
  async deviceInfo() {
    return {
      model: Device.modelName ?? '',
      platform: Platform.OS,
      osVersion: String(Device.osVersion ?? ''),
      manufacturer: Device.manufacturer ?? '',
    };
  },
  async batteryInfo() {
    const level = await Battery.getBatteryLevelAsync().catch(() => undefined);
    const state = await Battery.getBatteryStateAsync().catch(() => undefined);
    return {
      level: typeof level === 'number' && level >= 0 ? level : undefined,
      isCharging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
    };
  },
  async networkStatus() {
    const s = await Network.getNetworkStateAsync();
    return {
      connected: s.isConnected === true,
      connectionType: String(s.type ?? 'unknown').toLowerCase(),
    };
  },
  async share(title, text, url) {
    // RN 내장 Share 시트 — 텍스트/링크 공유의 표준 경로 (파일이면 expo-sharing).
    await RnShare.share({ title: title || undefined, message: url ? `${text}\n${url}` : text });
  },
  async openUrl(url) {
    await Linking.openURL(url);
  },
  async vibrate() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  },
  async capturePhoto() {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (result.canceled || !result.assets?.[0]?.uri) throw new Error('촬영이 취소되었습니다.');
    return result.assets[0].uri;
  },
  async openFileWith(localUri) {
    // 시스템의 열기·공유 시트 — 사용자가 열 앱을 고른다.
    if (!(await Sharing.isAvailableAsync())) throw new Error('이 기기에서는 파일을 다른 앱으로 열 수 없습니다.');
    await Sharing.shareAsync(localUri);
  },
  async location() {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? undefined,
    };
  },
  async requestPermission(kind) {
    // [도구 켜기]의 실체 — OS 승인 다이얼로그. granted/denied 로 정규화.
    try {
      if (kind === 'notifications') {
        const r = await Notifications.requestPermissionsAsync();
        return normalizePermission(r.granted, r.canAskAgain);
      }
      if (kind === 'camera') {
        const r = await ImagePicker.requestCameraPermissionsAsync();
        return normalizePermission(r.granted, r.canAskAgain);
      }
      const r = await Location.requestForegroundPermissionsAsync();
      return normalizePermission(r.granted, r.canAskAgain);
    } catch {
      return 'prompt';
    }
  },
};
