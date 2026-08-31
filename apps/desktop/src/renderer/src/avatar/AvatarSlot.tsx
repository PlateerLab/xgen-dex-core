/**
 * AvatarSlot — the future avatar extension point.
 *
 * The connector deliberately ships NO avatar today (per product direction), but
 * leaves this seam so an avatar renderer can be dropped in later without
 * touching the chat flow. Register a renderer via `setAvatarRenderer(...)` and
 * it will be mounted here, receiving the live chat state (streaming text, tool
 * activity, speaking flag). Until then this renders nothing.
 *
 * This mirrors geny-connector's split: the chat/transport stays here; the
 * avatar is a pluggable overlay bound to the active agent + its streamed text.
 */
import React from 'react';

export interface AvatarState {
  /** The agent currently being chatted with. */
  workflowId: string;
  workflowName: string;
  /** Assistant text streamed so far this turn. */
  streamingText: string;
  /** True while a turn is actively streaming (drives mouth/animation). */
  speaking: boolean;
}

export type AvatarRenderer = React.ComponentType<{ state: AvatarState }>;

let registered: AvatarRenderer | null = null;

/** Plug in an avatar renderer (call once at startup from an extension). */
export function setAvatarRenderer(renderer: AvatarRenderer | null): void {
  registered = renderer;
}

export function hasAvatarRenderer(): boolean {
  return registered !== null;
}

export const AvatarSlot: React.FC<{ state: AvatarState }> = ({ state }) => {
  if (!registered) return null;
  const Renderer = registered;
  return (
    <div className="avatar-slot">
      <Renderer state={state} />
    </div>
  );
};
