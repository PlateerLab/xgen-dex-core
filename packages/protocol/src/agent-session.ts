/** Canonical Agent Session reads. Never use the legacy Bearer HttpClient here. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;

export interface AgentFocus {
  active_agent_session_id: string | null;
  version: number;
  event_id: string | null;
}

export interface AccountFocusEvent {
  event_id: string;
  sequence: number;
  event_type: 'agent_session.focus_changed';
  previous_agent_session_id: string | null;
  active_agent_session_id: string | null;
  origin_id: string | null;
  created_at: string;
}

export interface AccountEventPage {
  events: AccountFocusEvent[];
  next_cursor: number;
  snapshot_version: number;
  has_more: boolean;
}

export interface OwnedAgentSession {
  id: string;
  workflow_id: string;
  title: string;
  status: 'active' | 'archived';
  current_sequence: number;
  state_version: number;
}

export interface AgentSessionEvent {
  event_id: string;
  sequence: number;
  event_type: string;
  created_at: string;
}

export interface AgentSessionEventPage {
  events: AgentSessionEvent[];
  next_cursor: number;
  snapshot_sequence: number;
  state_version: number;
  has_more: boolean;
}

export interface AgentSessionSnapshot {
  id: string;
  workflow_id: string;
  title: string;
  current_sequence: number;
  state_version: number;
  message_history_complete: boolean;
}

export interface AgentEventCursor {
  sequence: number;
  eventId: string | null;
  stateVersion: number;
}

export class AgentSessionProtocolError extends Error {}

export class AgentSessionHttpError extends Error {
  constructor(readonly status: number) {
    super(`Canonical Agent Session request failed: ${status}`);
  }
}

export class PlatformCredentialUnavailable extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionProtocolError('Expected an object');
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || uuid(value);
}

function sequence(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

export function parseAgentFocus(value: unknown): AgentFocus {
  const raw = object(value);
  if (!nullableUuid(raw.active_agent_session_id)
    || !sequence(raw.version)
    || !nullableUuid(raw.event_id)) {
    throw new AgentSessionProtocolError('Invalid account Agent Session focus');
  }
  return {
    active_agent_session_id: raw.active_agent_session_id as string | null,
    version: raw.version as number,
    event_id: raw.event_id as string | null,
  };
}

export function parseAccountEventPage(value: unknown): AccountEventPage {
  const raw = object(value);
  if (!Array.isArray(raw.events) || raw.events.length > 200
    || !sequence(raw.next_cursor) || !sequence(raw.snapshot_version)
    || typeof raw.has_more !== 'boolean') {
    throw new AgentSessionProtocolError('Invalid account Agent Session event page');
  }
  const events = raw.events.map((value: unknown): AccountFocusEvent => {
    const event = object(value);
    if (!uuid(event.event_id) || !sequence(event.sequence, 1)
      || event.event_type !== 'agent_session.focus_changed'
      || !nullableUuid(event.previous_agent_session_id)
      || !nullableUuid(event.active_agent_session_id)
      || (event.origin_id !== null && typeof event.origin_id !== 'string')
      || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) {
      throw new AgentSessionProtocolError('Invalid account Agent Session event');
    }
    return {
      event_id: event.event_id, sequence: event.sequence,
      event_type: 'agent_session.focus_changed',
      previous_agent_session_id: event.previous_agent_session_id,
      active_agent_session_id: event.active_agent_session_id,
      origin_id: event.origin_id, created_at: event.created_at,
    };
  });
  return {
    events, next_cursor: raw.next_cursor, snapshot_version: raw.snapshot_version,
    has_more: raw.has_more,
  };
}

/** Reject a gap or a different prior pointer; the caller must refetch focus on failure. */
export function applyAccountEventPage(
  current: AgentFocus, value: unknown, afterSequence: number,
): AgentFocus {
  const page = parseAccountEventPage(value);
  if (!nullableUuid(current.active_agent_session_id) || !nullableUuid(current.event_id)
    || !sequence(current.version) || !sequence(afterSequence)
    || afterSequence > current.version) {
    throw new AgentSessionProtocolError('Invalid account Agent Session replay cursor');
  }
  let expected = afterSequence;
  for (const event of page.events) {
    if (event.sequence !== ++expected) throw new AgentSessionProtocolError('Account Agent Session event gap');
  }
  if (page.next_cursor !== expected || page.snapshot_version < expected
    || page.has_more !== (page.next_cursor < page.snapshot_version)
    || (page.has_more && page.events.length === 0)) {
    throw new AgentSessionProtocolError('Inconsistent account Agent Session event cursor');
  }
  let focus = current;
  for (const event of page.events) {
    if (event.sequence < focus.version) continue;
    if (event.sequence === focus.version) {
      if ((focus.event_id !== null && focus.event_id !== event.event_id)
        || focus.active_agent_session_id !== event.active_agent_session_id) {
        throw new AgentSessionProtocolError('Conflicting account Agent Session event');
      }
      continue;
    }
    if (event.sequence !== focus.version + 1
      || event.previous_agent_session_id !== focus.active_agent_session_id) {
      throw new AgentSessionProtocolError('Account Agent Session focus diverged');
    }
    focus = {
      active_agent_session_id: event.active_agent_session_id,
      version: event.sequence,
      event_id: event.event_id,
    };
  }
  return focus;
}

export function parseAgentSessionList(value: unknown): {
  items: OwnedAgentSession[]; next_cursor: string | null; has_more: boolean;
} {
  const raw = object(value);
  if (!Array.isArray(raw.items) || raw.items.length > 100 || typeof raw.has_more !== 'boolean'
    || (raw.next_cursor !== null && !uuid(raw.next_cursor))
    || raw.has_more !== (raw.next_cursor !== null)) {
    throw new AgentSessionProtocolError('Invalid Agent Session list');
  }
  const seen = new Set<string>();
  const items = raw.items.map((value: unknown): OwnedAgentSession => {
    const item = object(value);
    if (!uuid(item.id) || seen.has(item.id) || typeof item.workflow_id !== 'string'
      || !item.workflow_id || typeof item.title !== 'string'
      || (item.status !== 'active' && item.status !== 'archived')
      || !sequence(item.current_sequence) || !sequence(item.state_version, 1)) {
      throw new AgentSessionProtocolError('Invalid Agent Session list item');
    }
    seen.add(item.id);
    return {
      id: item.id, workflow_id: item.workflow_id, title: item.title,
      status: item.status, current_sequence: item.current_sequence,
      state_version: item.state_version,
    };
  });
  return { items, next_cursor: raw.next_cursor as string | null, has_more: raw.has_more };
}

export function parseAgentSessionSnapshot(value: unknown): AgentSessionSnapshot {
  const raw = object(value);
  if (!uuid(raw.id) || typeof raw.workflow_id !== 'string' || !raw.workflow_id
    || typeof raw.title !== 'string' || !sequence(raw.current_sequence)
    || !sequence(raw.state_version, 1) || typeof raw.message_history_complete !== 'boolean') {
    throw new AgentSessionProtocolError('Invalid Agent Session snapshot');
  }
  return {
    id: raw.id, workflow_id: raw.workflow_id, title: raw.title,
    current_sequence: raw.current_sequence, state_version: raw.state_version,
    message_history_complete: raw.message_history_complete,
  };
}

/** Accepts both the HTTP page and Workflow's `agent_session.events` WS frame. */
export function parseAgentSessionEventPage(value: unknown): AgentSessionEventPage {
  const raw = object(value);
  if (('type' in raw && raw.type !== 'agent_session.events')
    || !Array.isArray(raw.events) || raw.events.length > 200
    || !sequence(raw.next_cursor) || !sequence(raw.snapshot_sequence)
    || !sequence(raw.state_version, 1) || typeof raw.has_more !== 'boolean') {
    throw new AgentSessionProtocolError('Invalid Agent Session event page');
  }
  const events = raw.events.map((value: unknown): AgentSessionEvent => {
    const event = object(value);
    if (!uuid(event.event_id) || !sequence(event.sequence, 1)
      || typeof event.event_type !== 'string' || !event.event_type
      || typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) {
      throw new AgentSessionProtocolError('Invalid Agent Session event');
    }
    return {
      event_id: event.event_id, sequence: event.sequence,
      event_type: event.event_type, created_at: event.created_at,
    };
  });
  return {
    events, next_cursor: raw.next_cursor, snapshot_sequence: raw.snapshot_sequence,
    state_version: raw.state_version, has_more: raw.has_more,
  };
}

/** Return only new events. A gap must trigger snapshot reconciliation. */
export function applyAgentSessionEventPage(
  current: AgentEventCursor, value: unknown, afterSequence: number,
): { cursor: AgentEventCursor; events: AgentSessionEvent[] } {
  const page = parseAgentSessionEventPage(value);
  if (!sequence(current.sequence) || !sequence(current.stateVersion, 1)
    || (current.eventId !== null && !uuid(current.eventId))
    || !sequence(afterSequence) || afterSequence > current.sequence) {
    throw new AgentSessionProtocolError('Invalid Agent Session replay cursor');
  }
  let expected = afterSequence;
  for (const event of page.events) {
    if (event.sequence !== ++expected) throw new AgentSessionProtocolError('Agent Session event gap');
  }
  if (page.next_cursor !== expected || page.snapshot_sequence < expected
    || page.has_more !== (page.next_cursor < page.snapshot_sequence)) {
    throw new AgentSessionProtocolError('Inconsistent Agent Session event cursor');
  }
  let cursor = current;
  const events: AgentSessionEvent[] = [];
  for (const event of page.events) {
    if (event.sequence < cursor.sequence) continue;
    if (event.sequence === cursor.sequence) {
      if (cursor.eventId && cursor.eventId !== event.event_id) {
        throw new AgentSessionProtocolError('Conflicting Agent Session event');
      }
      continue;
    }
    if (event.sequence !== cursor.sequence + 1 || page.state_version < cursor.stateVersion) {
      throw new AgentSessionProtocolError('Agent Session event state diverged');
    }
    cursor = { sequence: event.sequence, eventId: event.event_id, stateVersion: page.state_version };
    events.push(event);
  }
  return {
    cursor: { ...cursor, stateVersion: Math.max(cursor.stateVersion, page.state_version) },
    events,
  };
}

/** Active Platform Session credentials only. The signer gets the path without query. */
export interface AgentSessionProofSource {
  accessToken(): Promise<string | null>;
  signProof(method: 'GET', htu: string, accessToken: string): Promise<string>;
}

export class AgentSessionReadClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, private readonly proof: AgentSessionProofSource, fetchImpl?: typeof fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password) {
      throw new TypeError('Platform Session API requires an HTTPS origin');
    }
    this.origin = url.origin;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) throw new TypeError('Fetch is required');
  }

  private async read(path: string, query?: URLSearchParams, signal?: AbortSignal): Promise<unknown> {
    const token = await this.proof.accessToken();
    if (!token || !TOKEN.test(token)) throw new PlatformCredentialUnavailable('Active Platform Session required');
    const htu = `${this.origin}${path}`;
    const dpop = await this.proof.signProof('GET', htu, token);
    if (!TOKEN.test(dpop)) throw new PlatformCredentialUnavailable('Valid device proof required');
    const url = new URL(htu);
    if (query) url.search = query.toString();
    const response = await this.fetchImpl(url.toString(), {
      method: 'GET', headers: { Authorization: `DPoP ${token}`, DPoP: dpop, Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
    });
    if (!response.ok) throw new AgentSessionHttpError(response.status);
    return response.json() as Promise<unknown>;
  }

  async focus(signal?: AbortSignal): Promise<AgentFocus> {
    return parseAgentFocus(await this.read('/api/agentflow/me/agent-state', undefined, signal));
  }

  async accountEvents(afterSequence: number, limit = 100, signal?: AbortSignal): Promise<AccountEventPage> {
    if (!sequence(afterSequence) || !sequence(limit, 1) || limit > 200) {
      throw new TypeError('Invalid account Agent Session event cursor');
    }
    const query = new URLSearchParams({ after_sequence: String(afterSequence), limit: String(limit) });
    return parseAccountEventPage(await this.read('/api/agentflow/me/agent-events', query, signal));
  }

  async sessions(limit = 50, beforeId?: string, signal?: AbortSignal): Promise<ReturnType<typeof parseAgentSessionList>> {
    if (!sequence(limit, 1) || limit > 100 || (beforeId !== undefined && !uuid(beforeId))) {
      throw new TypeError('Invalid Agent Session list cursor');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeId) query.set('before_id', beforeId);
    return parseAgentSessionList(await this.read('/api/agentflow/me/agent-sessions', query, signal));
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<AgentSessionSnapshot> {
    if (!uuid(sessionId)) throw new TypeError('Invalid Agent Session ID');
    return parseAgentSessionSnapshot(await this.read(`/api/agentflow/agent-sessions/${sessionId}/snapshot`, undefined, signal));
  }

  async events(sessionId: string, afterSequence: number, limit = 100, signal?: AbortSignal): Promise<AgentSessionEventPage> {
    if (!uuid(sessionId) || !sequence(afterSequence) || !sequence(limit, 1) || limit > 200) {
      throw new TypeError('Invalid Agent Session event cursor');
    }
    const query = new URLSearchParams({ after_sequence: String(afterSequence), limit: String(limit) });
    return parseAgentSessionEventPage(await this.read(`/api/agentflow/agent-sessions/${sessionId}/events`, query, signal));
  }
}
