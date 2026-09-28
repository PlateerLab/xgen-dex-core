/**
 * CLI 대화에 연결할 폴더.
 *
 * 앱은 채팅 헤더의 [폴더 연결]로 고르지만, 터미널에서는 **대화를 시작한 폴더**가
 * 그 자리다 — 저장소에 들어가 `dex chat` 을 치는 것이 곧 "여기서 작업하자"다.
 * 다만 홈이나 드라이브 루트에서 시작했다면 붙이지 않는다: 그건 작업할 곳을 고른
 * 게 아니라 터미널을 막 연 것이고, 홈 전체를 여는 것은 사용자가 고른 일이 아니다.
 */
import { homedir } from 'node:os';
import { parse, resolve } from 'node:path';

export function defaultWorkingFolders(cwd = process.cwd(), home = homedir()): string[] {
  const dir = resolve(cwd);
  if (dir === resolve(home) || dir === parse(dir).root) return [];
  return [dir];
}

/**
 * `--no-folder` 면 없음, `--folder a,b` 면 그 폴더들(현재 폴더 기준), 둘 다 없으면
 * 시작한 폴더.
 */
export function chatFolders(options: { noFolder?: boolean; folders?: string[]; cwd?: string }): string[] {
  const cwd = options.cwd ?? process.cwd();
  if (options.noFolder) return [];
  if (options.folders?.length) return [...new Set(options.folders.map((folder) => resolve(cwd, folder)))];
  return defaultWorkingFolders(cwd);
}
