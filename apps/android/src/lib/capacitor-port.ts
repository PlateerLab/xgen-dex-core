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
import { Geolocation } from '@capacitor/geolocation';
import type { DevicePort } from './mobile-tools';

const ROOT = 'XGenDex';
const abs = (rel: string): string => (rel ? `${ROOT}/${rel}` : ROOT);

/**
 * 파일 루트 디렉터리 — 공용 Documents 우선, 실패 시 앱 스코프(External:
 * Android/data/<pkg>/files) 폴백.
 *
 * Android 13+ 스코프드 스토리지에서 공용 Documents 쓰기는 기기/OEM 에 따라
 * 거부될 수 있다 — 그때 도구 전체가 죽는 대신 앱 스코프 폴더로 계속
 * 동작한다 (파일 앱에서 Android/data 경로로 접근 가능).
 */
let fsDirectory: Directory = Directory.Documents;

/** 파일/알림 권한 + 루트 폴더를 미리 확보한다 — 도구 호출 중 실패하지 않게. */
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
    fsDirectory = Directory.Documents;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/exist/i.test(msg)) {
      fsDirectory = Directory.Documents; // 이미 있음 — 정상
      return;
    }
    try {
      await Filesystem.mkdir({ path: ROOT, directory: Directory.External, recursive: true });
      fsDirectory = Directory.External;
    } catch (e2) {
      const m2 = e2 instanceof Error ? e2.message : String(e2);
      if (/exist/i.test(m2)) fsDirectory = Directory.External;
      /* 그 외 실패 — 파일 도구가 호출 시점 오류를 돌려준다 */
    }
  }
}

export const capacitorPort: DevicePort = {
  async readFile(path) {
    const r = await Filesystem.readFile({
      path: abs(path),
      directory: fsDirectory,
      encoding: Encoding.UTF8,
    });
    return typeof r.data === 'string' ? r.data : '';
  },
  async writeFile(path, content, append) {
    const opts = {
      path: abs(path),
      data: content,
      directory: fsDirectory,
      encoding: Encoding.UTF8,
      recursive: true,
    };
    if (append) await Filesystem.appendFile(opts);
    else await Filesystem.writeFile(opts);
  },
  async listDir(path) {
    const r = await Filesystem.readdir({ path: abs(path), directory: fsDirectory });
    return r.files.map((f) => ({
      name: f.name,
      isDir: f.type === 'directory',
      size: f.size ?? 0,
    }));
  },
  async deleteFile(path) {
    await Filesystem.deleteFile({ path: abs(path), directory: fsDirectory });
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
  async location() {
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15_000 });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
  },
  async requestPermission(kind) {
    // [도구 켜기]의 실체 — 여기서 OS 승인 다이얼로그가 뜬다. 결과를
    // granted/denied/prompt 로 정규화해 설정 UI 가 상태를 보여준다.
    try {
      if (kind === 'files') {
        const r = await Filesystem.requestPermissions();
        return (r.publicStorage as string) === 'granted' ? 'granted'
          : (r.publicStorage as string) === 'denied' ? 'denied' : 'granted';
        // API 33+ 는 publicStorage 개념이 없어 'prompt' 류가 와도 실사용 가능 — granted 취급.
      }
      if (kind === 'notifications') {
        const r = await LocalNotifications.requestPermissions();
        return r.display === 'granted' ? 'granted' : r.display === 'denied' ? 'denied' : 'prompt';
      }
      if (kind === 'camera') {
        const r = await Camera.requestPermissions({ permissions: ['camera'] });
        return r.camera === 'granted' ? 'granted' : r.camera === 'denied' ? 'denied' : 'prompt';
      }
      const r = await Geolocation.requestPermissions();
      return r.location === 'granted' ? 'granted'
        : r.location === 'denied' ? 'denied' : 'prompt';
    } catch {
      // 일부 기기/버전에서 요청 API 자체가 없으면 실제 사용 시점 프롬프트에 맡긴다.
      return 'prompt';
    }
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
      directory: fsDirectory,
      recursive: true,
    });
    return rel;
  },
};
