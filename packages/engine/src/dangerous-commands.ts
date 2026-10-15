/**
 * 되돌리기 어려운(파괴적) 명령 판정 — 사용자 PC 에서 셸을 돌리는 모든 곳이 이 규칙 하나를 쓴다.
 *
 * Dex 로컬 도구(local-tools)와 XD 엔진(apps/xd/engine, Python)이 같은 규칙이어야 한다. XD 엔진에는 사본을
 * 두지 않고 main 이 {@link dangerousPatternSpecs} 를 넘긴다 — 그래서 여기 정규식은 JavaScript 와 Python 이
 * **같은 뜻으로 읽는 문법만** 쓴다(`\b`·`[^\n]`·묶음·`^`, 플래그는 `i` 만). XD 엔진 시험이 같은 글자를 두
 * 언어에 돌려 판정이 같은지 본다(apps/xd/engine/tests/test_safety.py).
 *
 * 보안 경계가 아니라 "실수 방지 게이트"다 (에이전트는 어차피 로그인 사용자 권한).
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / -r / -f
  /(^|[;&|`(])\s*rm\s+\//i, // rm on an absolute path
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[a-z]*[sf]/i,
  // Only in command position: `git log --format=…` / `docker ps --format` are not `format C:`.
  /(^|[;&|`(])\s*(sudo\s+)?(mkfs(\.\w+)?|fdisk|format(\.com)?)\b/i,
  /\bdd\b[^\n]*\b(of|if)=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, // fork bomb
  /\bgit\s+push\b[^\n]*--force/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bsudo\s+rm\b/i,
];

/** True if the command matches a destructive pattern that warrants confirmation. */
export function isDangerousShellCommand(command: string): boolean {
  const c = String(command || '');
  return DANGEROUS_PATTERNS.some((re) => re.test(c));
}

/** 규칙을 다른 언어(XD 엔진)에 넘기는 모양 — RegExp 의 source·flags 그대로. */
export function dangerousPatternSpecs(): Array<{ source: string; flags: string }> {
  return DANGEROUS_PATTERNS.map((re) => ({ source: re.source, flags: re.flags }));
}

/** 확인 창 문구 — 호스트가 어떤 UI 로 묻든 같은 말을 한다. 제품 이름만 호스트가 정한다(Dex: XGEN, XD: XD). */
export function dangerousCommandPrompt(product: string) {
  return {
    title: '위험할 수 있는 명령 실행 확인',
    message: `${product} 에이전트가 이 PC 에서 되돌리기 어려운 명령을 실행하려 합니다.`,
    detail: (command: string) => command,
  } as const;
}

/**
 * 확인 창의 버튼과 그 뜻. **순서가 뜻이다** — 0 번(거부)이 기본값(Enter)·취소(Esc)여야 한다. 확인 창이 뜬 줄
 * 모르고 Enter 를 친 사용자가 `rm -rf` 를 승인하면 안 된다. 세 번째의 승인은 그 대화에만 남는다.
 */
export const DANGEROUS_COMMAND_CHOICES = ['거부', '이번만 허용', '이 대화에서 계속 허용'] as const;
export const DANGEROUS_COMMAND_ANSWERS = ['deny', 'once', 'session'] as const;
export type DangerousCommandAnswer = (typeof DANGEROUS_COMMAND_ANSWERS)[number];
