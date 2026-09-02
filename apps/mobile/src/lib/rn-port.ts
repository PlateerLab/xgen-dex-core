/**
 * DevicePort 의 React Native(Expo) 구현 — 모바일 도구가 기기 기능에 닿는 곳.
 *
 * 파일 루트: 앱 문서 디렉터리의 XGenDex/ — 권한 없이 전 OS 동작(앱 스코프).
 * 경로 검증은 mobile-tools.safeRelPath 가 이미 했다.
 */

import * as Battery from 'expo-battery';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { Platform, Share as RnShare } from 'react-native';
import type { DevicePort, PermissionState } from './mobile-tools';

const ROOT = `${FileSystem.documentDirectory ?? ''}XGenDex/`;
const abs = (rel: string): string => `${ROOT}${rel}`;

async function ensureDir(rel: string): Promise<void> {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const target = dir ? abs(dir) : ROOT;
  await FileSystem.makeDirectoryAsync(target, { intermediates: true }).catch(() => undefined);
}

export async function ensureToolRoot(): Promise<void> {
  await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true }).catch(() => undefined);
}

function normalizePermission(granted: boolean, canAskAgain?: boolean): PermissionState {
  if (granted) return 'granted';
  return canAskAgain === false ? 'denied' : 'denied';
}

export const rnPort: DevicePort = {
  async readFile(path) {
    const info = await FileSystem.getInfoAsync(abs(path));
    if (!info.exists) throw new Error(`파일 없음: ${path}`);
    return FileSystem.readAsStringAsync(abs(path));
  },
  async writeFile(path, content, append) {
    await ensureDir(path);
    if (append) {
      const info = await FileSystem.getInfoAsync(abs(path));
      const prev = info.exists ? await FileSystem.readAsStringAsync(abs(path)) : '';
      await FileSystem.writeAsStringAsync(abs(path), prev + content);
    } else {
      await FileSystem.writeAsStringAsync(abs(path), content);
    }
  },
  async listDir(path) {
    const dir = path ? abs(path) : ROOT;
    const names = await FileSystem.readDirectoryAsync(dir);
    const out: Array<{ name: string; isDir: boolean; size: number }> = [];
    for (const name of names) {
      const info = await FileSystem.getInfoAsync(`${dir.replace(/\/$/, '')}/${name}`);
      out.push({
        name,
        isDir: info.exists && info.isDirectory === true,
        size: info.exists && 'size' in info ? Number(info.size ?? 0) : 0,
      });
    }
    return out;
  },
  async deleteFile(path) {
    const info = await FileSystem.getInfoAsync(abs(path));
    if (!info.exists) throw new Error(`파일 없음: ${path}`);
    await FileSystem.deleteAsync(abs(path));
  },
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
  async takePhoto(fileName) {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (result.canceled || !result.assets?.[0]?.uri) throw new Error('촬영이 취소되었습니다.');
    const rel = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') ? fileName : `${fileName}.jpg`;
    await ensureDir(rel);
    await FileSystem.copyAsync({ from: result.assets[0].uri, to: abs(rel) });
    return rel;
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
      if (kind === 'files') {
        // 앱 문서 디렉터리는 권한이 필요 없다 — 루트만 확보.
        await ensureToolRoot();
        return 'granted';
      }
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

/** expo-sharing 은 파일 공유용으로 남겨둔다 — 현재 Share 도구는 텍스트 전용. */
export { Sharing as _sharing };
