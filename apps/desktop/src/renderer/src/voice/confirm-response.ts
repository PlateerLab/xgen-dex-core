import type { BrowserConfirmResolveRequest } from '@dex/protocol/browser';
import type { UserConfirmResolveRequest } from '@dex/protocol/user-confirm';
import type { VoiceConfirmIntent, VoiceConfirmTarget } from '@dex/protocol/voice-confirm';
export type { VoiceConfirmTarget } from '@dex/protocol/voice-confirm';

export function createConfirmVoiceResponder(deps: {
  current: () => VoiceConfirmTarget | null;
  decide: (requestId: string, text: string) => Promise<VoiceConfirmIntent>;
  browser: (answer: BrowserConfirmResolveRequest) => Promise<boolean>;
  user: (answer: UserConfirmResolveRequest) => Promise<boolean>;
  notice: (text: string) => void;
}) {
  let answeredId: string | null = null;
  const pending = new Set<string>();
  return async (text: string, recordedRequestId: string | null, trace?: (reason: string) => void): Promise<boolean> => {
    const target = deps.current();
    if (!recordedRequestId && !target) return false;
    // Consume stale speech, including speech recorded before a new card appeared.
    if (!target || target.request.requestId !== recordedRequestId || target.request.expiresAt <= Date.now()) {
      trace?.('confirmation_stale');
      return true;
    }
    const requestId = target.request.requestId;
    if (answeredId === requestId || pending.has(requestId)) { trace?.('confirmation_duplicate'); return true; }
    pending.add(requestId);
    try {
      deps.notice('응답의 뜻을 확인하는 중…');
      trace?.('confirmation_deciding');
      const intent = await deps.decide(requestId, text);
      const current = deps.current();
      if (!current || current.request.requestId !== requestId || current.request.expiresAt <= Date.now()) { trace?.('confirmation_stale'); return true; }
      if (!['approve', 'conversation', 'reject', 'revise'].includes(intent) || (intent === 'conversation' && target.kind !== 'browser')) {
        trace?.('confirmation_unclear');
        deps.notice('응답의 뜻을 확실히 이해하지 못했습니다. 진행할지, 멈출지, 고칠 내용을 다시 말해 주세요.');
        return true;
      }
      const message = intent === 'revise' ? text.trim() : undefined;
      trace?.(`confirmation_${intent}_requested`);
      const accepted = target.kind === 'browser'
        ? await deps.browser({ requestId, choice: intent === 'approve' ? 'once' : intent === 'conversation' ? 'conversation' : 'deny', ...(message ? { message } : {}) })
        : await deps.user({ requestId, choice: intent === 'approve' ? 'proceed' : 'revise', ...(message ? { message } : {}) });
      if (accepted) { answeredId = requestId; deps.notice(''); trace?.(`confirmation_${intent}_resolved`); }
      else { deps.notice('확인 요청이 이미 종료되었습니다. 현재 카드를 확인해 주세요.'); trace?.('confirmation_closed'); }
    } catch {
      trace?.('confirmation_error');
      if (deps.current()?.request.requestId === requestId)
        deps.notice('음성 응답을 처리하지 못했습니다. 다시 말하거나 카드의 버튼을 눌러 주세요.');
    } finally {
      pending.delete(requestId);
    }
    return true;
  };
}
