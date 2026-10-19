import type { DesktopNativeSessions } from './native-session';

type PresenceEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume'
  | 'user-did-resign-active' | 'user-did-become-active';
interface PresenceMonitor {
  on(event: PresenceEvent, listener: () => void): unknown;
  removeListener(event: PresenceEvent, listener: () => void): unknown;
  getSystemIdleState(seconds: number): string;
}

/** Bind after app.ready. Each OS cause is independent; resume is never an unlock or reconnect. */
export function bindNativeCapabilityPresence(monitor: PresenceMonitor, host: DesktopNativeSessions): () => void {
  let unlockProbe: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const cancelUnlock = () => { generation++; clearTimeout(unlockProbe); unlockProbe = undefined; };
  const idleState = () => {
    try { return monitor.getSystemIdleState(1); } catch { return 'unknown'; }
  };
  const observeLock = () => {
    // Unsupported/unknown idle state is not evidence that a known lock has ended.
    if (idleState() === 'locked') host.setCapabilityPresence('locked', true);
  };
  const settleUnlock = () => {
    cancelUnlock();
    const current = generation;
    const probe = (remaining: number) => {
      if (current !== generation) return;
      const state = idleState();
      if (state === 'active' || state === 'idle') {
        host.setCapabilityPresence('locked', false); unlockProbe = undefined; return;
      }
      // macOS can report the previous locked state inside unlock-screen. Keep closed
      // until a fresh OS observation confirms unlock; a later lock cancels this intent.
      if (remaining > 0) {
        unlockProbe = setTimeout(() => probe(remaining - 1), 250);
        unlockProbe.unref();
      } else unlockProbe = undefined;
    };
    probe(48); // Bounded 12-second observation, never a connection or effect retry.
  };
  const listeners: Record<PresenceEvent, () => void> = {
    'lock-screen': () => { cancelUnlock(); host.setCapabilityPresence('locked', true); },
    'unlock-screen': settleUnlock,
    suspend: () => host.setCapabilityPresence('suspended', true),
    resume: () => { observeLock(); host.setCapabilityPresence('suspended', false); },
    'user-did-resign-active': () => host.setCapabilityPresence('inactive', true),
    'user-did-become-active': () => { observeLock(); host.setCapabilityPresence('inactive', false); },
  };
  for (const event of Object.keys(listeners) as PresenceEvent[]) monitor.on(event, listeners[event]);
  observeLock();
  return () => { cancelUnlock(); for (const event of Object.keys(listeners) as PresenceEvent[]) monitor.removeListener(event, listeners[event]); };
}
