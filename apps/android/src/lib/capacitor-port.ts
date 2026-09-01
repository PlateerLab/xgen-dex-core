/**
 * DevicePort 의 Capacitor 구현 — 모바일 도구가 실제 기기 기능에 닿는 유일한 곳.
 *
 * 파일 루트: 공용 Documents/XGenDex (Directory.Documents + 'XGenDex/' 접두) —
 * 사용자가 파일 앱에서 그대로 보이고, 에이전트의 파일 조작 반경이 이 폴더로
 * 제한된다 (경로 검증은 mobile-tools.safeRelPath 가 이미 했다).
 */

import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Clipboard } from '@capacitor/clipboard';
import { Device } from '@capacitor/device';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Network } from '@capacitor/network';
import { Share } from '@capacitor/share';
import { Browser } from '@capacitor/browser';
import type { DevicePort } from './mobile-tools';

const ROOT = 'XGenDex';
const abs = (rel: string): string => (rel ? `${ROOT}/${rel}` : ROOT);

/** 파일/알림 권한을 미리 확보한다 — 도구 호출 중 권한 팝업으로 실패하지 않게. */
export async function ensureDevicePermissions(): Promise<void> {
  try {
    await Filesystem.requestPermissions();
  } catch {
    /* API 33+ 는 공용 문서 접근에 권한이 필요 없다 */
  }
  try {
    await LocalNotifications.requestPermissions();
  } catch {
    /* 사용자가 거부하면 Notify 도구가 그때 오류를 돌려준다 */
  }
  try {
    await Filesystem.mkdir({ path: ROOT, directory: Directory.Documents, recursive: true });
  } catch {
    /* 이미 있음 */
  }
}

export const capacitorPort: DevicePort = {
  async readFile(path) {
    const r = await Filesystem.readFile({
      path: abs(path),
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    return typeof r.data === 'string' ? r.data : '';
  },
  async writeFile(path, content, append) {
    const opts = {
      path: abs(path),
      data: content,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    };
    if (append) await Filesystem.appendFile(opts);
    else await Filesystem.writeFile(opts);
  },
  async listDir(path) {
    const r = await Filesystem.readdir({ path: abs(path), directory: Directory.Documents });
    return r.files.map((f) => ({
      name: f.name,
      isDir: f.type === 'directory',
      size: f.size ?? 0,
    }));
  },
  async deleteFile(path) {
    await Filesystem.deleteFile({ path: abs(path), directory: Directory.Documents });
  },
  async notify(title, body) {
    await LocalNotifications.schedule({
      notifications: [{ id: Math.floor(Date.now() % 2_000_000_000), title, body }],
    });
  },
  async clipboardRead() {
    const r = await Clipboard.read();
    return r.value ?? '';
  },
  async clipboardWrite(text) {
    await Clipboard.write({ string: text });
  },
  async deviceInfo() {
    const info = await Device.getInfo();
    return {
      model: info.model,
      platform: info.platform,
      osVersion: info.osVersion,
      manufacturer: info.manufacturer,
    };
  },
  async batteryInfo() {
    const b = await Device.getBatteryInfo();
    return { level: b.batteryLevel, isCharging: b.isCharging };
  },
  async networkStatus() {
    const n = await Network.getStatus();
    return { connected: n.connected, connectionType: n.connectionType };
  },
  async share(title, text, url) {
    await Share.share({ title: title || undefined, text, url });
  },
  async openUrl(url) {
    await Browser.open({ url });
  },
  async vibrate() {
    await Haptics.impact({ style: ImpactStyle.Medium });
  },
  async takePhoto(fileName) {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      quality: 85,
    });
    const rel = fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
      ? fileName
      : `${fileName}.jpg`;
    await Filesystem.writeFile({
      path: abs(rel),
      data: photo.base64String ?? '',
      directory: Directory.Documents,
      recursive: true,
    });
    return rel;
  },
};
