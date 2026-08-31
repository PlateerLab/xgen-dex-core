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

/**
 * 터미널에게 **키가 아닌 것을 보내지 말라** 고 말한다.
 *
 * 터미널은 창 포커스가 바뀌면 `ESC[I`/`ESC[O`, 마우스를 건드리면 `ESC[<0;1;1M` 을
 * 입력인 것처럼 보낸다. 이 모드들은 앞서 실행된 프로그램이 켜 두고 끄지 않은 채
 * 남아 있을 수 있어서, 우리가 켠 적 없어도 도착한다. 그대로 두면 메시지 칸에
 * `[I`·`[<0;1;1M` 이 타이핑된다 — 한글 IME 후보창이 뜨고 닫힐 때마다 포커스가
 * 오가므로 특히 자주 터진다.
 */
const DISABLE_REPORTS = [
  `${ESC}[?1004l`, // 포커스 들어옴/나감
  `${ESC}[?1000l`, // 마우스 클릭
  `${ESC}[?1002l`, // 마우스 드래그
  `${ESC}[?1003l`, // 마우스 이동 전부
  `${ESC}[?1006l`, // SGR 확장 좌표
].join('');

/**
 * 붙여넣기를 `ESC[200~` ... `ESC[201~` 로 감싸 달라고 한다.
 *
 * 감싸 주면 붙인 내용을 **키가 아니라 글자**로 다룰 수 있다. 안 감싸면 붙여넣은
 * 줄바꿈이 "전송" 으로 읽혀 반쪽짜리 메시지가 나가고, 내용 안의 ESC 는 제어
 * 시퀀스로 잘못 해석된다.
 */
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

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
      stream.write(ENTER_ALT_SCREEN + DISABLE_REPORTS + ENABLE_BRACKETED_PASTE);
    },
    restore(): void {
      // 되돌리기는 **한 번만** 한다. 정상 종료·Ctrl+C·예외가 겹쳐 두 번 나가면
      // 대체 화면을 하나 더 벗겨내 사용자의 원래 화면까지 지운다.
      if (restored) return;
      restored = true;
      // 켠 것만 되돌린다. 보고 모드는 원래 꺼져 있어야 정상이므로 다시 켜지 않는다.
      if (entered) stream.write(DISABLE_BRACKETED_PASTE + LEAVE_ALT_SCREEN);
      stream.write(SHOW_CURSOR);
    },
  };
}
