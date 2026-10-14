/**
 * 채팅의 두 가지 안전 장치: 답변 아래 면책 문구, 보내기 전 통제 정책(개인정보 · 금칙어) 사전 검사.
 *
 * 웹 채팅에만 있어서 같은 서버·같은 계정인데도 앱에서는 문구가 없고 경고도 뜨지 않았다.
 * 두 장치 모두 **서버가 정한다**: 면책은 공개 설정 한 칸, 민감정보는 서버 검사기의 판정이다.
 * 앱이 제 나름으로 판단하면 같은 문장이 웹에서는 걸리고 앱에서는 안 걸린다.
 */
import { HttpClient } from './client';

/** 답변 말풍선 아래 고정 문구 — 문구 자체는 제품이 정하고 서버는 켜고 끄기만 한다. */
export const CHAT_AI_DISCLAIMER_TEXT =
  '본 답변은 AI가 생성한 참고 자료로, 최종 판단과 책임은 사용자에게 있습니다. 사용 전 반드시 검증해 주세요.';

/** 공개 설정 이름 — 웹과 같은 칸을 읽어야 한 번 끄면 둘 다 꺼진다. */
export const CHAT_AI_DISCLAIMER_KEY = 'CHAT_AI_DISCLAIMER_ENABLED';

/**
 * 설정 값 → 참/거짓.
 *
 * 설정 저장소는 같은 값을 `true` 로도 `"true"` 로도 돌려준다. 그대로 조건문에 넣으면
 * 문자열 `"false"` 가 참이 되어 꺼 둔 기능이 켜진다.
 */
export function coerceConfigBool(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(s)) return true;
    if (['false', '0', 'no', 'off', 'disabled', ''].includes(s)) return false;
  }
  return fallback;
}

/** 통제 정책 종류: 개인정보 · 금칙어. */
export type ControlPolicyKind = 'pii' | 'forbidden_word';

/**
 * 채팅 입력창 사전 검사 결과(xgen-workflow POST /api/chat/input-check).
 *
 * 서버는 보낼 때 막는 실행 코어와 **같은 규칙**(탐지 스위치 · 자리 스위치 · 에이전트별 예외)으로 판정한다.
 * 그래서 앱이 통과시킨 글을 서버가 막거나 그 반대가 없다. 걸린 원문과 정규식은 오지 않는다.
 */
export interface ChatInputCheck {
  /** 이대로 보내면 [채팅 입력시 차단] 으로 받지 않는다. 앱은 보내기를 막고 message 를 보인다. */
  blocked: boolean;
  kinds: ControlPolicyKind[];
  /** 막을 때 보일 안내(정책 이름만, 원문 없음). 예: 개인정보(전화번호)가 들어 있어 보낼 수 없습니다. … */
  message: string;
  /** 막지는 않지만 [모델에 전달 차단] 으로 가려 전달되는 종류와 그 안내. */
  maskedKinds: ControlPolicyKind[];
  notice: string;
  /** 거짓이면 판정하지 못했다(서버 오류 · 시간 초과 · 옛 서버). **막지 않는다**: 보낼 때 서버가 다시 본다. */
  checked: boolean;
}

export const UNCHECKED_INPUT: ChatInputCheck = {
  blocked: false, kinds: [], message: '', maskedKinds: [], notice: '', checked: false,
};

/** 입력이 멈추고 이만큼 지나면 묻는다(웹과 같다). */
export const CHAT_INPUT_CHECK_DELAY_MS = 350;
/** 입력하는 동안 불리므로 짧게 기다린다. 넘으면 판정하지 못한 것으로(막지 않음). */
export const CHAT_INPUT_CHECK_TIMEOUT_MS = 6000;

function kindsOf(value: unknown): ControlPolicyKind[] {
  return Array.isArray(value) ? value.filter((k): k is ControlPolicyKind => k === 'pii' || k === 'forbidden_word') : [];
}

/** 서버 응답(snake_case) → 앱 모양. 모르는 값은 막지 않는 쪽으로. */
export function toChatInputCheck(data: unknown): ChatInputCheck {
  if (!data || typeof data !== 'object') return UNCHECKED_INPUT;
  const d = data as Record<string, unknown>;
  return {
    blocked: d.blocked === true,
    kinds: kindsOf(d.kinds),
    message: typeof d.message === 'string' ? d.message : '',
    maskedKinds: kindsOf(d.masked_kinds),
    notice: typeof d.notice === 'string' ? d.notice : '',
    checked: d.checked === true,
  };
}

/** 입력창 아래 한 줄: 막는 이유(block) 또는 막지 않는 안내(info). 없으면 null. */
export function chatInputNotice(check: ChatInputCheck | null | undefined): { tone: 'block' | 'info'; text: string } | null {
  if (!check) return null;
  if (check.blocked && check.message) return { tone: 'block', text: check.message };
  if (check.notice) return { tone: 'info', text: check.notice };
  return null;
}

/**
 * 판정을 글마다 잠깐 기억하는 문지기. 앱마다 같은 일을 하게 한 곳에 둔다.
 *
 * 보내기 단추만 끄면 Enter · 음성 · 빠른 채팅처럼 단추를 거치지 않는 길이 빠져나간다. 보내는 함수는 반드시
 * `allows(text, workflowId)` 를 먼저 기다린다: 그 글의 판정이 아직 없으면 그 자리에서 묻는다.
 */
export class ChatInputGate {
  private cache = new Map<string, ChatInputCheck>();

  constructor(
    private check: (text: string, workflowId: string | null) => Promise<ChatInputCheck>,
    private size = 24,
  ) {}

  private key(text: string, workflowId: string | null): string {
    return `${workflowId ?? ''}\u0000${text}`;
  }

  /** 기억해 둔 판정(없으면 undefined). */
  peek(text: string, workflowId: string | null): ChatInputCheck | undefined {
    return this.cache.get(this.key(text, workflowId));
  }

  /** 판정(기억이 있으면 그것). 판정하지 못한 결과는 기억하지 않는다. */
  async ask(text: string, workflowId: string | null): Promise<ChatInputCheck> {
    if (!text.trim()) return { ...UNCHECKED_INPUT, checked: true };
    const key = this.key(text, workflowId);
    const hit = this.cache.get(key);
    if (hit) return hit;
    let fresh: ChatInputCheck;
    try {
      fresh = await this.check(text, workflowId);
    } catch {
      // 묻는 길 자체가 깨졌다(IPC · RPC 오류). 판정하지 못한 것으로: 막지 않는다.
      return UNCHECKED_INPUT;
    }
    if (fresh.checked) {
      this.cache.delete(key);
      this.cache.set(key, fresh);
      while (this.cache.size > this.size) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return fresh;
  }

  /** 보내도 되는가. 막히면 false(이유는 ask 의 message). */
  async allows(text: string, workflowId: string | null): Promise<boolean> {
    return !(await this.ask(text, workflowId)).blocked;
  }
}

export class ChatGuardrailsApi {
  constructor(private http: HttpClient) {}

  /**
   * 답변 아래 면책 문구를 보일까. 모르면 **보인다**(기본 켜짐).
   *
   * 못 읽었다고 문구를 빼면, 있어야 할 안내가 조용히 사라진다 — 잠깐 늦게 뜨는 쪽이 낫다.
   */
  async disclaimerEnabled(): Promise<boolean> {
    try {
      const res = await this.http.get<{ current_value?: unknown }>(
        `/api/base/v1/config/${encodeURIComponent(CHAT_AI_DISCLAIMER_KEY)}`,
      );
      return coerceConfigBool(res?.current_value, true);
    } catch {
      return true;
    }
  }

  /**
   * 입력창 사전 검사. 서버가 보낼 때 막는 것과 같은 규칙으로 판정한다(통제 정책 [채팅 입력시 차단]).
   *
   * 실패하면(서버 오류 · 시간 초과 · 이 경로가 없는 옛 서버) **막지 않는다**(checked=false): 보낼 때 서버가 다시 본다.
   * 2026-10-14 전에는 core `/api/config/content-filter/check` 로 경고만 했다. 그 검사는 탐지 스위치 · 자리 스위치 ·
   * 에이전트별 예외를 보지 않아 서버 판정과 어긋났다.
   */
  async checkInput(text: string, workflowId?: string | null): Promise<ChatInputCheck> {
    if (!text.trim()) return { ...UNCHECKED_INPUT, checked: true };
    try {
      const res = await this.http.post<unknown>(
        '/api/chat/input-check',
        { text, workflow_id: workflowId || null },
        { timeoutMs: CHAT_INPUT_CHECK_TIMEOUT_MS },
      );
      return toChatInputCheck(res);
    } catch {
      return UNCHECKED_INPUT;
    }
  }
}
