/**
 * RN 의 파일 참조(`file://…`)를 조각 업로드의 소스로 — 큰 파일(최대 1GiB, 동영상)도 한 번에 읽지 않는다.
 *
 * RN 의 FormData `{ uri }` 는 파일을 디스크에서 흘려보내지만 **요청 한 번**이다. 큰 파일은 중간의
 * 프록시 본문 상한에 걸리고, 끊기면 처음부터 다시 보내야 한다. 그래서 조각(기본 8MiB)마다 그 범위만
 * base64 로 읽어(expo-file-system 의 position·length) 바이트로 푼다. 크기를 모르는 참조(일부
 * content://)면 null — 그때는 예전처럼 요청 한 번으로 보낸다.
 */
import * as FileSystem from 'expo-file-system';
import type { ResumableSource } from '@dex/protocol';
import { base64Bytes } from './attachment-file';

export async function uriSource(
  ref: { uri: string },
  filename: string,
  type: string,
): Promise<ResumableSource | null> {
  let info: FileSystem.FileInfo;
  try {
    info = await FileSystem.getInfoAsync(ref.uri);
  } catch {
    return null;
  }
  if (!info.exists || typeof info.size !== 'number' || info.isDirectory) return null;
  const size = info.size;
  return {
    name: filename,
    size,
    type: type || 'application/octet-stream',
    // 초 단위(소수) → ms. 이어 올리기 열쇠의 일부다.
    lastModified: typeof info.modificationTime === 'number' ? Math.floor(info.modificationTime * 1000) : undefined,
    async read(offset, length) {
      const want = Math.max(0, Math.min(length, size - offset));
      if (want === 0) return new Uint8Array(0);
      const b64 = await FileSystem.readAsStringAsync(ref.uri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length: want,
      });
      return base64Bytes(b64);
    },
  };
}
