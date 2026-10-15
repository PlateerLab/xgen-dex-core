import { AgentSessionProtocolError, parseAgentSessionList, type OwnedAgentSession } from './agent-session';

/** UUID is an opaque keyset cursor: the server orders by created_at, then id. */
export function validateAgentSessionCatalogCursor(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new AgentSessionProtocolError('Invalid Agent Session catalog cursor');
  }
  return value;
}

/** Validate one bounded page without accumulating private catalogs or auto-following cursors. */
export function parseAgentSessionCatalogPage(value: unknown, beforeId?: string, previousItems: readonly OwnedAgentSession[] = []) {
  if (beforeId !== undefined) validateAgentSessionCatalogCursor(beforeId);
  const page = parseAgentSessionList(value);
  if (page.has_more && (!page.items.length || page.next_cursor !== page.items.at(-1)!.id)) {
    throw new AgentSessionProtocolError('Invalid Agent Session catalog continuation');
  }
  if (beforeId !== undefined) {
    const previous = new Set(previousItems.map((item) => item.id));
    if (page.next_cursor === beforeId || page.items.some((item) => item.id === beforeId || previous.has(item.id))) {
      throw new AgentSessionProtocolError('Agent Session catalog page did not advance');
    }
  }
  return page;
}
