/**
 * 작성기 통제 정책 사전 검사(개인정보 · 금칙어 [채팅 입력시 차단]).
 *
 * 타이핑이 멎으면 서버(xgen-workflow /api/chat/input-check)에 묻는다. 서버는 보낼 때 막는 실행 코어와 같은
 * 규칙으로 판정하므로 웹 채팅과 같은 글이 같은 결과를 받는다. 걸리면 보내기를 막고 이유를 작성기 아래에 둔다.
 *
 * 단추만 끄면 Enter · 음성 받아쓰기 · 빠른 채팅처럼 단추를 거치지 않는 길이 빠져나간다. 보내는 함수는 반드시
 * `confirm(text)` 를 먼저 기다린다. 판정하지 못하면(서버 오류 · 옛 서버) 막지 않는다: 보낼 때 서버가 다시 본다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_INPUT_CHECK_DELAY_MS,
  ChatInputGate,
  UNCHECKED_INPUT,
  chatInputNotice,
  type ChatInputCheck,
} from '@dex/protocol';
import { xgen } from '../bridge';

/** 화면을 오가도 같은 글의 판정을 다시 묻지 않게 하나를 같이 쓴다. */
const gate = new ChatInputGate((text, workflowId) => xgen.guardrails.checkInput(text, workflowId));

export function useChatInputCheck(raw: string, workflowId: string | null) {
  const [check, setCheck] = useState<ChatInputCheck>(UNCHECKED_INPUT);
  const latest = useRef('');
  // 서버도 앞뒤 공백을 떼고 본다. 같은 글을 공백 하나로 다시 묻지 않게 뗀 글로 묻는다.
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
    const timer = window.setTimeout(() => {
      void gate.ask(text, workflowId).then((res) => {
        if (alive && latest.current === text) setCheck(res);
      });
    }, CHAT_INPUT_CHECK_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [text, workflowId]);

  /** 보내기 직전: 보내도 되면 true. 막히면 false(작성기 글이면 이유가 아래에 선다). */
  const confirm = useCallback(
    async (value: string): Promise<boolean> => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      const res = await gate.ask(trimmed, workflowId);
      if (latest.current === trimmed) setCheck(res);
      return !res.blocked;
    },
    [workflowId],
  );

  return { check, blocked: check.blocked, notice: chatInputNotice(check), confirm };
}
