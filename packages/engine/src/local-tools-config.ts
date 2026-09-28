/**
 * CLI/RPC 가 저장하는 로컬 도구 설정.
 *
 * 무엇을 만질 수 있는지는 더 이상 설정이 정하지 않는다 — 대화에 연결한 폴더가
 * 정한다(local-folders.ts). CLI 는 대화를 시작한 폴더를, VSCode 는 열린 작업
 * 영역 폴더를 그 대화에 붙인다. 그래서 켜기/끄기·허용 폴더·기본 작업 폴더 같은
 * 값은 없어졌고, 남은 것은 하나다: `allowDangerous`.
 *
 * 엔진은 위험한 명령을 **사용자에게 물어서** 처리한다(InteractionPort). 그런데
 * CLI 를 파이프에 물려 돌리거나 스크립트로 부를 때는 물을 사람이 없다. 그때
 * `allowDangerous: true` 는 "설정 파일로 미리 승인했다"는 뜻이고, 그건 대화 내내
 * 승인한 것과 정확히 같다 — 그래서 그 답을 그대로 내는 InteractionPort 로 바꾼다.
 * 불리언을 도구 코드에 다시 심지 않는 이유는, 그러면 승인 경로가 둘이 되고 한쪽만
 * 고쳐지기 때문이다.
 */
import type { InteractionPort } from './ports/index';

export interface LocalToolsConfig {
  /** 물을 사람이 없는 실행에서 파괴적 명령을 미리 승인한다. */
  allowDangerous: boolean;
}

export function defaultLocalToolsConfig(): LocalToolsConfig {
  return { allowDangerous: false };
}

/** 옛 설정 파일의 다른 키(enabled·allowedRoots 등)는 읽지 않고 버린다. */
export function normalizeLocalToolsConfig(value: unknown): LocalToolsConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { allowDangerous: v.allowDangerous === true };
}

/**
 * `allowDangerous` 를 승인 포트로 바꾼다.
 *
 * 켜져 있으면 "이 대화에서 계속 허용"을 그대로 답하고, 꺼져 있으면 `undefined` 를
 * 돌려준다 — 그러면 호스트가 준 포트(있다면)가 그대로 쓰이고, 없으면 엔진이
 * 거부한다. 여기서 임의로 'deny' 를 답하지 않는 이유: 그러면 물어볼 수 있는
 * 호스트에서도 설정 하나 때문에 못 묻게 된다.
 */
export function dangerousApprovalFromConfig(
  config: LocalToolsConfig,
): InteractionPort['confirmDangerous'] | undefined {
  if (!config.allowDangerous) return undefined;
  return async () => 'session';
}
