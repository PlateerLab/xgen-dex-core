# Canonical 첨부 참조 계약 / Canonical attachment reference contract

## 현재 구현 범위 / Current boundary

이 계약은 Canonical Agent Session의 **단계형 업로드와 턴 참조**를 정의한다. Protocol client는 예약, raw byte 업로드, receipt 조회, 취소를 제공하며 턴 요청은 선택적인 첨부 참조를 받는다. 다운로드와 첨부 UI는 이 계약의 범위가 아니다. Legacy workspace 업로드를 자동으로 대신 호출하지 않는다.

This contract defines **staged upload and turn references** for Canonical Agent Sessions. The protocol client reserves, uploads raw bytes, reads receipts and cancels reservations; turn requests accept optional attachment references. Download and attachment UI are outside this contract. There is no automatic legacy workspace fallback.

## 데이터 / Data

Scope는 검증된 로그인과 선택 세션에서 얻는다. Receipt는 향후 서버가 저장을 완료한 첨부의 응답 형식이다. 이를 파싱했다는 사실은 발급·소유권·접근권한·실제 bytes의 checksum을 검증했다는 뜻이 아니다. 서버는 Gateway가 검증한 principal로 저장된 첨부의 계정·세션·workflow와 실제 checksum을 다시 검사해야 한다.

Scope comes from the authenticated login and selected session. A receipt describes a future server-committed attachment. Shape validation cannot prove issuance, ownership, access or the checksum of stored bytes. The server must independently verify these against the Gateway-verified principal and stored attachment before execution.

| 필드 / Field | 타입 / Type | 제약과 용도 / Constraint and use |
|---|---|---|
| `origin` | string | 정규 HTTPS origin, 경로·사용자정보·query·fragment 없음. 소문자 ASCII DNS (`xn--` IDN 제외), canonical IPv4/IPv6; 포트 1..65535, 기본 443 생략. / Canonical HTTPS origin; ASCII DNS excluding IDN A-labels, or canonical IP; no paths, credentials, query or fragment. |
| `user_id` | string | `1`..`9223372036854775807`의 정규 십진 문자열. 앞의 0·숫자 coercion 없음. / Positive canonical decimal string, no numeric coercion. |
| `session_id` | string | 서버 발급 Canonical 세션의 소문자 UUID, version 1..8, RFC variant. / Lowercase canonical session UUID. |
| `workflow_id` | string | 원문 Unicode / Raw Unicode, UTF-8 1..128 bytes, slash/backslash·C0/C1·방향 제어 문자 없음. / Bounded Unicode identifier; no paths or control characters. |
| `attachment_id` | string | 서버가 발급할 opaque 소문자 UUID, version 1..8, RFC variant. 클라이언트가 저장 경로를 선택하지 않는다. / Opaque server-issued UUID; no client storage path. |
| `filename` | string | 원문 Unicode / Raw Unicode basename, UTF-8 1..255 bytes; slash/backslash·C0/C1·방향 제어 문자와 `.`/`..` 금지. 저장 경로로 사용하지 않는다. / Display basename, never a storage path. |
| `size_bytes` | integer | 0..104857600, bool·문자열·소수 coercion 없음. / Strict integer, 0..100 MiB. |
| `media_type` | string | 소문자 `type/subtype` 토큰, 최대255 ASCII bytes, parameter 없음. 표시 메타데이터이며 이미지 검증 결과가 아니다. / Inert MIME hint, not verified file content. |
| `sha256` | string | 소문자 64자리 hex. 실제 파일의 서버 checksum과 일치해야 한다. / Lowercase 64-character hex; must match stored server checksum. |

- Scope에는 첫 4개 필드만 있고 receipt에는 표의 9개 필드만 있다. 추가 필드는 거부한다.
- 턴 참조에는 `attachment_id`, `sha256`만 있다. 경로·URL·base64·bytes·권한/신뢰 주장·표시 힌트를 전달하지 않는다.
- 최대10개, 파일당100 MiB, 합계100 MiB이다. 중복 ID는 checksum이 같아도 거부하며 순서는 유지한다. 이 상한은 현재 서버의 허용 업로드 정책을 선언하지 않는다. 실제 업로드 및 이미지 sniffing/decoder 제한은 서버 구현에서 별도로 적용해야 한다.
- TypeScript는 새 primitive-only 객체와 배열을 freeze한다. Python은 frozen 모델과 tuple을 반환한다. 원본 receipt 목록을 수정해도 준비된 참조는 바뀌지 않는다.
- 계정·origin·세션·workflow가 바뀌면 draft와 준비된 참조를 폐기한다. 응답 유실 후 재시도는 원래 참조의 **순서·ID·checksum**을 유지해야 하며, 후속 턴 저널 구현이 이를 idempotency hash에 포함해야 한다.

IDN A-labels are reserved until both languages share an IDNA normalization contract. Scopes accept only their four fields; receipts accept only the nine fields above. Turn references contain only `attachment_id` and `sha256`. Up to ten ordered, unique IDs are accepted, with 100 MiB per-file and aggregate caps. These local caps do not authorize arbitrary content; server content sniffing, image decoder and storage policies remain separate. Results are copied and frozen (TypeScript objects/array, Python models/tuple). Scope changes must discard prepared drafts. Journal hashing and explicit unknown-outcome reconciliation preserve the exact ordered ID/checksum list. An omitted or empty reference list uses the existing text-only wire shape.

Unicode 원문은 정규화하지 않고 code point와 UTF-8 상한을 그대로 보존한다. 서버에서 얻은 workflow와 정확한 문자열로 비교하므로 NFC/NFD 표현이 다르면 scope도 다르다. 런타임별 Unicode 정규화 테이블에 의존하지 않는다. / Unicode metadata is preserved verbatim without normalization; distinct NFC/NFD workflow strings remain distinct scope values.

## 제공 함수 / Helpers

| DEX protocol | Python SDK | 동작 / Behavior |
|---|---|---|
| `parseAgentAttachmentScope(value)` | `parse_attachment_scope(value)` | Scope를 엄격히 검사하고 복사한다. / Validate and copy context. |
| `parseAgentAttachmentReceipt(value, scope)` | `parse_attachment_receipt(value, scope)` | 전체 구조·범위·scope 동등성을 검사한다. / Validate receipt and exact scope match. |
| `prepareAgentAttachmentReferences(receipts, scope)` | `prepare_attachment_references(receipts, scope)` | 중복·개수·합계 제한을 검사하고 불변 참조 목록을 만든다. / Prepare immutable ordered references. |
| `validateReserveAgentAttachment(scope, metadata)` | — | 예약 metadata를 동기 검증하고 불변 복사한다. / Validate and freeze reservation metadata before authentication. |
| `validateAgentAttachmentId(value)` | — | URL과 참조에 쓰기 전 canonical UUID를 검사한다. / Validate a canonical UUID before URL/reference use. |

Python 모델은 `AgentAttachmentScope`, `AgentAttachmentReceipt`, `AgentAttachmentReference`이다. TypeScript는 같은 이름의 interface와 단계형 네트워크 client를 제공한다. helper 실패는 원시 입력을 포함하지 않는 `AgentAttachmentValidationError`를 반환한다.

Both implementations expose the same named scope, receipt and reference models. Helper failures produce a generic `AgentAttachmentValidationError` without raw input. TypeScript additionally exposes `ReserveAgentAttachmentInput`, `ReservedAgentAttachment` and the staged transport client described below.

## 단계형 API / Staged API

`AgentSessionAttachmentClient(origin, proof, fetch?)`는 각 호출마다 ACTIVE Platform access token과 요청 method/전체 URL에 대한 DPoP proof를 새로 얻는다. Cookie, legacy token, redirect, retry를 사용하지 않는다. `scope`는 로그인·선택 세션을 관리하는 host가 공급하고 client origin과 정확히 일치해야 한다. Scope 필드는 body나 query에 보내지 않으며 서버 receipt를 검증하는 데 사용한다.

`AgentSessionAttachmentClient(origin, proof, fetch?)` obtains a fresh ACTIVE Platform access token and a DPoP proof for the exact method and URL on every call. It sends no cookies or legacy credentials and performs no redirects, fallback or retry. The host supplies `scope` from its authenticated account and selected session; its origin must exactly match the client. Scope fields never enter a body or query and instead bind server receipts.

| 메서드 / Method | HTTP | 성공 / Success |
|---|---|---|
| `reserveAttachment(scope, metadata, signal?)` | `POST /api/agentflow/agent-sessions/{sid}/attachments` JSON | `201` `{attachment_id,status,expires_at}` |
| `uploadAttachment(scope, id, metadata, bytes, signal?)` | `PUT /api/agentflow/agent-sessions/{sid}/attachments/{id}/content` | `200` 9-field receipt |
| `readReceipt(scope, id, signal?)` | `GET /api/agentflow/agent-sessions/{sid}/attachments/{id}` | `200` 9-field receipt |
| `cancelAttachment(scope, id, signal?)` | `POST /api/agentflow/agent-sessions/{sid}/attachments/{id}/cancel` | `204` |

예약 metadata는 `upload_key`(printable ASCII 1..128), `filename`, `size_bytes`, `media_type`, `sha256`만 허용한다. 같은 세션에서 같은 key와 같은 metadata의 예약은 서버가 같은 reservation을 반환할 수 있다. 다른 metadata에 key를 재사용하면 거부된다. 예약 응답의 `status`는 `reserved | uploading | ready`이다.

Reservation metadata contains only `upload_key` (1..128 printable ASCII), `filename`, `size_bytes`, `media_type` and `sha256`. The server may return the same reservation for the same key and metadata in one session. Reusing a key with different metadata is rejected. Reservation status is `reserved | uploading | ready`.

업로드는 입력 `Uint8Array`를 credential 조회 전에 복사하고 길이와 SHA-256을 metadata와 비교한다. 따라서 호출자가 원본 배열을 나중에 바꿔도 전송 body는 바뀌지 않는다. PUT은 `application/octet-stream`과 복사본의 정확한 `Content-Length`를 사용한다. 브라우저가 금지 header를 관리하는 경우 fetch가 고정 길이 typed-array body에서 같은 길이를 설정한다. 성공 receipt는 scope, ID, filename, size, media type, SHA가 모두 예약 의도와 일치해야 한다. 경로, file URL, multipart form 또는 base64 body를 받지 않는다.

Upload copies the input `Uint8Array` before credential lookup and compares its length and SHA-256 with metadata. Later caller mutation cannot change the transmitted body. PUT uses `application/octet-stream` and the copied byte length as `Content-Length`; where browsers manage the forbidden header, fetch derives the same length from the fixed typed-array body. A successful receipt must match scope, ID, filename, size, media type and SHA. Paths, file URLs, multipart forms and base64 bodies are never accepted.

## 결과 불명과 복구 / Unknown outcomes and recovery

각 write는 한 번만 전송된다. Dispatch 전 입력·credential·proof 실패는 서버 write가 아니다. Dispatch 뒤 transport 유실, 호출자 취소, redirect, HTTP 408, 5xx, 예상하지 않은 success status, malformed/과대 응답은 `AgentAttachmentOutcomeUnknown`이다. 오류에는 raw token, path, body가 들어가지 않으며 관찰된 HTTP status가 있으면 보존한다. 그 외 명시적인 4xx는 `AgentAttachmentHttpError(status)`이다.

Every write is sent once. Input, credential or proof failure before dispatch is not a server write. After dispatch, transport loss, caller cancellation, redirect, HTTP 408, 5xx, unexpected success status, or malformed/oversized acknowledgement raises `AgentAttachmentOutcomeUnknown`. Errors never include raw tokens, paths or bodies, and retain an observed HTTP status. Other explicit 4xx responses raise `AgentAttachmentHttpError(status)`.

PUT acknowledgement가 유실되면 같은 PUT을 자동 또는 즉시 반복하지 않는다. 같은 scope와 attachment ID로 `readReceipt`를 명시적으로 호출한다. 일치하는 ready receipt만 완료 증거다. 404/409/410이나 GET 실패는 bytes가 commit되지 않았다는 증거가 아니므로 host가 사용자에게 상태를 제시하고 새 write를 결정해야 한다. `cancelAttachment`도 upload/cleanup과 경합할 수 있는 write이므로 결과 불명일 때 성공으로 가정하지 않는다.

After a lost PUT acknowledgement, do not automatically or immediately repeat the PUT. Explicitly call `readReceipt` with the same scope and attachment ID. Only a matching ready receipt proves completion. A 404/409/410 or failed GET does not prove that bytes never committed; the host must expose the state and decide any new write. Cancellation can race upload and cleanup and is itself a write, so an unknown cancellation is not assumed successful.

JSON 응답은 64 KiB로 제한되고 UTF-8과 구조를 엄격히 검사한다. Host는 `AbortSignal`에 업로드/조회 deadline을 부여해야 한다. Signal 이후 client는 응답 대기를 끝내고 stream을 취소한다. 이미 dispatch한 write는 취소 시에도 결과 불명이다. 계정, origin, session 또는 workflow가 바뀌면 예약과 준비된 참조를 폐기한다.

JSON responses are capped at 64 KiB and strictly checked for UTF-8 and shape. Hosts supply upload/read deadlines through `AbortSignal`; after it fires the client stops waiting and cancels the response stream. A write already dispatched remains unknown after cancellation. Account, origin, session or workflow changes discard reservations and prepared references.
