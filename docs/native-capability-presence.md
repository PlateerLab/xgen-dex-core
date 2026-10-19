# Desktop native capability presence / PC 잠금·절전 연결 철회

2026-10-19. 기존 native 기기 연결을 main-process OS presence에 결합한다.
잠금·절전·macOS 사용자 세션 전환에서 새 연결/확인/선택/adoption을 막고 현재 target socket과
확인/실행 신호를 닫는다. 해제/복귀는 해당 원인만 해제하며 자동 연결/이전 승인 재사용은 하지 않는다.
현재 로그인 자격·원격 턴·Agent Session 정본은 유지하고 사용자는 기기를 새로 연결/선택한다.

확인: 겹치는 OS event 순서, 진행 중 connect/confirm/실행의 취소/늦은 응답, 복귀 후 명시 연결,
현재 main-frame 경계·계정 변경·renderer 재생성, 실제 Electron event wiring과 UI를 검증한다.
실제 OS 잠금/절전·다른 OS·CLI/VSCode/전체 운영 수용은 구현 검증과 구분해 기록한다.
새 환경변수·서버 DB schema·SDK/runtime 배포는 없다. 상위 Draft/보호 기준은 유지한다.

English: OS presence gates native device capabilities in the main process. Resume never replays or
reconnects authority automatically. Login credentials and the canonical conversation remain intact.
