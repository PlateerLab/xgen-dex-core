import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentTurnComposerView } from '@dex/protocol/agent-turn-composer';
import type { DesktopNativeBridge, DesktopNativeNotice } from '../../native-session-types';
import { xgen } from './bridge';
import { DesktopNativeSessionModel, type DesktopNativeView } from './native-session-model';

const initialTurn: AgentTurnComposerView = {
  status: 'unavailable',
  canSubmit: false,
  canRetry: false,
  canStop: false,
  notice: '현재 연결에서는 요청을 보낼 수 없습니다.',
};

export function blankDesktopNativeView(): DesktopNativeView {
  return {
    busy: false,
    result: null,
    focus: null,
    conversation: null,
    hasMore: false,
    connection: 'idle',
    transport: 'none',
    error: '',
    turn: initialTurn,
    catalog: {
      focus: null,
      items: [],
      nextCursor: null,
      hasMore: false,
      olderPage: false,
      pageKnown: false,
      busy: false,
      writeBlocked: false,
      notice: '',
    },
  };
}

export interface DesktopNativeSessionBinding {
  model: DesktopNativeSessionModel | null;
  view: DesktopNativeView;
  draft: string;
  setDraft: (value: string) => void;
}

interface BoundModel {
  key: string;
  model: DesktopNativeSessionModel;
}

interface ObservedIdentity {
  scope: string | null;
  session: string | null;
  sessionKnown: boolean;
}

function expectedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function belongsToScope(notice: DesktopNativeNotice, origin: string, userId: string): boolean {
  if (notice.type === 'cleared') return true;
  return notice.value.platform_type === 'desktop'
    && notice.value.profile === 'desktop'
    && notice.value.server_url === origin
    && notice.value.update.user_id === userId;
}

export function createDesktopScopedBridge(bridge: DesktopNativeBridge, origin: string, userId: string): DesktopNativeBridge {
  return {
    async request(method, params) {
      const reply = await bridge.request(method, params);
      if (
        reply.ok
        && 'user_id' in reply.value
        && (
          reply.value.platform_type !== 'desktop'
          || reply.value.profile !== 'desktop'
          || reply.value.server_url !== origin
          || reply.value.user_id !== userId
        )
      ) {
        return {
          ok: false,
          code: 'scope_mismatch',
          message: '현재 계정과 서버에 맞는 Desktop 세션이 아닙니다.',
          ...(['submit-turn', 'stop-turn', 'create-agent-session', 'switch-agent-focus'].includes(method)
            ? { outcome: 'unknown' as const } : {}),
        };
      }
      return reply;
    },
    onUpdate(listener) {
      return bridge.onUpdate((notice) => {
        if (belongsToScope(notice, origin, userId)) listener(notice);
      });
    },
  };
}

export function observedDesktopAgentSession(view: DesktopNativeView): string | null | undefined {
  if (view.conversation) return view.conversation.snapshot?.id ?? null;
  if (view.focus) return view.focus.active_agent_session_id;
  if (view.catalog.focus) return view.catalog.focus.active_agent_session_id;
  return undefined;
}

/** Owns the native session model for the lifetime of its Workspace scope. */
export function useDesktopNativeSessionBinding(origin: string, userId: string): DesktopNativeSessionBinding {
  const key = useMemo(() => JSON.stringify([origin, userId]), [origin, userId]);
  const canonicalOrigin = expectedOrigin(origin);
  const validUser = /^[1-9][0-9]{0,9}$/.test(userId) && Number(userId) <= 2147483647;
  const modelRef = useRef<DesktopNativeSessionModel | null>(null);
  const identityRef = useRef<ObservedIdentity>({ scope: null, session: null, sessionKnown: false });
  const draftRef = useRef('');
  const [bound, setBound] = useState<BoundModel | null>(null);
  const [view, setView] = useState<DesktopNativeView>(() => blankDesktopNativeView());
  const [draft, setDraftState] = useState('');

  const setDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraftState(value);
  }, []);

  useEffect(() => {
    setDraft('');
    setView(blankDesktopNativeView());
    setBound(null);
    identityRef.current = { scope: null, session: null, sessionKnown: false };
    if (!canonicalOrigin || !validUser) {
      modelRef.current = null;
      return;
    }

    let controller: DesktopNativeSessionModel | null = null;
    controller = new DesktopNativeSessionModel(createDesktopScopedBridge(xgen.nativeSession, canonicalOrigin, userId), (next) => {
      if (controller !== null && modelRef.current !== controller) return;

      const previous = identityRef.current;
      const nextScope = next.result
        ? JSON.stringify([next.result.server_url, next.result.user_id])
        : null;
      const nextSession = observedDesktopAgentSession(next);
      let clearDraft = previous.scope !== null && nextScope === null;
      if (previous.scope !== null && nextScope !== null && previous.scope !== nextScope) clearDraft = true;
      if (nextSession !== undefined && previous.sessionKnown && previous.session !== nextSession) clearDraft = true;
      if (clearDraft && draftRef.current) setDraft('');

      identityRef.current = {
        scope: nextScope,
        session: nextSession === undefined ? previous.session : nextSession,
        sessionKnown: nextSession === undefined ? previous.sessionKnown : true,
      };
      setView(next);
    });
    modelRef.current = controller;
    setView(controller.state);
    setBound({ key, model: controller });

    return () => {
      if (modelRef.current === controller) modelRef.current = null;
      controller?.dispose();
    };
  }, [canonicalOrigin, key, setDraft, userId, validUser]);

  const active = bound?.key === key ? bound.model : null;
  return {
    model: active,
    view: active ? view : blankDesktopNativeView(),
    draft: active ? draft : '',
    setDraft,
  };
}
