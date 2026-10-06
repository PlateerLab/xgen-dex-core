# Canonical 첨부 참조 계약 / Canonical attachment reference contract

## 현재 구현 범위 / Current boundary

이 계약은 Canonical 업로드·턴 연결을 위한 **메타데이터 검증 기반**이다. 아직 업로드 API, 저장소, 저널 연결, 다운로드 또는 첨부 UI를 제공하지 않는다. 현재 Canonical 턴 API는 텍스트 전용이며 `attachments`를 거부한다. Legacy workspace 업로드를 자동으로 대신 호출하지 않는다.

This is the metadata validation foundation for future Canonical upload and turn linking. Upload/storage/journal/download/UI integration is not implemented. Current Canonical turn requests remain text-only and reject `attachments`; no legacy workspace fallback is enabled.

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
- 미래 턴 참조에는 `attachment_id`, `sha256`만 있다. 경로·URL·base64·bytes·권한/신뢰 주장·표시 힌트를 전달하지 않는다.
- 최대10개, 파일당100 MiB, 합계100 MiB이다. 중복 ID는 checksum이 같아도 거부하며 순서는 유지한다. 이 상한은 현재 서버의 허용 업로드 정책을 선언하지 않는다. 실제 업로드 및 이미지 sniffing/decoder 제한은 서버 구현에서 별도로 적용해야 한다.
- TypeScript는 새 primitive-only 객체와 배열을 freeze한다. Python은 frozen 모델과 tuple을 반환한다. 원본 receipt 목록을 수정해도 준비된 참조는 바뀌지 않는다.
- 계정·origin·세션·workflow가 바뀌면 draft와 준비된 참조를 폐기한다. 응답 유실 후 재시도는 원래 참조의 **순서·ID·checksum**을 유지해야 하며, 후속 턴 저널 구현이 이를 idempotency hash에 포함해야 한다.

IDN A-labels are reserved until both languages share an IDNA normalization contract. Scopes accept only their four fields; receipts accept only the nine fields above. Future turn references contain only `attachment_id` and `sha256`. Up to ten ordered, unique IDs are accepted, with 100 MiB per-file and aggregate caps. These local caps do not authorize uploads; server content sniffing, image decoder and storage policies remain separate. Results are copied and frozen (TypeScript objects/array, Python models/tuple). Scope changes must discard prepared drafts. Future journal hashing and explicit unknown-outcome retries must preserve the exact ordered ID/checksum list.

Unicode 원문은 정규화하지 않고 code point와 UTF-8 상한을 그대로 보존한다. 서버에서 얻은 workflow와 정확한 문자열로 비교하므로 NFC/NFD 표현이 다르면 scope도 다르다. 런타임별 Unicode 정규화 테이블에 의존하지 않는다. / Unicode metadata is preserved verbatim without normalization; distinct NFC/NFD workflow strings remain distinct scope values.

## 제공 함수 / Helpers

| DEX protocol | Python SDK | 동작 / Behavior |
|---|---|---|
| `parseAgentAttachmentScope(value)` | `parse_attachment_scope(value)` | Scope를 엄격히 검사하고 복사한다. / Validate and copy context. |
| `parseAgentAttachmentReceipt(value, scope)` | `parse_attachment_receipt(value, scope)` | 전체 구조·범위·scope 동등성을 검사한다. / Validate receipt and exact scope match. |
| `prepareAgentAttachmentReferences(receipts, scope)` | `prepare_attachment_references(receipts, scope)` | 중복·개수·합계 제한을 검사하고 불변 참조 목록을 만든다. / Prepare immutable ordered references. |

Python 모델은 `AgentAttachmentScope`, `AgentAttachmentReceipt`, `AgentAttachmentReference`이다. TypeScript는 같은 이름의 interface를 제공한다. helper 실패는 원시 입력을 포함하지 않는 `AgentAttachmentValidationError`를 반환한다. 현재 endpoint는 이 모델을 수용하지 않으며 SDK는 네트워크 요청을 수행하지 않는다.

Both implementations expose the same named models/interfaces. Helper failures produce a generic `AgentAttachmentValidationError` without raw input. The current endpoint does not accept these models and the SDK performs no network requests.

## 다음 연결 순서 / Next integration steps

1. 서버 소유권·durable storage·checksum을 검증하는 Canonical 업로드와 정리/보존 정책.
2. 첨부 참조를 정확한 순서로 턴 request hash와 저널에 묶고 원자적으로 예약하는 계약.
3. 검증된 내부 실행 전달 및 안전한 다운로드/완료 메시지 projection.
4. Native host의 동일 인증 lock·scope 폐기·명시적 원본 재시도와 각 클라이언트 UI.
5. 실제 ACTIVE Gateway와 pod 재시작·계정 변경·cross-surface 파일 송신 검증.

Implement server-owned durable upload and retention first, then ordered journal/hash binding, verified execution/download projection, native/UI integration and actual ACTIVE cross-surface/pod recovery checks. The pure contract tests do not replace these gates.
