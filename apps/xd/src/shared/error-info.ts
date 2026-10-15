/**
 * 턴 실패 → 화면 문구. main(턴이 끝날 때)과 화면(지난 턴을 다시 그릴 때)이 같은 표를 쓴다.
 *
 * XD 가 아는 까닭(계정·키·모델·CLI 없음, 엔진 멈춤)은 여기 문구로, 엔진·제공자의 실패 글은 Dex 와 같은 분류기
 * (`describeStreamError`)로 사람이 읽는 말로 바꾼다. 문구는 한 문장, 내부 사정을 말하지 않는다.
 */
import { describeStreamError } from '@dex/protocol/errors';
import type { XgenErrorInfo } from '@dex/protocol';

/** XD 가 붙이는 실패 코드 → 화면 문구. 문구는 한 문장, 내부 사정을 말하지 않는다. */
export const XD_ERRORS: Record<string, Pick<XgenErrorInfo, 'title' | 'hint' | 'retryable'>> = {
  no_account: { title: '이 에이전트에 연결된 AI 제공자가 없습니다.', hint: '에이전트 설정에서 제공자를 고르세요.', retryable: false },
  no_key: { title: '이 제공자의 API 키가 없습니다.', hint: '제공자 설정에서 키를 입력하세요.', retryable: false },
  no_model: { title: '이 에이전트에 모델이 정해져 있지 않습니다.', hint: '에이전트 설정에서 모델을 고르세요.', retryable: false },
  no_cli: { title: '이 PC 에 CLI 가 설치되어 있지 않습니다.', hint: '제공자 설정에서 설치하세요.', retryable: false },
  no_base_url: { title: '서버 주소가 없습니다.', hint: '제공자 설정에서 주소를 입력하세요.', retryable: false },
  unsupported_provider: { title: '이 제공자는 아직 쓸 수 없습니다.', retryable: false },
  engine_unavailable: { title: '실행 엔진을 시작하지 못했습니다.', hint: '앱을 다시 시작해 보세요.', retryable: true },
  engine_exited: { title: '실행 엔진이 멈췄습니다.', hint: '다시 보내면 새로 시작합니다.', retryable: true },
  bad_request: { title: '에이전트 설정을 확인해 주세요.', retryable: false },
  // 앱이 턴 도중 꺼졌다 — 저장소가 다음 시작 때 붙이는 코드.
  interrupted: { title: '앱이 닫혀 답이 끝나지 않았습니다.', hint: '다시 보내 주세요.', retryable: true },
};

export function errorInfo(code: string, message: string): XgenErrorInfo {
  const known = XD_ERRORS[code];
  if (known) return { code: `XD-${code}`, detail: message, ...known };
  // 엔진(제공자·파이프라인)의 실패는 Dex 와 같은 분류기로 사람이 읽는 말로 바꾼다.
  return describeStreamError(message);
}

