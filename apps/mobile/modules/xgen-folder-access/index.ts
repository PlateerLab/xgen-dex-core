/**
 * 대화에 연결하는 휴대폰 폴더 — 네이티브 모듈 XgenFolderAccess 의 JS 입구.
 *
 * - Android: 시스템 폴더 선택기(ACTION_OPEN_DOCUMENT_TREE)로 고르고, 받은 권한을
 *   영구 보관한다. 파일 작업도 이 모듈이 한다(문서 제공자 트리 안에서 이름으로 찾는다).
 * - iOS: 시스템 폴더 선택기로 고르고 북마크로 보관한다. 북마크를 풀면 이 프로세스가
 *   그 폴더에 접근할 수 있게 되고, 파일 작업은 expo-file-system 이 file:// 로 한다.
 *
 * 네이티브가 없는 곳(웹·테스트)에서는 null — 부르는 쪽이 "지원하지 않음"으로 처리한다.
 */
import { requireOptionalNativeModule } from 'expo';

export interface PickedFolder {
  /** Android: 트리 URI(content://…), iOS: 폴더의 file:// URL. */
  uri: string;
  name: string;
  /** iOS 만 — base64 북마크. 다음 실행에서 접근을 되살리는 열쇠다. */
  bookmark?: string;
}

export interface NativeEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface FolderAccessNative {
  pickFolders(): Promise<PickedFolder[]>;
  // iOS
  resolveBookmark?(bookmark: string): Promise<{ uri: string; name: string; bookmark: string; stale: boolean }>;
  release(uri: string): Promise<void> | void;
  // Android
  hasAccess?(treeUri: string): Promise<boolean>;
  list?(treeUri: string, relPath: string): Promise<NativeEntry[]>;
  stat?(treeUri: string, relPath: string): Promise<{ exists: boolean; isDir: boolean; size: number }>;
  readText?(
    treeUri: string,
    relPath: string,
    maxBytes: number,
  ): Promise<{ text: string; size: number; truncated: boolean }>;
  writeText?(treeUri: string, relPath: string, content: string, append: boolean): Promise<void>;
  importFile?(treeUri: string, relPath: string, sourceUri: string): Promise<void>;
  remove?(treeUri: string, relPath: string): Promise<void>;
  exportFile?(treeUri: string, relPath: string): Promise<string>;
}

export const FolderAccess = requireOptionalNativeModule<FolderAccessNative>('XgenFolderAccess');
