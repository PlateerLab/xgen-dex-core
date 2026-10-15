# CLI·VSCode Canonical 첨부 연결 / CLI and VSCode canonical attachments

## 작업 경계 / Scope

CLI Canonical TUI에 명시적 로컬 파일 선택과 첨부 업로드·복구·취소를 연결한다. VSCode는 확장 호스트의 시스템 선택기를 사용하고, 선택된 로컬 경로는 한 번의 호스트 요청에만 응답하는 private stdio 경계에서 엔진으로 전달한다. 웹뷰와 일반 native 요청은 경로·바이트를 지정할 수 없다.

Connect explicit local file selection, upload, recovery and cancellation to the CLI canonical TUI. VSCode uses its extension-host system picker and returns selected local paths only through a private stdio response to one host-issued request. Webviews and ordinary native requests cannot supply paths or bytes.

기존 Desktop의 파일 검증을 공통 엔진 helper로 공유한다. 모든 표시 draft는 계정·origin·로그인·Agent Session·workflow에 묶이며 10개·원본 합계 100 MiB 한도를 따른다. 결과 불명은 명시적 영수증 복구와 원래 턴 재시도로 처리한다.

Reuse Desktop file validation through a shared engine helper. Drafts remain bound to account, origin, native login, Agent Session and workflow with limits of ten files and 100 MiB of retained original bytes. Unknown outcomes require explicit receipt recovery and original-turn retry.

통합 기준 / Integration baseline: `58a83e17be1e1f62f6de54d11f719f4965e9152e`. 실제 ACTIVE 서버·runner·수동 VSCode 선택 검증은 별도 완료 관문이다. 환경변수 변경과 배포는 계획하지 않는다.

Actual ACTIVE server, runner and manual VSCode picker acceptance remain separate completion gates. No environment variable changes or releases are planned.

## 구현 / Implementation

- CLI는 `dex ui --canonical --user-id <id> --profile <name>`에서 `A`로 첨부 목록을 열고 다시 `A`로 숨김 로컬 경로를 입력한다. `U` 업로드, `R` 영수증 복구, `C` 취소, `D` 로컬 사본 전체 폐기를 제공한다. 상대 경로는 CLI 호스트의 현재 디렉터리를 기준으로 해석한다. one-shot `dex chat --canonical` 첨부 옵션은 이번 범위에 포함하지 않는다.
- VSCode Canonical 작성기의 파일 선택 버튼은 확장 호스트의 `showOpenDialog`를 연다. 파일명·크기·타입·상태·명시적 동작만 웹뷰에 전달하며 receipt, checksum, attachment ID, 원문 바이트와 로컬 경로는 전달하지 않는다. 선택 핸들은 동작 라우팅에만 사용하고 화면에 표시하지 않는다.
- `canonicalAttachments` capability는 trusted picker가 연결된 경우에만 제공한다. 이전 엔진은 fail closed로 처리한다. 역방향 `host/pick-native-attachments`는 남은 개수/바이트 한도와 임의 요청 ID만 전송하고, 하나의 private stdio 응답으로 선택 경로를 받는다. 취소·중복·알 수 없는 ID 응답은 파일을 읽지 않는다. 취소를 무시하는 OS 대화상자는 종료될 때까지 두 번째 대화상자를 열지 않는다.
- 공통 reader는 일반 파일, 최종 경로 symlink 거부, 파일 identity/크기/수정 시각 재검증, 4,096자 경로 상한, NFC basename, 합계 제한을 확인한다. 호스트가 원문을 복사한 뒤 임시 buffer를 지우고, scope 변경과 종료 시 retained bytes를 지운다. filesystem/provider 오류는 경로가 없는 일반 오류로 바꾼다.
- 모든 선택 파일의 영수증이 ready여야 턴을 보낸다. RPC 호스트도 일부 참조·다른 참조·첨부를 숨긴 텍스트 전송을 거부한다. 요청의 참조 순서를 보존한다. 결과 불명의 PUT은 자동 반복하지 않고 GET으로 복구하며, 턴 재시도는 원문·CAS 버전·중복 방지 키·참조 순서를 그대로 사용한다.
- 실제 private 인증 scope를 선택 전후에 확인한다. 인증 실패는 호스트의 파일 원문과 이전 턴 잠금을 지우고, 클라이언트의 draft와 입력 중인 경로를 폐기한다. 계정·서버·세션·workflow 변경 및 늦은 성공/실패 응답은 이전 첨부를 복원하지 않는다.

The interactive CLI offers a masked local-path form and explicit upload, recovery, cancellation and discard actions; relative paths resolve in its host process. One-shot CLI attachment flags are outside this increment. VSCode uses its trusted extension-host chooser, while its webview receives display metadata and opaque action handles only. Capability negotiation, private reverse-request correlation, a single outstanding dialog, shared safe file reads, all-selected-ready enforcement, ordered references, exact UNKNOWN retries and private-auth-scope invalidation are covered by regressions. Retained and temporary bytes are destroyed on the relevant lifecycle boundaries.

## 검증 / Verification

| 검사 / Check | 로컬 결과 / Local result |
| --- | --- |
| workspace TypeScript, Desktop renderer/main TypeScript | 통과 / Passed |
| Protocol | 365/365 |
| Engine | 217/219, OS 조건 2 skip / Two platform-condition skips |
| RPC | 8/8 |
| CLI (실제 Ink 입력 포함 / Includes actual Ink input) | 215/215 |
| VSCode | 57/57 |
| Desktop (실제 localhost HTTPS 첨부 회귀 포함 / Includes localhost HTTPS attachment regression) | 577/577 |
| CLI·VSCode·Desktop build, bundle contracts | 통과 / Passed |
| production VSCode 웹뷰의 Electron 어댑터 실행 / Production webview in Electron adapter | 선택·업로드·복구·폐기·전송·취소 라우팅, 파일 순서, UNKNOWN 잠금, 비공개 값 미표시 통과 / Actions, order, UNKNOWN locks and private-value exclusion passed |

웹뷰 검증은 실제 production provider/script를 렌더링하지만 첨부 상태와 동작 결과를 fixture로 주입한다. 실제 VSCode 설치와 OS 선택기의 end-to-end 검증을 대신하지 않는다. RPC에는 실제 child process 통신, 실제 host/private chooser, 파일 reader와 인증 scope 회귀가 별도로 있다. CI에 RPC 테스트를 추가했다. 정확한 검증 Head와 CI 상태는 하위 [PR #176](https://github.com/PlateerLab/xgen-dex-core/pull/176)에 기록한다.

The rendered webview check injects fixture attachment state/actions; it does not claim installed-extension or real OS-picker acceptance. Separate regressions exercise real child-process transport, the native host chooser, filesystem reads and auth-scope rotation. RPC tests now run in CI. The child PR records its exact tested head and CI status.

재실행 / Reproduction:

```sh
npm run check
npm run build
npm --prefix apps/desktop run build
npm run contracts
npm test
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run typecheck:node
node apps/vscode/verify/run-native-attachment-webview.cjs
```

GUI 검증은 Desktop dependencies와 GUI 세션이 필요하며 임시 CLI 설정을 사용한다. 사용자 credential은 사용하지 않는다. / The UI check needs Desktop dependencies and a GUI session; it uses disposable CLI configuration without user credentials.

## 실행 환경과 남은 관문 / Environment and remaining gates

Compose `workflow`·`frontend` 프로필의 실제 `/app` source mount에서 `feat/cross-platform-session`과 clean checkout을 확인했다. Core `cae4094`, Gateway `2181a77`, Workflow `cd5876d`, Frontend `939604d`가 실행 중이다. Gateway는 `enrollment` 모드다. SDK `0c5e853`과 runtime `ddbd581`의 read-only overlay를 확인했고 실제 import는 `/opt/xgen-local-sdk`, `/opt/xgen-local-runtime`에서 이루어진다. DEX 클라이언트는 Compose 외부에서 검증했다. 환경변수 변경과 패키지 배포는 없다.

Verified actual clean source mounts and integration branches for all four Compose services, plus Workflow imports from the unreleased SDK/runtime overlays. DEX clients are verified outside Compose. No environment variable changes or package releases were made.

실제 ACTIVE 서버와 runner, VSCode OS 파일 선택, 플랫폼 간 동일 실행·메시지와 재연결/재시작 검증은 남아 있다. 이번 테스트를 이 완료 관문의 통과로 계산하지 않는다. / Actual ACTIVE-server/runner execution, the VSCode OS picker, cross-platform state agreement and reconnect/restart acceptance remain pending.

## 단계별 잔여 추정 / Estimated remaining scope

| Phase | 남은 범위 / Remaining |
| --- | ---: |
| 0 | 22% |
| 1 | 5% |
| 2 | 2% |
| 3 | 95% |
| 4 | 95% |
| 5 | 90% |
| 6 | 100% |

구현 범위의 추정치이며 테스트 커버리지나 실사용 완료율이 아니다. Phase 2의 실제 서버·플랫폼 완료 관문이 남아 있어 추정치는 유지한다. / Scope estimates, not test coverage or verified acceptance percentages; Phase 2 retains its estimate while actual server/platform gates remain open.
