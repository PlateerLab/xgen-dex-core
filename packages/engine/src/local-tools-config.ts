/**
 * CLI/RPC 가 다루는 설정 모양 ↔ 엔진 도구 제공자의 모양.
 *
 * 두 모양은 사실상 같다 — 이름만 다르다(`blockedCommands` ↔ `blocked`). 예전에
 * 두 저장소에 하나씩 있었던 흔적이고, 지금은 한쪽이 정본이고 다른 쪽은 그것의
 * 바깥 표현이다. 여기가 그 둘을 잇는 유일한 자리다.
 *
 * 하나만 다르다: `allowDangerous`.
 *
 * 엔진은 위험한 명령을 **사용자에게 물어서** 처리한다(InteractionPort). 그런데
 * CLI 를 파이프에 물려 돌리거나 스크립트로 부를 때는 물을 사람이 없다. 그때
 * `allowDangerous: true` 는 "설정 파일로 미리 승인했다"는 뜻이고, 그건 세션 내내
 * 승인한 것과 정확히 같다 — 그래서 그 답을 그대로 내는 InteractionPort 로 바꾼다.
 * 불리언을 도구 코드에 다시 심지 않는 이유는, 그러면 승인 경로가 둘이 되고 한쪽만
 * 고쳐지기 때문이다.
 */
import type { InteractionPort } from './ports/index';
import type { LocalShellConfig } from './local-tools';

export interface LocalToolsConfig {
  /** 명시적 opt-in. false 면 로컬 도구가 전혀 노출되지 않는다. */
  enabled: boolean;
  /** 로그인 사용자 권한의 무제한 Shell/ShellJob. 별도 명시 opt-in. */
  shellEnabled: boolean;
  /** Shell 과 상대경로 파일 도구의 기본 작업 디렉터리. */
  cwd: string;
  /** 포그라운드 Shell 의 벽시계 상한(ms). */
  timeoutMs: number;
  /** 구조적 파일 도구가 만질 수 있는 루트들. */
  allowedRoots: string[];
  /** Shell 이 거부하는 첫 토큰들. */
  blockedCommands: string[];
  /** 물을 사람이 없는 실행에서 파괴적 명령을 미리 승인한다. */
  allowDangerous: boolean;
}

export function defaultLocalToolsConfig(): LocalToolsConfig {
  return {
    enabled: false,
    shellEnabled: false,
    cwd: '',
    timeoutMs: 120_000,
    allowedRoots: [],
    blockedCommands: [],
    allowDangerous: false,
  };
}

const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 3_600_000;

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = String(item ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function normalizeLocalToolsConfig(value: unknown): LocalToolsConfig {
  const d = defaultLocalToolsConfig();
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const timeout = Number(v.timeoutMs);
  return {
    enabled: v.enabled === true,
    shellEnabled: v.shellEnabled === true,
    cwd: String(v.cwd ?? '').trim(),
    timeoutMs: Number.isFinite(timeout)
      ? Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(timeout)))
      : d.timeoutMs,
    allowedRoots: cleanList(v.allowedRoots),
    blockedCommands: cleanList(v.blockedCommands),
    allowDangerous: v.allowDangerous === true,
  };
}

/** 바깥 표현 → 도구 제공자가 받는 모양. */
export function toShellConfig(config: LocalToolsConfig): LocalShellConfig {
  return {
    enabled: config.enabled,
    shellEnabled: config.shellEnabled,
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    allowedRoots: config.allowedRoots,
    blocked: config.blockedCommands,
  };
}

/**
 * `allowDangerous` 를 승인 포트로 바꾼다.
 *
 * 켜져 있으면 "이 세션 동안 허용"을 그대로 답하고, 꺼져 있으면 `undefined` 를
 * 돌려준다 — 그러면 호스트가 준 포트(있다면)가 그대로 쓰이고, 없으면 엔진이
 * 거부한다. 여기서 임의로 'deny' 를 답하지 않는 이유: 그러면 데스크톱에서 물어볼
 * 수 있는데도 설정 하나 때문에 못 묻게 된다.
 */
export function dangerousApprovalFromConfig(
  config: LocalToolsConfig,
): InteractionPort['confirmDangerous'] | undefined {
  if (!config.allowDangerous) return undefined;
  return async () => 'session';
}
