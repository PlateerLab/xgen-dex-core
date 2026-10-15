/**
 * main 이 Dex 데스크톱 앱에서 가져다 쓰는 것 — **이 파일 한 곳으로만** 들어온다(화면 쪽 `src/renderer/src/dex.ts` 와
 * 같은 규칙, DESIGN.md §8). Dex 코드는 고치지 않고 그대로 쓴다. 여기 있는 것은 Electron 을 모르는 것뿐이다.
 *
 * - folder-fs: 폴더 안의 파일 읽기·쓰기·목록·옮기기 — 폴더 밖으로 나가지 않는지(심볼릭 링크를 따라가도) 확인하고,
 *   저장은 연 판(sha)을 조건으로 건다. Dex 는 대화에 연결한 폴더에, XD 는 에이전트의 작업 공간·연결 폴더에 쓴다.
 */
export {
  folderFsCall,
  listFolder,
  readFolderRaw,
  FolderFsError,
  FOLDER_READ_MAX,
  FOLDER_RAW_MAX,
  type FolderEntry,
  type FolderFsDeps,
} from '../../../desktop/src/main/folder-fs';
