/** 업데이트가 보는 곳 — electron-builder.yml 의 publish·mac.artifactName 과 같아야 한다(packaging.test.ts 가 맞댄다). */
export const UPDATE_REPO = 'PlateerLab/xgen-dex-core';

/** macOS 의 새 판 dmg 주소 — 서명 없는 맥은 스스로 바꿀 수 없어 브라우저로 받게 한다(이 맥의 아키텍처 것). */
export function macDmgUrl(version: string, arch: string): string {
  return `https://github.com/${UPDATE_REPO}/releases/download/v${version}/XD-${version}-${arch}.dmg`;
}
