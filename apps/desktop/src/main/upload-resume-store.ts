/**
 * 조각 업로드의 이어 올리기 기록 — 앱을 껐다 켜도 올리던 큰 파일을 처음부터 다시 보내지 않는다.
 *
 * 열쇠는 업로드 엔진이 정한다(서버 주소·파일 이름·크기·수정 시각·형식). 값은 게이트웨이의 업로드 id.
 * 게이트웨이는 하루 지난 조각을 지우므로 여기도 하루 지난 기록은 버린다(남아 있어도 엔진이 404 를 보고
 * 새로 시작한다 — 버리는 것은 파일이 자라지 않게 하려는 것뿐이다).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ResumeStore } from '@dex/protocol';

const TTL_MS = 24 * 60 * 60 * 1000;

export function fileResumeStore(path: string, now: () => number = Date.now): ResumeStore {
  let data: Record<string, { id: string; at: number }> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') data = parsed as typeof data;
  } catch {
    // 처음이거나 깨진 파일 — 빈 기록으로 시작한다.
  }
  const save = (): void => {
    const t = now();
    for (const [k, v] of Object.entries(data)) if (!v || t - v.at > TTL_MS) delete data[k];
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // 기록을 못 남겨도 업로드는 된다 — 다음 실행에서 이어 올리지 못할 뿐이다.
    }
  };
  return {
    get(key) {
      const e = data[key];
      if (!e) return null;
      if (now() - e.at > TTL_MS) {
        delete data[key];
        save();
        return null;
      }
      return e.id;
    },
    set(key, value) {
      data[key] = { id: value, at: now() };
      save();
    },
    delete(key) {
      if (!(key in data)) return;
      delete data[key];
      save();
    },
  };
}
