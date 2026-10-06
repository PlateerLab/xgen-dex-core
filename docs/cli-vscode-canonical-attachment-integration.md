# CLI·VSCode Canonical 첨부 연결 / CLI and VSCode canonical attachments

## 작업 경계 / Scope

CLI Canonical TUI에 명시적 로컬 파일 선택과 첨부 업로드·복구·취소를 연결한다. VSCode는 확장 호스트의 시스템 선택기를 사용하고, 선택된 로컬 경로는 한 번의 호스트 요청에만 응답하는 private stdio 경계에서 엔진으로 전달한다. 웹뷰와 일반 native 요청은 경로·바이트를 지정할 수 없다.

Connect explicit local file selection, upload, recovery and cancellation to the CLI canonical TUI. VSCode uses its extension-host system picker and returns selected local paths only through a private stdio response to one host-issued request. Webviews and ordinary native requests cannot supply paths or bytes.

기존 Desktop의 파일 검증을 공통 엔진 helper로 공유한다. 모든 표시 draft는 계정·origin·로그인·Agent Session·workflow에 묶이며 10개·원본 합계 100 MiB 한도를 따른다. 결과 불명은 명시적 영수증 복구와 원래 턴 재시도로 처리한다.

Reuse Desktop file validation through a shared engine helper. Drafts remain bound to account, origin, native login, Agent Session and workflow with limits of ten files and 100 MiB of retained original bytes. Unknown outcomes require explicit receipt recovery and original-turn retry.

통합 기준 / Integration baseline: `58a83e17be1e1f62f6de54d11f719f4965e9152e`. 실제 ACTIVE 서버·runner·수동 VSCode 선택 검증은 별도 완료 관문이다. 환경변수 변경과 배포는 계획하지 않는다.

Actual ACTIVE server, runner and manual VSCode picker acceptance remain separate completion gates. No environment variable changes or releases are planned.
