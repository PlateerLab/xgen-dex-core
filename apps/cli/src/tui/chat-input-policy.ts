/**
 * 작성기 통제 정책 사전 검사(개인정보 · 금칙어 [채팅 입력시 차단]). 대화 화면과 시작 화면이 같이 쓴다.
 *
 * 타이핑이 멎으면 엔진을 거쳐 서버(xgen-workflow /api/chat/input-check)에 묻는다. 서버는 보낼 때 막는 것과 같은
 * 규칙으로 판정한다. 걸리면 작성기에 [잠김] 을 띄우고 이유를 위에 한 줄로 둔다. 터미널에는 단추가 없으므로 Enter
 * 로 보내는 함수가 `confirm(text)` 를 먼저 기다린다. 판정하지 못하면 막지 않는다(보낼 때 서버가 다시 본다).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CHAT_INPUT_CHECK_DELAY_MS,
  ChatInputGate,
  UNCHECKED_INPUT,
  chatInputNotice,
  type ChatInputCheck,
} from '@dex/protocol';
import type { TuiEngine } from './model';

export function useChatInputPolicy(
  engine: Pick<TuiEngine, 'checkChatInput'>,
  raw: string,
  workflowId: string | null | undefined,
  profile?: string,
) {
  const gate = useMemo(
    () => new ChatInputGate((text, wf) => engine.checkChatInput({ text, workflowId: wf, profile })),
    [engine, profile],
  );
  const [check, setCheck] = useState<ChatInputCheck>(UNCHECKED_INPUT);
  const latest = useRef('');
  const text = raw.trim();
  const wf = workflowId ?? null;

  useEffect(() => {
    latest.current = text;
    if (!text || text.startsWith('/')) {
      // 빗금 명령(/model 등)은 메시지가 아니다.
      setCheck(UNCHECKED_INPUT);
      return undefined;
    }
    const hit = gate.peek(text, wf);
    if (hit) {
      setCheck(hit);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void gate.ask(text, wf).then((res) => {
        if (alive && latest.current === text) setCheck(res);
      });
    }, CHAT_INPUT_CHECK_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gate, text, wf]);

  /** 보내기 직전: 보내도 되면 true. */
  const confirm = useCallback(
    async (value: string): Promise<boolean> => {
      const trimmed = value.trim();
      if (!trimmed) return true;
      const res = await gate.ask(trimmed, wf);
      if (latest.current === trimmed) setCheck(res);
      return !res.blocked;
    },
    [gate, wf],
  );

  return { check, blocked: check.blocked, notice: chatInputNotice(check), confirm };
}
