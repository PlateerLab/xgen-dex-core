/**
 * 이 PC 의 폴더 장부 ↔ 서버의 대화 폴더 사본.
 *
 * 규칙은 @dex/protocol 의 {@link ConversationFolderSync} 한 곳(모바일과 같다). 이 PC 는 폴더를
 * 절대 경로로 올린다 — 모델이 도구에 쓰는 경로다.
 */
import {
  ConversationFolderSync,
  type ConversationFolderSyncDeps,
  type FolderLedger,
} from '@dex/protocol/conversation-folder-sync';
import { localFoldersForRequest, type LocalFolder } from '@dex/engine/local-folders';

export type { FolderLedger };

export class ChatFolderSync extends ConversationFolderSync<LocalFolder> {
  constructor(deps: Omit<ConversationFolderSyncDeps<LocalFolder>, 'wire'>) {
    super({ ...deps, wire: localFoldersForRequest });
  }
}
