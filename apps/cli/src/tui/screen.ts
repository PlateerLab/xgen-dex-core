/**
 * 대체 화면(alternate screen) 관리.
 *
 * 예전에는 TUI 를 지금 쓰던 터미널에 그대로 그렸다. 그래서 Ctrl+Q 로 나가면 마지막
 * 프레임 — 에이전트 목록, 대화창, 테두리 — 이 스크롤백에 그대로 남았다. 그 위로
 * 다음 프롬프트가 찍히니 화면이 엉킨 것처럼 보이고, 위로 스크롤하면 쓰지도 않을
 * UI 잔해가 예전 명령들 사이에 끼어 있다.
 *
 * `vim`·`less`·`htop` 이 쓰는 것과 같은 방법이다: 들어갈 때 화면을 한 장 새로 깔고,
 * 나올 때 원래 화면을 되돌린다. 사용자가 보기에는 **띄우기 전 상태로 그대로 돌아온다.**
 *
 * 별도 파일인 이유는 이 규칙들이 눈으로는 확인되지 않기 때문이다 — 틀리면 사용자
 * 터미널이 망가진 뒤에야 안다. 그래서 가짜 스트림에 대고 시험할 수 있게 떼어 뒀다.
 */

/** 쓰기만 필요하다. 진짜 stdout 도, 테스트의 가짜 스트림도 이걸 만족한다. */
export interface ScreenStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

const ESC = '\u001B';
/** 대체 화면으로 들어간다 (DECSET 1049). 커서 위치까지 함께 보관된다. */
export const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
/** 원래 화면으로 돌아온다. 들어가기 전 내용이 그대로 복원된다. */
export const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;
/** Ink 는 그리는 동안 커서를 숨긴다. 되돌리지 않으면 나간 뒤 커서가 보이지 않는다. */
export const SHOW_CURSOR = `${ESC}[?25h`;

export interface ScreenGuard {
  /** 대체 화면으로 들어간다. TTY 가 아니면 아무 것도 하지 않는다. */
  enter(): void;
  /** 원래 화면과 커서를 되돌린다. 여러 번 불러도 한 번만 동작한다. */
  restore(): void;
}

export function createScreenGuard(stream: ScreenStream): ScreenGuard {
  // TTY 가 아니면 손대지 않는다 — 파이프나 CI 로그에 제어 문자를 뿌릴 이유가 없다.
  const alt = Boolean(stream.isTTY);
  let entered = false;
  let restored = false;

  return {
    enter(): void {
      if (entered || !alt) return;
      entered = true;
      stream.write(ENTER_ALT_SCREEN);
    },
    restore(): void {
      // 되돌리기는 **한 번만** 한다. 정상 종료·Ctrl+C·예외가 겹쳐 두 번 나가면
      // 대체 화면을 하나 더 벗겨내 사용자의 원래 화면까지 지운다.
      if (restored) return;
      restored = true;
      if (entered) stream.write(LEAVE_ALT_SCREEN);
      stream.write(SHOW_CURSOR);
    },
  };
}
