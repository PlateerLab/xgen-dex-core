import { sha256 } from 'js-sha256';
import { AgentSessionReadClient, PlatformCredentialUnavailable } from '@dex/protocol/agent-session';
import { reconcileAgentFocus, type ScopedAgentFocus } from '@dex/protocol/agent-session-focus-recovery';
import { NativeAccountChanged, NativePlatformTransportError } from '@dex/protocol/native-platform-session';
import type { MobileEnrollmentAccount } from './native-device-enrollment';
import type { MobileDeviceIdentity } from './native-device-key';
import type { createMobileSessionVault } from './native-session-vault';
import type { MobileAgentFetch } from './native-agent-http';

export class MobileFocusBusy extends Error { constructor() { super('Mobile focus read is still settling'); } }
/** A source owns one login lifetime. Its callback-scoped credentials cannot escape the vault lock. */
export function createMobileAgentFocusSource(options: {
  current(): MobileEnrollmentAccount | null;
  keys: { identity(create?: boolean, signal?: AbortSignal): Promise<MobileDeviceIdentity> };
  vault: ReturnType<typeof createMobileSessionVault>; fetch: typeof fetch & Partial<Pick<MobileAgentFetch, 'assertAvailable'>>;
}) {
  const initial = options.current(); if (!initial) throw new NativeAccountChanged();
  const authority = { origin: initial.origin, userId: initial.userId, authScope: initial.authScope };
  let closed = false; let active: AbortController | null = null;
  return {
    async reconcileFocus(previous: ScopedAgentFocus | null, signal?: AbortSignal) {
      if (active) throw new MobileFocusBusy();
      const controller = new AbortController(); active = controller;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const check = () => {
        controller.signal.throwIfAborted(); const actual = options.current();
        if (closed || !actual || actual.origin !== authority.origin || actual.userId !== authority.userId || actual.authScope !== authority.authScope) throw new NativeAccountChanged();
      };
      try {
        check(); options.fetch.assertAvailable?.();
        const identity = await options.keys.identity(false, controller.signal); check();
        return await options.vault.withIdentity(authority, identity, check, async (vault) => {
          let record = await vault.read(); check(); let live = true;
          const credential = () => {
            check(); if (!live || !record || record.phase !== 'ready' || !record.accessToken || !record.accessExpiresAt
              || Math.floor(Date.parse(record.accessExpiresAt) / 1000) * 1000 <= Date.now() + 1000) {
              throw new PlatformCredentialUnavailable('Active Mobile Platform Session required');
            }
            return record.accessToken;
          };
          try {
            credential();
            // Refresh generation/token is intentionally absent; a rotated token on the same sid retains the cursor.
            const scope = sha256(JSON.stringify(['mobile-focus-v1', authority.origin, authority.userId, authority.authScope,
              identity.installId, record!.deviceId, record!.sessionId, record!.keyThumbprint]));
            const reader = new AgentSessionReadClient(authority.origin, {
              accessToken: async () => credential(),
              signProof: async (method, htu, token) => {
                if (credential() !== token || !identity.signDpop) throw new NativePlatformTransportError();
                const proof = await identity.signDpop(method, htu, token, controller.signal); credential(); return proof;
              },
            }, async (input, init) => {
              credential(); const response = await options.fetch(input, init); credential();
              return { status: response.status, ok: response.ok, json: async () => { credential(); const result = await response.json(); credential(); return result; } } as Response;
            });
            const result = await reconcileAgentFocus(reader, scope, previous, controller.signal); credential(); return result;
          } finally { live = false; record = null; }
        });
      } finally { signal?.removeEventListener('abort', abort); if (active === controller) active = null; }
    },
    dispose() { closed = true; active?.abort(); },
  };
}
