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
  const observeLock = () => {
    // Unsupported/unknown idle state is not evidence that a known lock has ended.
    try { if (monitor.getSystemIdleState(1) === 'locked') host.setCapabilityPresence('locked', true); }
    catch { /* Keep the last observed OS state; no authority is opened by a failed probe. */ }
  };
  const listeners: Record<PresenceEvent, () => void> = {
    'lock-screen': () => host.setCapabilityPresence('locked', true),
    'unlock-screen': () => { host.setCapabilityPresence('locked', false); observeLock(); },
    suspend: () => host.setCapabilityPresence('suspended', true),
    resume: () => { observeLock(); host.setCapabilityPresence('suspended', false); },
    'user-did-resign-active': () => host.setCapabilityPresence('inactive', true),
    'user-did-become-active': () => { observeLock(); host.setCapabilityPresence('inactive', false); },
  };
  for (const event of Object.keys(listeners) as PresenceEvent[]) monitor.on(event, listeners[event]);
  observeLock();
  return () => { for (const event of Object.keys(listeners) as PresenceEvent[]) monitor.removeListener(event, listeners[event]); };
}
