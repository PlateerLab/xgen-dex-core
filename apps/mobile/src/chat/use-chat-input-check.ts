/**
 * 작성기 통제 정책 사전 검사(개인정보 · 금칙어 [채팅 입력시 차단]). 대화 화면과 시작 화면이 같이 쓴다.
 *
 * 타이핑이 멎으면 서버(xgen-workflow /api/chat/input-check)에 묻는다. 서버는 보낼 때 막는 것과 같은 규칙으로
 * 판정하므로 웹 · 데스크톱과 같은 글이 같은 결과를 받는다. 걸리면 보내기 단추를 끄고 이유를 작성기 위에 둔다.
 * 시작 화면에서 넘어온 첫 메시지처럼 단추를 거치지 않는 길도 보내기 직전에 `confirm(text)` 를 기다린다.
 * 판정하지 못하면(서버 오류 · 옛 서버) 막지 않는다: 보낼 때 서버가 다시 본다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_INPUT_CHECK_DELAY_MS,
  ChatInputGate,
  UNCHECKED_INPUT,
  chatInputNotice,
  type ChatInputCheck,
} from '@dex/protocol';
import type { XgenMobileClient } from '../lib/xgen';

export function useChatInputCheck(client: XgenMobileClient, raw: string, workflowId: string | null) {
  const gate = useMemo(
    () => new ChatInputGate((text, wf) => client.api.guardrails.checkInput(text, wf)),
    [client],
  );
  const [check, setCheck] = useState<ChatInputCheck>(UNCHECKED_INPUT);
  const latest = useRef('');
  const text = raw.trim();

  useEffect(() => {
    latest.current = text;
    if (!text) {
      setCheck(UNCHECKED_INPUT);
      return undefined;
    }
    const hit = gate.peek(text, workflowId);
    if (hit) {
      setCheck(hit);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void gate.ask(text, workflowId).then((res) => {
        if (alive && latest.current === text) setCheck(res);
      });
    }, CHAT_INPUT_CHECK_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gate, text, workflowId]);

  /** 보내기 직전: 보내도 되면 true. */
  const confirm = useCallback(
    async (value: string): Promise<boolean> => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      const res = await gate.ask(trimmed, workflowId);
      if (latest.current === trimmed) setCheck(res);
      return !res.blocked;
    },
    [gate, workflowId],
  );

  return { check, blocked: check.blocked, notice: chatInputNotice(check), confirm };
}
