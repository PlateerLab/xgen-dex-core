/**
 * xgen-dex-ide — 채팅 안의 IDE 보기.
 *
 * 쓰는 법(호스트):
 *
 * ```tsx
 * import { IdeStore, IdeView } from 'xgen-dex-ide';
 * import 'xgen-dex-ide/ide.css';
 *
 * const store = new IdeStore(host);          // 에이전트마다 하나 — 탭이 닫힐 때 store.dispose()
 * <IdeView store={store} chat={<Chat />} theme="dark" />
 * ```
 *
 * `host` 는 {@link IdeHost} 를 구현한다: 스토리지 목록·샌드박스 파일·터미널 소켓·git·Monaco.
 */
export { IdeView, type IdeViewProps } from './components/IdeView';
export { FileTree, type FileTreeProps } from './components/FileTree';
export type { SideView } from './components/ActivityBar';
export {
  ideActivityItems,
  pressIdeActivity,
  BASE_VIEW_META,
  type IdeActivityItem,
  type IdeActivityOptions,
  type IdeViewMeta,
} from './activity';
export { useIdeActivity } from './components/hooks';
export { Icon, type IconName } from './components/icons';
export { IdeStore, DEFAULT_LAYOUT, type IdeState, type Layout, type IdeCommand, type EditorTab, type EditorGroup, type DocState, type FoldersState } from './store';
export { folderPath, parseFolderPath, isFolderPath } from './folders';
export { IdeError } from './types';
export type {
  IdeHost,
  IdeFileEntry,
  IdeSessionInfo,
  IdeReadResult,
  IdeSaveResult,
  IdeStat,
  IdeFsOp,
  IdeSearchQuery,
  IdeSearchMatch,
  IdeSearchResult,
  IdeReplaceResult,
  IdeTerminalInfo,
  IdeFolderRoot,
  IdeFoldersState,
  IdeFolderSource,
  TerminalServerFrame,
  TerminalClientFrame,
  TerminalConnection,
  TerminalHandlers,
  MonacoApi,
  ThemeKind,
  IdePreview,
  IdePreviewMode,
  IdePreviewRequest,
} from './types';
export type { GitStatus, GitChange, GitRemote, GitAccount, GitBranches } from './git-model';
