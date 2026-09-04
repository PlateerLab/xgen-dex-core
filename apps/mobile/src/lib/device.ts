/**
 * 이 설치의 안정적 기기 식별 — 커넥터 멀티 디바이스 슬롯 키.
 *
 * 같은 계정의 데스크톱/CLI/VSCode 커넥터와 공존하기 위해 hello 와 채팅
 * 실행(client_device_id)에 같은 id 를 싣는다. 최초 기동 시 생성해 영속.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const KEY = 'device-id';
let cached = '';

function randomId(): string {
  const hex = '0123456789abcdef';
  let out = 'mob-';
  for (let i = 0; i < 24; i++) out += hex[Math.floor(Math.random() * 16)];
  return out;
}

export async function ensureDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = await AsyncStorage.getItem(KEY);
    if (existing) {
      cached = existing;
      return cached;
    }
  } catch {
    /* 스토리지 실패 — 세션 한정 id 로 진행 */
  }
  cached = randomId();
  try {
    await AsyncStorage.setItem(KEY, cached);
  } catch {
    /* 영속 실패해도 이 세션은 일관 */
  }
  return cached;
}

/** 이미 확보된 id 의 동기 조회 — ensureDeviceId 이후에만 값이 있다. */
export function cachedDeviceId(): string {
  return cached;
}

export function deviceName(): string {
  return `${Device.modelName || Platform.OS} · 모바일`;
}

export function devicePlatform(): string {
  return Platform.OS;
}
