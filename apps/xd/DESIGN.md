# XD 설계

XD 는 **서버 없이 이 PC 에서 에이전트를 돌리는** 로컬용 XGEN Dex 다. `xgen-dex-core` 안의 앱이고, Dex 와
**같은 버전으로 같은 릴리스에** 나간다.

> 이 문서는 단계마다 갱신한다. 각 단계는 "완료 기준" 을 실측으로 확인한 뒤에 닫는다.

## 1. 범위

| 한다 | 하지 않는다 |
|---|---|
| 에이전트 만들기·편집·대화(스트리밍, 작업 과정, 도구 기록) | 워크플로 실행, 캔버스 도구 |
| 에이전트마다 작업 공간 `XD/workspace/<에이전트>` + 폴더 연결 | 파일 저장소(Filestore), RAG |
| 동봉 런타임(xgen-agent-runtime)으로 이 PC 에서 실행 | 서버 로그인·Teams·앱 스토어·음성 서버 |
| LLM 제공자: Claude Code·Codex(감지·설치·로그인), API 키 | 서버의 관리자 설정·할당량 |
| 에이전트 기억(파일), 위험 명령 확인 | Jobs·WorkflowSelf·도구 만들기(ForgeTool) |

## 2. 사용자 결정 (2026-10-02)

1. **화면** — Dex 의 화면 코드(apps/desktop/src/renderer)를 공유하고, XD 에 없는 기능은 기능 스위치로 끈다.
2. **루트 폴더** — 설치 폴더(쓸 수 있으면), 아니면 `~/XD`. 설정에서 보이고 옮길 수 있다.
3. **실행 안전** — 파일 도구는 작업 공간·연결 폴더 안으로 제한, 셸은 위험 명령만 사용자에게 묻는다.
4. **제공자(v1)** — Claude Code, Codex, Anthropic, OpenAI, Gemini, OpenAI 호환(Ollama·vLLM·LM Studio).

## 3. 구조

```
apps/xd
├─ engine/                      Python — 앱에 동봉 (M1)
│   xd_engine/
│     host.py                   XdHostServices — 런타임의 HostServices 를 로컬로 구현
│     daemon.py                 상주 데몬, stdio JSON 줄(프로토콜 v1)
│     mcp_bridge.py             CLI 제공자 턴의 도구 다리(TurnToolSurface → MCP)
├─ src/main/                    Electron main
│     data-root.ts              루트 폴더 결정·구조
│     (M2~) store.ts            SQLite(node:sqlite) — 에이전트·대화·계정·설정
│     (M2~) engine-service.ts   엔진 데몬 띄우기·재시작·턴 중계
│     (M3~) providers/, cli/    제공자 계정·CLI 감지·설치·로그인
├─ src/preload/                 window.xd (XD 전용) + Dex 화면 공유용 window.xgen(부분)
└─ src/renderer/                XD 셸 — Dex 화면 부품을 가져다 쓴다
```

프로세스:

```
renderer ──IPC──▶ main ──stdio(JSON 줄)──▶ Python 엔진(xd_engine + xgen-agent-runtime)
                    │                              │
                    │                              ├─ LLM: API(HTTPS) / claude·codex CLI(자식 프로세스)
                    │                              └─ 도구: 작업 공간 파일·셸(이 PC)
                    └─ SQLite·safeStorage·CLI 설치·로그인
```

### 런타임과의 경계

- 런타임은 **고치지 않는다.** XGEN 은 "에이전트는 언제나 서버 sandbox 에서 돈다"(runtime 4.0.0, 2026-08-26)이고,
  그 원칙을 위해 런타임 안의 로컬 호스트를 지웠다. XD 의 로컬 호스트는 XD 안(`xd_engine`)에 둔다 — 런타임의
  `HostServices` 프로토콜은 바로 이런 호스트를 위해 남아 있다.
- 계약 검사 `xd-no-server`(scripts/contracts/check.mjs)가 XD 소스에 서버 클라이언트·브릿지가 들어오면 막는다.
  Dex 쪽의 "로컬 런타임 없음" 테스트(apps/desktop/test/no-local-require.test.ts)는 그대로다.

## 4. 루트 폴더

```
<루트>/
  workspace/<에이전트>/        에이전트의 작업 공간
  .xd/
    xd.db                      SQLite (M2)
    secrets/                   safeStorage 암호문 (M2)
    agents/<id>/               엔진 상태 — 기억·대화 상태·도구 결과 (M2)
    cli/claude/ · cli/codex/   CLI 바이너리·격리 홈 (M3)
    logs/
    electron/                  Electron userData — 단일 실행 잠금도 여기("루트 하나에 앱 하나")
```

결정 순서: `XD_DATA_ROOT` → 설정에서 옮긴 곳(`<appData>/XD/root.json`) → 개발 실행 `~/XD-dev` →
Windows 설치본의 설치 폴더(쓸 수 있을 때) → `~/XD`.

⚠ **Windows 제거·업데이트가 루트를 지우지 않게** — electron-builder 의 NSIS 제거기는 기본으로 설치 폴더를
통째로 지운다(`RMDir /r $INSTDIR`). 설치 폴더가 루트이므로 `customRemoveFiles` 로 앱 파일만 지우고
`workspace/`·`.xd/` 는 남겨야 한다. **XD 를 Windows 로 내보내기 전 필수**(M6, NSIS 빌드로 실검증).

## 5. 엔진 (M1)

### 로컬 호스트 — HostServices 매핑

| 런타임이 부르는 것 | XD |
|---|---|
| `make_sandbox` | `None` — 파일 도구는 LocalFS(경로 가드), Bash 는 이 PC 의 셸(Windows 는 PowerShell) |
| `agent_workspace_dir` | `<루트>/workspace/<에이전트>` |
| `hydrate_workspace`·`finalize_turn` | 할 일 없음(원본이 로컬) |
| `workspace_storage_root` | `<루트>/.xd/agents/<id>` — 도구 결과·실행 기록 |
| `environment_prompt` | 이 PC(OS·셸·작업 공간·연결 폴더) 설명 |
| `build_memory_provider` | 파일 기억(`memory/providers/file`), `<루트>/.xd/agents/<id>/memory` |
| `register_builtin_tools` | filesystem·shell·workflow(TodoWrite·ToolBatch)·web·parsing + memory 도구 |
| `build_run_tool_context` | `working_dir`=작업 공간, `allowed_paths`=작업 공간+연결 폴더 |
| `resolve_*`·`setting` | 턴마다 main 이 넘기는 제공자 설정·비밀 |
| `build_cli_runtime` | `build_cli_client`·`build_codex_cli_client` + 격리 홈 + 도구 다리(MCP) |
| `build_connector_mcp_tools`·`register_forged_tools`·`register_workflow_self_tools`·`build_job_tools` | 없음(빈 목록) — 서버 소유이거나 sandbox 가 필요 |

### 데몬 프로토콜 v1 (stdio JSON 줄)

- 명령: `ping` · `turn{id, agent, conversation, text, config}` · `cancel{id}` · `approval_reply{id, ok}` · `shutdown`
- 사건: `ready{protocol, runtime, python}` · `started` · `chunk{text}` · `tool{phase, …}` · `approval_request` ·
  `usage` · **종결 하나**: `done` | `error{code, message}` | `cancelled`
- 규칙: 턴마다 종결 사건은 정확히 하나(취소 > 실패 > 끝). 런타임은 실패를 예외가 아니라 `[ERROR]` 글로 흘리므로
  데몬이 읽어 `error` 로 바꾼다. stdout 은 프로토콜 전용 — 라이브러리 출력은 stderr 로 돌린다.

### 동봉 Python

- python-build-standalone 3.12.x `install_only_stripped`, **아키텍처마다 따로**(win-x64·mac-arm64·mac-x64·
  linux-x64). Geny 앱은 맥 두 dmg 를 arm64 하나로 묶어 x64 에 엉뚱한 인터프리터가 들어갔다.
- 런타임 wheel(GitHub 릴리스)은 `--no-deps`, 의존성은 XD 가 쓰는 것만. 서버 전용(psycopg·pgvector·
  qdrant-client 등)은 금지 목록으로 빌드를 실패시킨다. pyc 동봉(읽기 전용 설치 경로에서 매 실행 재컴파일 방지).
- 설치 크기 목표 250MB 안팎(M1 에서 실측해 정한다). 검증 게이트: import 스모크 + 데몬 `ready` + 가짜 LLM 턴.

## 6. 제공자 (M3)

- **API 키**: Anthropic·OpenAI·Gemini·OpenAI 호환(기본 주소 Ollama `http://localhost:11434/v1`·LM Studio·vLLM).
  키는 safeStorage 로 암호화해 `.xd/secrets/` 에. 모델 목록 조회·연결 테스트는 XGEN 과 같은 엔드포인트.
- **Claude Code·Codex**
  - 감지: XD 가 설치한 것(`.xd/cli/…`) → PATH → 알려진 위치 → 로그인 셸(`$SHELL -lic`). `--version` 으로 확인.
  - 설치·업데이트: 공식 배포처에서 직접 내려받고 sha256 검증(Claude: `downloads.claude.ai` manifest,
    Codex: GitHub `rust-v` 릴리스). Windows 포함 — `install.sh` 는 Windows 를 못 덮는다.
  - 로그인: `claude auth login --claudeai`·`codex login --device-auth` 를 **파이프로**(PTY 불필요). 홈은
    XD 전용으로 격리(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`, 미리 만들어 둔다).
  - 상태: Claude 는 만료돼도 `loggedIn:true` 라 만료 시각을 직접 본다. Codex 토큰은 한 번 쓰면 바뀌므로
    CLI 가 고친 `auth.json` 을 그대로 둔다(같은 홈을 로그인과 턴이 같이 쓴다).
  - 섞지 않기: 구독 로그인에 API 키·`CLAUDE_CODE_SIMPLE`·`--bare` 를 섞지 않는다. 연결 테스트와 실제 턴은
    같은 인증 해석 함수를 쓴다.
  - 도구 다리: CLI 턴의 도구는 MCP 로만 닿는다 — 런타임의 `TurnToolSurface` 를 데몬이 루프백 MCP 서버
    (`connector`)로 연다.

## 7. 저장소 (M2)

SQLite(`node:sqlite`, 네이티브 모듈 없음 — Electron 43 = Node 24):
`agents`(이름·설명·시스템 프롬프트·제공자 계정·모델·도구 묶음·기억·연결 폴더) · `conversations` · `turns`
(질문·답·작업 과정·사용량) · `accounts`(비밀 아닌 설정) · `settings`. 앞으로만 가는 마이그레이션
(`PRAGMA user_version`).

## 8. 화면 (M4)

- XD 의 화면은 XD 셸(온보딩·루트·제공자 설정) + Dex 화면 부품(채팅·작업 과정·도구 기록·파일 보기·IDE·에이전트
  상세).
- Dex 화면 코드는 `window.xgen` 을 부른다 — XD 의 preload 가 **XD 가 채울 수 있는 부분만** 같은 모양으로 열고,
  나머지 기능은 기능 스위치(capabilities)로 화면에서 감춘다. 감출 것: 서버 설정·로그인·Teams·앱 스토어·
  음성·아바타 스토어·SSH(서버)·답변 평가·가드레일·연결된 기기.

## 9. 안전 (M5)

- 파일 도구: 런타임의 경로 가드 — 작업 공간 + 연결 폴더 밖은 거부.
- 셸: 이 PC 에서 돈다(경로 가드 밖). 위험 명령(지우기·포맷·권한 변경 등)은 Dex 로컬 도구와 **같은 규칙**
  (`@dex/engine` isDangerousShellCommand)으로 판정해 사용자에게 묻는다(`approval_request`).

## 10. 릴리스 (M6)

- 버전은 하나(`scripts/version.mjs` — apps/xd 포함). 같은 릴리스 워크플로가 XD 도 만든다.
- 산출물 `XD-*`, 업데이트 채널 `xd`(`xd*.yml`) — Dex 의 `latest*.yml` 과 겹치지 않는다. Dex 맥 수동 업데이트는
  `XGen-Dex-*.dmg` 만 고른다.
- 릴리스에는 **M4 가 끝나 쓸 수 있을 때부터** XD 를 넣는다. 그 전 단계는 main 에만 쌓는다.

## 11. 단계

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| M0 | 설계·뼈대·정체성·버전/계약/CI | Dex 와 다른 정체성, 공유 화면으로 창이 뜸, 버전·계약 검사 통과 |
| M1 | 엔진·동봉 Python | 가짜 LLM 으로 도구가 든 턴이 끝까지, 종결 하나, 동봉본에서 `ready` |
| M2 | 저장소·에이전트·대화·엔진 관리 | 앱을 껐다 켜도 대화가 이어짐 |
| M3 | 제공자·CLI | 제공자별 실제 턴(계정이 있는 것) |
| M4 | 화면 | Playwright 화면 E2E |
| M5 | 폴더 연결·IDE·사용자 MCP·위험 명령 확인 | 해당 E2E |
| M6 | 3 OS 설치본·같은 릴리스·업데이트·NSIS 데이터 보존 | 설치본을 풀어 엔진 기동, 제거 후 루트 보존 |

## 12. 위험·미정

- 설치본 크기(문서 파싱 의존이 무겁다) — M1 실측.
- IDE 터미널은 네이티브 모듈(node-pty)이 필요 — 처음에는 터미널 없이.
- 서명 없음 — macOS Gatekeeper·Windows SmartScreen 안내 필요(Dex 와 같다).
- 실기기·실계정 검증은 계정이 있어야 한다 — 그 단계에서 확인을 받는다.
