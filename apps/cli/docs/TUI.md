# Dex terminal UI

## 실행 조건

`dex`와 `dex ui`는 stdin/stdout이 모두 TTY이고 `TERM`이 `dumb`가 아니며 CI가 아닐 때 TUI를
실행합니다. pipe, redirect, JSON 출력, `serve --stdio`는 기존 headless 경로를 사용합니다.

## 첫 실행

1. XGEN Gateway URL 입력
2. `default` profile 생성
3. 이메일과 비밀번호 로그인
4. Agent 목록 로드
5. 대시보드 진입

비밀번호는 login 호출 직전에 컴포넌트 state에서 지우며 token은 기존과 동일하게 OS
keychain에만 저장합니다.

## 대시보드

- 넓은 터미널: Agent 목록과 채팅을 좌우로 표시
- 좁은 터미널: `Tab`으로 Agent 목록과 채팅 화면 전환
- SSE `text` 이벤트는 현재 Assistant 메시지에 누적
- tool 이벤트는 실행 중/완료/실패 상태로 갱신
- node/status 이벤트는 채팅 하단 상태 줄에 표시
- `Esc`는 현재 `AbortController`를 취소
- 같은 interaction ID를 재사용해 대화를 이어감
- 로컬 도구가 활성화되어 있으면 첫 채팅 전에 도구 bridge와 카탈로그를 연결

## 명령 팔레트

`Ctrl+K`:

- 새 대화
- 대화 기록
- profile 전환
- 로그아웃
- 종료

## 터미널 안전성

- TUI 진입점은 dynamic import chunk로 분리
- 일반 CLI와 stdio RPC는 Ink를 로드하지 않음
- stdout protocol에 TUI 로그를 기록하지 않음
- Ctrl+C/Ctrl+Q/오류/unmount 시 cursor와 raw mode 복원
- `NO_COLOR` 환경은 Ink의 색상 비활성화 동작을 따름
