# Desktop Canonical 첨부 연결 / Desktop canonical attachment integration

## 구현 / Implementation

메인 프로세스의 명시적 파일 선택을 Canonical native host 첨부 API에 연결했다. 설정과 실제 공유 대화 입력 영역에 선택 목록·업로드·영수증 복구·취소를 표시한다. 렌더러에는 경로·원문 bytes·토큰을 전달하지 않고 불투명 선택 ID와 표시 메타데이터만 제공한다.

Explicit main-process file selection connects to the canonical native attachment API. Settings and the shared conversation composer show selection, upload, receipt recovery and cancellation. The renderer receives opaque selection IDs and display metadata, never local paths, original bytes or credentials.

- `native/pick-attachments`: 신뢰된 호스트 선택기만 파일을 공급한다. 추가 선택에 기존 draft를 제외한 남은 개수·bytes 한도를 전달하고 호스트에서 다시 검증한다. / Only the trusted host picker supplies files. Additional selection receives the remaining retained-draft budget, rechecked by the host.
- `native/attachments`, `native/upload-attachment`, `native/recover-attachment`, `native/cancel-attachment`, `native/discard-attachments`: 계정·정확한 HTTPS origin·로그인 소유권·Agent Session·workflow에 묶인다. / Operations bind to account, exact HTTPS origin, private login ownership, Agent Session and workflow.
- 예약 키는 선택별로 고정된다. PUT 결과 불명은 영수증 GET으로 복구한다. 예약 응답이 사라지면 같은 예약 키로 명시적으로 재확인하며 자동 PUT 재전송은 없다. / Reservation keys remain stable per selection. Unknown PUT outcomes recover through receipt GET; lost reservation ACKs permit explicit same-key reservation recovery without automatic PUT retransmission.
- 선택한 모든 영수증이 검증된 ready 상태일 때만 턴을 제출한다. 원문·CAS·idempotency key·origin ID·첨부 순서를 보존한다. 취소 후 원래 턴 재시도에도 원래 로그인 소유권 검증을 유지한다. / Turns require every selected receipt to be validated and ready. Original text, CAS, idempotency key, origin ID and ordered references survive retries, including private login binding after cancellation.
- 계정·origin·대화 범위 변경 및 성공 접수 후 draft bytes를 제거한다. 늦게 도착한 성공과 실패 응답은 삭제된 화면 상태를 복원하지 않는다. / Scope changes and accepted turns destroy draft bytes; late successful and failed responses cannot restore cleared UI state.

## 파일 및 메모리 경계 / File and memory boundaries

선택은 최대 10개, 호스트에 보관하는 원본 draft bytes의 합계는 100 MiB다. 파일별 크기도 100 MiB 이내다. 일반 파일만 허용하며 최종 경로의 심볼릭 링크·파일 변경·비정상 이름·취소를 검증한다. 로컬 파일 오류는 경로가 없는 메시지로 변환한다.

Selection is limited to ten files, with at most 100 MiB of original draft bytes retained by the host and 100 MiB per file. Only regular files are accepted; final-component symlinks, file changes, invalid names and cancellation are checked. Filesystem errors are replaced with path-free messages.

100 MiB는 프로세스 전체 RSS 상한이 아니다. 업로드 시 각 계층의 방어 복사와 HTTP 전송에 추가 메모리가 필요하며 업로드는 하나씩 처리한다. 선택기 소유 버퍼와 완료된 업로드 복사는 덮어쓴다. 취소 후에도 transport가 bytes를 읽는 동안은 그 복사를 유지하고 transport 종료 후 덮어쓴다. 메모리 덮어쓰기는 런타임·OS 내부 복사 제거를 보장하지 않는다. 전체 스트리밍 전송과 RSS 제한은 후속 작업이다.

The 100 MiB limit is not a process RSS ceiling. Defensive copies and HTTP transmission require additional memory, with uploads serialized. Owned picker buffers and completed upload copies are overwritten; a copy still consumed by transport survives cancellation until that transport settles. Overwriting cannot guarantee removal of runtime or OS copies. Full streaming and an RSS ceiling remain follow-up work.

## 검증 / Verification

- 작업 브랜치 / Branch: `feat/cross-platform-desktop-attachments`; 통합 기준 / integration baseline: `ea02f8042b608461aa780487583f025385680868`.
- Root workspace 타입·회귀·빌드, Desktop renderer/main 타입·전체 회귀·빌드, 계약 검사 통과. / Root workspace types, regressions and builds; Desktop renderer/main types, regressions and builds; contract checks passed.
- 실제 localhost HTTPS에서 P-256 DPoP 서명·Cookie 없는 원문 PUT·lost PUT ACK의 영수증 복구·같은 순서/CAS/key의 턴 재시도·ACK 후 draft 제거를 검증했다. 인증과 Canonical 응답은 테스트 서버 fixture다. / Actual localhost HTTPS verifies P-256 DPoP, cookie-free binary PUT, receipt recovery after a lost PUT ACK, exact ordered/CAS/key turn retry and draft release. Authentication and canonical responses are test-server fixtures.
- 실제 Electron 화면의 수동 파일 선택, ACTIVE Gateway 성공 경로, 원격 runner의 첨부 사용 및 다섯 플랫폼 간 실사용 검증은 미완료다. / Manual file selection in Electron, an actual ACTIVE Gateway success path, remote runner attachment use and five-platform acceptance remain unverified.

Compose는 `xgen-infra/compose/full-stack/docker-compose.dev.yml`의 `workflow`·`frontend` 프로필을 유지했다. Core `cae4094`, Gateway `2181a77`, Workflow `cd5876d`, Frontend `939604d`의 통합 브랜치와 실제 소스 mount를 확인했다. Gateway는 `enrollment` 모드다. 미배포 SDK `0c5e853`와 runtime `ddbd581`은 Workflow의 `/opt/xgen-local-sdk`, `/opt/xgen-local-runtime` 소스 overlay에서 import한다. DEX는 Compose 외부 클라이언트다.

Compose retains the `workflow` and `frontend` profiles. Integration source mounts were checked for Core `cae4094`, Gateway `2181a77`, Workflow `cd5876d` and Frontend `939604d`; Gateway remains in `enrollment` mode. Unreleased SDK `0c5e853` and runtime `ddbd581` import from Workflow source overlays at `/opt/xgen-local-sdk` and `/opt/xgen-local-runtime`. DEX is a client outside Compose.

환경변수 추가·변경·삭제와 패키지 배포는 없다. / No environment variables changed and no packages were released.

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

구현 범위의 추정치이며 테스트 커버리지나 실사용 완료율이 아니다. Phase 2는 실제 ACTIVE 서버와 플랫폼 검증 관문이 남아 있다.

These are scope estimates, not test coverage or verified acceptance percentages. Phase 2 still requires actual ACTIVE-server and platform acceptance gates.
