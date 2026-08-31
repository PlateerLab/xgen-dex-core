# 로컬 실행 v2 — Agent-XGeny 가 이 PC 에서 도는 방식

커넥터에서 시작한 Agent-XGeny 대화는 **이 PC 의 로컬 실행 환경(사이드카)** 에서 돈다.
메모리·파일·이력·자격증명은 **서버가 관리**하고, 로컬은 실행만 맡는다. 로컬에서 돌 수
없을 때만 서버 sandbox 로 보내며, 그때도 이유를 숨기지 않는다(채팅 배지 + 진단 로그).

```
[커넥터 chatStart]
   ├─ localExec.enabled && 런타임 설치됨 && 문자열 입력 && 첨부 없음
   │     ├─ GET  /api/agentflow/geny-agent/{wf}/local-turn-context  (에이전트 설정·계정 키·관리자 설정·graph)
   │     │     ├─ 429 quota_exceeded → **차단**(status: blocked + error + end; 서버 폴백 없음)
   │     │     └─ graph.local_supported=false → 서버 폴백(graph_suppliers)
   │     ├─ 로컬 동기화 폴더 확보(LocalSyncManager.ensureSynced — 미완료면 실행은 진행 + 안내)
   │     ├─ CLI provider 면 바이너리 보장(서버 목표 버전)
   │     ├─ 사이드카 데몬에 turn(server.tls 포함) → chunk/tool/usage 이벤트 → 채팅 (status: 이 PC에서 실행)
   │     ├─ flushSync(로컬 변경 → 서버 인덱스)
   │     └─ POST /api/agentflow/geny-agent/{wf}/report-turn  (텍스트·도구 이벤트·usage·상태)
   └─ 아니면 → 서버 POST /execute/based-id/stream  + execution_target:'sandbox'
               (status: 서버에서 실행 — 사유)
```

## 폴백 사유 (status: server_sandbox) 와 차단 (status: blocked)

| reason | 뜻 | 배지 문구 |
|---|---|---|
| `runtime_missing` | 로컬 런타임 미설치/기동 불가 | 로컬 실행 런타임이 준비되지 않아 서버 sandbox 에서 실행합니다 |
| `composite_input` / `attachments` | 복합 입력 / 첨부·컬렉션(서버 RAG·스토리지) | … 서버에서 실행합니다 |
| `context_unavailable` | 서버가 local-turn-context 를 못 줌(미지원/오류) | 서버가 로컬 실행 컨텍스트를 주지 못해 … |
| `graph_suppliers` | 캔버스에서 이 에이전트에 **공급 노드**(도구·RAG 등 입력 포트)가 연결돼 있고 서버가 `graph.local_supported=false` 로 판정 — 로컬에서 재현 불가 | 캔버스 공급 노드(도구·RAG 등)는 서버에서 실행 (+ `unsupported` 포트 목록) |
| `workspace_unavailable` | 로컬 동기화 폴더 확보 불가 | 로컬 동기화 폴더를 확보하지 못해 … |
| `cli_missing` / `cli_auth_missing` | CLI 바이너리 / 서버 일원화 인증 없음 | … |
| `local_start_failed` | 첫 출력 전 실패(인증 만료 등) | 로컬 실행이 시작되지 못해 … |
| `preflight` | 서버 `local-turn-context.preflight_error` 가 문자열(vLLM 모델 미선택 / provider 비활성 / 모델 미인가 등) — 로컬에서 돌려도 같은 이유로 실패하므로 **사이드카를 시작하지 않고** 서버로(서버가 같은 안내 문구를 낸다) | 사전 점검 실패(모델 미선택·비활성·미인가) — 서버가 같은 안내 문구를 냅니다 (+ 메시지 120자) |

`local-turn-context.preflight_error`: `string | null` — 문자열이면 사전 점검 실패. 커넥터는 graph/워크스페이스 확보 **이전**에 끊고
`preflight` 로 서버 폴백한다(사이드카 미기동, report-turn 없음). null/빈 문자열 = 통과.

`local-turn-context.graph`: `{ suppliers:[{port,node_id,node_type}], shipped:[ports], unsupported:[ports], local_supported }` —
서버가 `shipped` 포트(memory 이력 등)는 옵션으로 실어 주고(`agent.memory` / `options.*` 는 커넥터가 사이드카 `options` 로 그대로
통과), `unsupported` 가 있으면 `local_supported=false`.

**차단(blocked)** — 서버 폴백이 아니다. `local-turn-context` 가 **HTTP 429** `{"detail":{"code":"quota_exceeded","message","usage","limit"}}` 를
돌려주면(사용량 한도 초과; superuser 는 면제) 커넥터는 서버에서도 같은 한도에 걸리므로 `status {surface:'blocked',
reason:'quota_exceeded', detail:<message>}` + `error <message>` + `end` 로 턴을 끝낸다(배지: **실행 차단 — 메시지**). 그 외 429 는
`context_unavailable` 폴백.

**동기화 미완료 안내** — `ensureSynced` 가 제한시간 내 하이드레이트를 못 끝내면(`synced=false`) 폴백하지 않고 로컬에서 실행하되
`status {surface:'connector_local', detail:'동기화 미완료 — 일부 파일이 아직 없을 수 있음'}` 으로 알린다(배지: 이 PC에서 실행 — 동기화 미완료 …).

## 구성요소 (설치 폴더 `<dataRoot>` = 기본 `~/xgen-dex`)

| 경로 | 내용 | 누가 만드나 |
|---|---|---|
| `local-runtime/python/` | 이식형 CPython + `xgen-agent-runtime`(사이드카 포함) | 인스톨러(NSIS 복사) / 부팅 안전망(cpSync·다운로드) |
| `local-runtime/bin/{codex,claude}[.exe]` | Codex / Claude Code CLI — **서버와 같은 버전** | 부팅 자동 설치 → 로그인 후 서버 매니페스트로 수렴 |
| `local-runtime/codex-home`, `claude-home` | CLI 격리 홈(`CODEX_HOME`/`CLAUDE_CONFIG_DIR`) — 서버 중앙 자격증명이 여기로 물질화 | 사이드카(LocalHostServices) |
| `workspace/<agent>/` | 에이전트 로컬 동기화 폴더(= 사이드카 작업 폴더) | 동기화 엔진 |

## 서버 버전 수렴 (`local-runtime-converge.ts`)

로그인 직후와 [설정 → 일반 → 서버 버전으로 맞추기] 에서
`GET /api/agentflow/geny-agent/local-runtime/manifest` 를 받아
- 런타임 wheel 버전이 다르면 설치 폴더 Python 에 `pip install --upgrade <wheel_url>` (Python 은 그대로),
- Codex / Claude Code 가 목표 버전이 아니면 공식 배포처에서 그 버전을 설치한다.
실패는 상태(lastError)로만 드러나고 기존 설치본은 보존된다(비파괴).

- **마지막 서버 매니페스트는 디스크에 영속**된다 — `<dataRoot>/local-runtime/server-manifest.json`. 부팅 시 수렴기가 이 캐시를
  복원하므로, 서버가 아직 응답하지 않았어도(미로그인/오프라인) CLI 자동 설치(`ensureCliInstalled`)는 마지막 매니페스트의
  목표 버전으로 깐다(latest 가 아니라). 서버 전환 시 캐시는 잊는다(`clearManifest`).
- **런타임 wheel 업그레이드 성공** 시 `python/RUNTIME_VERSION` 스탬프를 새 버전으로 다시 쓰고(인스톨러 재사용 판정과 같은
  파일), `onRuntimeUpgraded` 훅이 ensurer 캐시를 무효화(버전·스모크 재확인)하고 상주 사이드카를 **유휴 시점에 재기동**한다
  (진행 중 턴은 끝까지 옛 코드로 완료).
- **로그아웃 / 서버 전환**은 격리 홈의 CLI 자격증명 파일(`local-runtime/codex-home/auth.json`,
  `local-runtime/claude-home/.credentials.json`)을 지우고 상주 사이드카 데몬을 내린다 — 다음 로그인 계정의 서버 자격증명이
  다시 물질화된다(계정 간 토큰 혼입 방지).
- 설정 → 설치 → **서버 버전 맞추기 결과** 행이 마지막 실행을 보여 준다: 같은 버전이면 "런타임 서버와 동일 (3.8.0)", 업그레이드면
  "런타임 3.7.0 → 3.8.0 업그레이드", CLI 는 "Codex CLI vX 설치" 처럼 사람 문구로(`local-exec-text.ts`).

## 사이드카 데몬 (`local-agent-sidecar.ts` ↔ `xgen_agent_runtime.host.sidecar --serve`)

- 첫 턴에 기동, 유휴 15분 후 자가 종료, 앱 종료 시 내림. 기동은 `ready`, 턴은 `id` 로 상관.
- 이벤트: `started` · `chunk` · `tool`(웹과 같은 tool_call/tool_result/tool_error) · `canvas_command` ·
  `usage`(파이프라인 종료 후 1회: `{input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  total_cost_usd, model, provider}` → report-turn `usage` 로 서버 기록; 화면 표시 없음) ·
  `done` · `error` · `cancelled`. 취소는 `cancel` 명령(협조) → 유예 초과 시 데몬 강제 종료.
- turn 요청 `server: {url, token, tls:{verify}}` — `tls.verify=false` 는 커넥터 설정 "사설 인증서 허용"
  (`allowPrivateCertificate`) 과 동일 정책으로 사이드카의 서버 브릿지(메모리 RPC 등) TLS 검증을 끈다.
- 환경: `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1`, PATH 앞에 `local-runtime/bin`.

## 서버 계약 (xgen-workflow)

- `local-turn-context.settings`: `CLAUDE_CODE_AUTH_MODE`/`OAUTH_TOKEN`(setup_token 일 때), `CODEX_AUTH_MODE`/
  `CODEX_CREDENTIALS_JSON`(oauth 일 때), 기본 모델·타임아웃·예산, `GENY_TOOLS_*_ENABLED`. 커넥터가
  `CODEX_BINARY_PATH`/`CLAUDE_CODE_BINARY_PATH`/`XGEN_LOCAL_CODEX_HOME`/`XGEN_LOCAL_CLAUDE_CONFIG_DIR` 를 덮어쓴다.
- `local-turn-context.graph` / `options`(memory 이력·output_schema 등): 위 "폴백 사유" 절 참조. `agent.*` + `options.*` 는 사이드카
  `options` 로 그대로 통과하고 커넥터가 `workflow_id`/`interaction_id`/`streaming` 만 덮는다.
- `local-turn-context` 429 `quota_exceeded`: 차단(서버 폴백 없음).
- `report-turn.usage`: 사이드카 usage 이벤트 data 그대로 — 서버가 `output_data.usage` 와 토큰 컬럼(input/output)에 기록.
- `execution_target: 'sandbox'`: 커넥터 폴백 턴 — 서버는 커넥터 로컬 워크스페이스(역방향 WS) 프로브를 건너뛴다.

## 진단

- 설정 → 스토리지 → [진단 로그 복사] 의 `local-exec` 항목: 폴백 사유, 사이드카 기동/종료, 수렴 계획.
- 채팅 메시지 상단 배지: **이 PC에서 실행**(동기화 미완료 안내 포함) / **서버에서 실행 — 사유** / **실행 차단 — 메시지**.

## CLI 인증 — 서버 일원화 (개별 PC 로그인 없음)

커넥터는 Claude Code / Codex 인증을 **서버(관리자 LLM 설정)가 준 것만** 쓴다 — turn context 의 settings/api_keys:

| 도구 | 서버 인증 모드 | 커넥터 전달 | 없으면 |
|---|---|---|---|
| Claude Code | api_key | `api_keys.anthropic` | 서버에서 실행 |
| Claude Code | setup_token | `CLAUDE_CODE_OAUTH_TOKEN`(중앙 장수명 토큰) → 사이드카가 env 로 주입 | 서버에서 실행 |
| Claude Code | oauth(파드 로컬) | 전달 불가 | 서버에서 실행 |
| Codex | api_key | `api_keys.openai` | 서버에서 실행 |
| Codex | oauth | `CODEX_CREDENTIALS_JSON`(중앙 ChatGPT 자격증명) → 사이드카가 격리 `codex-home/auth.json` 에 물질화 | 서버에서 실행 |

프리플라이트(`serverCliAuth`)가 없음을 판정하면 로컬에서 시작하지 않고 `cli_auth_missing` 으로 서버 sandbox 에서
실행한다. 로컬 실행이 첫 출력 전에 죽으면(인증 만료 등) `local_start_failed` 로 역시 서버 폴백. 중앙 자격증명은
매 턴 서버 값으로 다시 물질화되므로 PC 에서 갱신된 토큰은 버려진다(서버가 진실).

## Windows 설치/부팅 진단 (설정 → 설치)

설치 섹션은 **상태 전용**(토글 없음)이며 순서는 설치 폴더 → Agent-XGeny 실행 환경 → 로컬 실행 런타임 → Codex CLI →
Claude Code CLI → CLI 인증 → 서버 버전 맞추기 결과 → (부팅 오류, 있을 때만) → 설치 로그.

- **설치 로그** 두 파일을 함께 보여 준다(꼬리 25줄 + [로그 열기]/[진단 복사]):
  - `%APPDATA%\XGEN-Connector\install.log` — 인스톨러(NSIS `XgenLog`)가 쓰는 로그(설치 시작/옵션/런타임 복사·검증 결과).
  - `<dataRoot>\install.log` — 앱이 부팅/자가치유 때 이어 쓰는 로그(`[app] boot …`, `[app] ensure: …`, `boot step X FAILED`).
- **인코딩**: NSIS `FileWrite` 는 ANSI(한국어 Windows 에선 CP949)로 쓰고 앱은 UTF-8 로 이어 쓴다. 그래서 인스톨러 메시지는
  **ASCII 만** 쓰고(`->`, `-`, 영문), 읽을 때는 줄마다 BOM→UTF-16LE / 유효 UTF-8 / EUC-KR(CP949) / latin1 순으로 판별한다
  (`data-root.readInstallLogText`). 한글 프로필 경로가 섞여도 `��` 로 깨지지 않는다.
- **런타임 후보 표시**: `설치 폴더: 설치됨 (3.8.0) · 앱 내장: 있음 (3.8.0, 미검증 — 설치 폴더 사용 중) · 서버와 동일 (3.8.0)`.
  사다리는 첫 건강한 후보에서 멈추므로 나머지는 '미검증'이며, ensure 직후 백그라운드 검증(`verifyOtherCandidates`: single-flight·
  mtime 캐시·60초 스로틀)이 '있음/손상'으로 확정한다. **'손상'은 실제 스모크 실패(healthy=false)에만** 쓴다.
- **부팅 오류** 행(있을 때만): 부팅 배선 단계(`settleDataRoot`/`wireWorkspaceManager`/`wireLocalSync`/`ensureLocalRuntime`) 예외의
  첫 줄 + 힌트 "앱을 다시 시작해도 남으면 진단 복사 후 공유". 대표 원인이었던 `Cannot find module './workspace-bridge-tools'`
  (런타임 `require('./…')` — 번들러가 해석하지 않음)는 정적 import 로 고쳤고 `test/no-local-require.test.ts` 가 재발을 막는다.

### 설치 진행 화면의 로그
- 설치 진행(INSTFILES) 페이지는 **처음부터** 상세 로그 뷰를 켠다(`build/installer.nsh` 의 `XgenInstFilesShow` —
  `MUI_PAGE_CUSTOMFUNCTION_SHOW`): `1/3 앱 파일 압축 해제`(줄 로그 없음, 진행 막대) → `2/3 로컬 실행 환경 구성`
  (런타임 복사/재사용·스모크 줄 단위) → `3/3 설치 완료`. 끝나면 표준 MUI 마침 페이지로 **자동으로** 넘어간다.
  ⚠ `SetAutoClose` 는 여기서 절대 `false` 로 두지 않는다 — MUI_PAGE_FINISH 가 `.onGUIInit` 에서 스스로
  `true` 를 걸어 INSTFILES→마침 자동 전환을 보장하는데, 여기서 덮으면 설치는 끝나지만 페이지가 안 넘어가고
  "[닫기]" 버튼만 조용히 활성화된다 — 사용자에게는 멈춘 것처럼 보인다(실기: v1.71.1, 첫 설치·Windows에서
  "log 파일 관련 화면에서 멈추고 안 넘어간다" — v1.71.2 에서 되돌림).
- 같은 내용이 `%APPDATA%\XGEN-Connector\install.log` 에도 남는다(설정 → 설치 로그).

## 설치 시 런타임 재사용

인스톨러는 `resources\python\RUNTIME_VERSION`(번들 스탬프)과 `<설치폴더>\local-runtime\python\RUNTIME_VERSION` 이
같고 import 스모크가 통과하면 **복사를 생략**한다(업데이트 때 1GB 삭제/복사 없음). 다르면 항목별 복사.
