import type { AgentFocus, OwnedAgentSession } from '@dex/protocol/agent-session';
import type { AgentSessionCatalogPage } from '@dex/protocol/agent-session-catalog';
import type { AgentTurnComposeRequest, AgentTurnComposerView } from '@dex/protocol/agent-turn-composer';
import type { CreateAgentSessionInput, CreatedAgentSession, SwitchAgentFocusInput } from '@dex/protocol/agent-session-lifecycle';
import type { CanonicalTuiSource, CanonicalTuiView } from './canonical-types';

/** Native host scope binding is private to the model; never copied into the Ink view. */
export interface CanonicalTuiChatSource extends CanonicalTuiSource {
  binding(): string | null;
  catalog(signal: AbortSignal, beforeId?: string): Promise<{
    binding: string; focus: AgentFocus; sessions: AgentSessionCatalogPage;
  }>;
  create(binding: string, input: CreateAgentSessionInput, signal: AbortSignal): Promise<CreatedAgentSession>;
  select(binding: string, input: SwitchAgentFocusInput, signal: AbortSignal): Promise<AgentFocus>;
  send(binding: string, request: AgentTurnComposeRequest, signal: AbortSignal): Promise<unknown>;
}

export interface CanonicalTuiChatView extends CanonicalTuiView {
  draft: string;
  writing: boolean;
  canEdit: boolean;
  turn: AgentTurnComposerView;
  catalog: {
    focus: AgentFocus | null;
    items: OwnedAgentSession[];
    nextCursor: string | null;
    hasMore: boolean;
    olderPage: boolean;
    busy: boolean;
    writeBlocked: boolean;
    canWrite: boolean;
    canLoadOlder: boolean;
    notice: string;
  };
}
