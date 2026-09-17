/**
 * 채팅의 두 가지 안전 장치 — 답변 아래 면책 문구, 보내기 전 민감정보 경고.
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

/** 민감정보 검사 결과 — 무엇이 걸렸는지. */
export interface ContentFilterResult {
  /** 주민등록번호·계좌번호 같은 고유식별·금융 정보. */
  pii: boolean;
  /** 관리자가 막아 둔 말. */
  forbidden: boolean;
  /** 둘 중 하나라도 걸렸는가. */
  flagged: boolean;
}

const SAFE: ContentFilterResult = { pii: false, forbidden: false, flagged: false };

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
   * 보내려는 글에 민감정보가 있는가. 검사기가 없거나 실패하면 **없는 것으로** 본다.
   *
   * 여기서 막지 않는다 — 경고만 남기고 보내는 것은 사용자가 정한다(웹과 같다).
   */
  async checkContent(text: string): Promise<ContentFilterResult> {
    if (!text.trim()) return SAFE;
    try {
      const res = await this.http.post<ContentFilterResult>('/api/config/content-filter/check', {
        text,
      });
      return { pii: !!res?.pii, forbidden: !!res?.forbidden, flagged: !!res?.flagged };
    } catch {
      return SAFE;
    }
  }
}
