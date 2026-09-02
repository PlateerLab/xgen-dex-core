/**
 * OS 별 한글 입력 정책.
 *
 * macOS 는 Caps Lock 을 입력 소스 전환 키로 직접 처리한다. 이때 CLI 도
 * Ctrl+Space 같은 키로 자체 한/영 상태를 바꾸면 OS 입력기와 상태가 둘로 갈라진다.
 * macOS 에서는 시스템 입력기가 만든 글자를 그대로 받고, 그 밖의 OS 에서만 CLI의
 * 두벌식 조합기를 쓴다.
 */
export interface ImePolicy {
  native: boolean;
  shortcut: 'Caps Lock' | 'Ctrl+Space';
}

export function imePolicy(platform: NodeJS.Platform = process.platform): ImePolicy {
  return platform === 'darwin'
    ? { native: true, shortcut: 'Caps Lock' }
    : { native: false, shortcut: 'Ctrl+Space' };
}
