import type { BrowserConfirmRequest } from './browser';
import type { UserConfirmRequest } from './user-confirm';

export type VoiceConfirmIntent = 'approve' | 'conversation' | 'reject' | 'revise' | 'unclear';

export type VoiceConfirmTarget =
  | { kind: 'browser'; request: BrowserConfirmRequest }
  | { kind: 'user'; request: UserConfirmRequest };
