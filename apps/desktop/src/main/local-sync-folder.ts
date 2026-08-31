/** 로컬 동기화 폴더명 선택 — 순수 로직 (단위 테스트). */

/** 상태 파일 이름용 — ASCII 로 강하게 좁힌다 (workflowId 는 ASCII 라 안전). */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 폴더 이름용 — **유니코드(한글 등)와 하이픈·괄호는 보존**하고, 파일시스템
 * 금지문자(`< > : " / \ | ? *`)만 공백으로 없앤다. 에이전트 라벨이
 * "마케팅 리서치"·"new-shlee" 처럼 와도 폴더가 알아볼 수 있게 남는다
 * (safeName 은 한글을 전부 `_` 로 바꿔 버리므로 여기 쓰면 안 된다).
 */
export function safeFolder(name: string): string {
  // 문자 그룹에 하이픈·공백을 넣지 않는다 (하이픈 보존, 공백은 아래서 collapse).
  const forbidden = new RegExp('[<>:"/\\\\|?*]', 'g');
  return name
    .replace(forbidden, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows: 끝의 점·공백 금지
}

/**
 * 온디맨드 페어의 폴더명 — 라벨을 폴더 안전하게 쓰되, 이미 쓰인 이름이면
 * workflowId 꼬리를 붙여 겹치지 않게 한다 (같은 이름의 다른 에이전트 두 개).
 */
export function pickFolderName(workflowId: string, label: string, taken: Set<string>): string {
  const base = safeFolder(label) || safeName(workflowId) || 'agent';
  if (!taken.has(base)) return base;
  return `${base}-${safeName(workflowId).slice(-6)}`;
}
