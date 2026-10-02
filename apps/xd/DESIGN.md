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
│     protocol.py               stdout 떼어 내기·사건 내보내기·명령 읽기
│     layout.py                 루트 구조·이름 검사(data-root.ts 와 같은 모양)
│     safety.py                 위험 명령 확인(규칙은 main 이 Dex 것을 넘긴다)·셸 도구 감싸기
│     memory_llm.py             턴 끝 기억 증류용 LLM
│     testing.py                시험용 가짜 LLM(xd_fake) — 환경 변수가 있을 때만
│     (M3) mcp_bridge.py        CLI 제공자 턴의 도구 다리(TurnToolSurface → MCP)
│   bundle/                     동봉 목록 — bundle.json · requirements.in/.lock · nodeps.lock · verify.py
│   tests/                      pytest — 데몬은 실제 프로세스로 띄워 stdio 로 시험한다
├─ scripts/bundle-engine.mjs    동봉본 만들기 → engine/dist/<platform>-<arch>/python
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
| `agent_workspace_dir` | `<루트>/workspace/<작업 공간 이름>` — 이름은 main 이 정하고 엔진이 한 칸짜리 이름인지 다시 본다 |
| `hydrate_workspace` | `None`("복원 개념 없음" — 실행기가 False 와 구분한다) · `finalize_turn` 할 일 없음(원본이 로컬) |
| `workspace_storage_root` | `<루트>/.xd/agents/<id>` — 도구 결과(`executor/`)·기억(`memory/`) |
| `environment_prompt` | 이 PC(OS·셸·작업 폴더·연결 폴더) — "서버도 sandbox 도 없다, 실제로 일어난다" |
| `build_memory_provider` | 파일 기억(서버 file 백엔드와 같은 composite): `memory/vault` 에이전트당 하나, `memory/sessions/<대화>` |
| `register_builtin_tools` | web·parsing·workflow(TodoWrite·ToolBatch)·filesystem·shell. Bash 는 감싸서 위험 명령 확인을 지나고 설명을 "이 PC" 로 바꾼다(`to_api_format` 까지). 끄기: `GENY_TOOLS_<묶음>_ENABLED` |
| `build_run_tool_context` | `working_dir`=작업 공간, `allowed_paths`=작업 공간+연결 폴더, `extras[host_is_execution_target]` |
| `resolve_*`·`setting` | 턴마다 main 이 넘기는 값만 — **환경 변수를 읽지 않는다**(사용자 셸 환경이 턴을 바꾸지 않게). 다른 제공자의 키를 물으면 빈 값 |
| `build_turn_memory_llm` | 그 턴의 API 제공자 그대로(CLI 제공자는 M3) |
| `build_cli_runtime` | (M3) `build_cli_client`·`build_codex_cli_client` + 격리 홈 + 도구 다리(MCP). 그 전에는 턴을 시작하지 않고 `bad_request` |
| `build_connector_mcp_tools`·`register_forged_tools`·`register_workflow_self_tools`·`build_job_tools`·`build_host_skill_tools`·`load_ssh_servers`·`rag_context_builder` | 없음 — 서버 소유이거나 sandbox 가 필요. 자기 워크플로 편집은 `enable_self_evolution=False` 로 끈다 |

### 데몬 프로토콜 v1 (stdio JSON 줄)

띄우기: `<python> -I -m xd_engine --root <루트>` — `-I` 로 사용자의 `PYTHONPATH`·`PYTHONHOME`·사용자 site 를 무시한다.

- 명령
  - `ping{id?}` → `pong`
  - `configure{dangerous: [{source, flags}]}` → `configured{dangerous: n}` — 위험 명령 규칙(§9)
  - `turn{id, conversation, text, history?, agent{id, name, workspace, system_prompt?, folders?, memory?}, config{provider, model, api_key?, base_url?, credentials?, settings?, temperature?, max_tokens?, max_iterations?, thinking?, context_window?, tool_exposure?, enable_compaction?, memory_distill?}}`
  - `cancel{id}` · `approval_reply{id, request, answer: once | session | deny}` · `shutdown`
- 사건
  - `ready{protocol, runtime, python, platform, root}` — 루트를 쓸 수 없으면 대신 `fatal{message}` 후 종료(2)
  - 턴: `started` · `chunk{text}` · `tool{event}`(tool_call·tool_result·tool_error) · `progress{event}` · `usage{usage}` ·
    `approval_request{request, command}` · **종결 하나**: `done` | `error{code, message}` | `cancelled`
  - 턴 밖: `protocol_error{message}` — 깨진 줄·모르는 명령·틀린 규칙·없는 승인. 데몬은 계속 돈다.
- 오류 코드: `bad_request`(이름·경로·제공자·키 — 턴을 시작하지 않는다) · `busy`(그 대화에 도는 턴이 있다) ·
  `runtime`(제공자·파이프라인 실패) · `start`(조립 실패) · `E104` 등(런타임의 실행 전 검사) · `internal`
- 규칙
  - 턴마다 종결 사건은 정확히 하나(취소 > 실패 > 끝). 런타임은 실패를 예외가 아니라 `[ERROR]` 글로 흘리므로 데몬이
    읽어 `error` 로 바꾸고 `chunk` 로는 내보내지 않는다(스트림 도중의 실패는 줄바꿈이 앞에 붙은 조각 하나다).
  - 대화 하나에 도는 턴은 하나. 대화가 다르면 동시에 돈다.
  - 취소는 기다리던 승인도 거부로 끝낸다. `shutdown`(또는 stdin 닫힘)은 도는 턴을 모두 취소하고 정리를 기다린다.
  - stdout 은 프로토콜 전용 — 시작할 때 fd 1 을 stderr 로 돌려 라이브러리·자식 프로세스 출력이 섞이지 않는다.
- 취소된 셸 명령은 자식까지 끝난다 — 런타임 4.83.1(호스트 경로 Bash 가 프로세스 그룹째 종료. 그 전에는 고아로 남았다). Windows 는 셸을 창 없이 띄운다(4.83.2 — 창 없는 엔진이 띄운 PowerShell 이 명령마다 콘솔 창을 만들었다).
- 시험용 가짜 LLM: `XD_ENGINE_FAKE_LLM=<각본.json>` 이면 제공자 `xd_fake` 가 등록된다(앱은 설정하지 않는다).

### 동봉 Python

- python-build-standalone 3.12.15(20261001) `install_only_stripped`, **아키텍처마다 따로**(win-x64·mac-arm64·
  mac-x64·linux-x64), 압축본 sha256 고정. Geny 앱은 맥 두 dmg 를 arm64 하나로 묶어 x64 에 엉뚱한 인터프리터가
  들어갔다. 동봉본은 그 아키텍처에서 만든다 — 패키지 설치를 그 인터프리터가 직접 한다.
- 설치는 잠금 그대로: `pip install --no-deps --require-hashes --only-binary=:all:`
  - `requirements.lock` — `uv pip compile --universal --generate-hashes` (플랫폼 표지 포함, 85개). 판은 런타임·
    문서 파서가 선언한 판(서버와 같은 조합). 네 대상 모두 바이너리 wheel 만으로 설치됨을 확인했다(2026-10-02).
    cryptography 50 은 Intel 맥 wheel 이 없어 그 자리만 48.0.1.
  - `nodeps.lock` — 런타임 wheel(GitHub 릴리스)·xgen-doc2chunk·xgen-pdf 를 의존성 없이. 이들이 선언한 서버 전용
    의존성(psycopg·pgvector·qdrant-client·asyncssh·croniter·langchain-community·langgraph…)은 넣지 않는다.
  - 선언됐지만 넣지 않는 것: numpy·pandas(모듈 수준에서 쓰는 곳이 없다 — 표를 DataFrame 으로 바꾸는 선택 기능뿐),
    tiktoken(런타임이 자체 추정기로 바꿨다). 셋이 동봉본의 3분의 1이었다.
  - 금지 목록(bundle.json `forbidden`)에 걸리면 검증이 실패한다.
- 걷어 내기: tcl/tk·idle·ensurepip·pip·헤더·패키지 안의 `tests` 폴더·zstandard 의 중복 백엔드, 리눅스는 쓰이지
  않는 `libpython3.12.so`(인터프리터가 정적으로 품는다 — 확장 모듈 67개가 요구하지 않음을 확인).
- pyc: `compileall --invalidation-mode unchecked-hash` — 읽기 전용 설치 폴더에서도 매번 다시 컴파일하지 않는다.
  pyc 를 만들 수 없는 옛 파일(olefile2.py)만 건너뛰고, 그 밖의 실패는 빌드를 멈춘다.
- 크기(linux-x64 실측): **242MB**(gzip 84MB) — 인터프리터 94MB + site-packages 190MB(pyc 포함), 걷어 낸 것 60MB.
- 검증 게이트(`bundle/verify.py`, 동봉 인터프리터로): 금지 목록 → import → 데몬 `ready`(0.2초) → 가짜 LLM 턴
  (Write·Bash·ParseDocument 로 docx·xlsx·pptx·pdf 를 그 자리에서 만들어 읽기) → 종결 하나. CI 는 세 OS 에서
  동봉본을 만들어 이 검증과 엔진 시험 전체를 그 인터프리터로 돌린다(`xd-engine` 잡).
- hwp 는 로컬 견본으로만 확인했다(저장소에 넣을 수 있는 견본이 없다).

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

## 9. 안전 (엔진은 M1, 확인 창은 M4·M5)

- 파일 도구: 런타임의 경로 가드 — 작업 공간 + 연결 폴더 밖은 거부.
- 셸: 이 PC 에서 돈다(경로 가드 밖). 위험 명령(지우기·포맷·권한 변경 등)은 Dex 로컬 도구와 **같은 규칙**
  (`@dex/engine` DANGEROUS_PATTERNS)으로 판정해 사용자에게 묻는다(`approval_request`).
  - 규칙은 사본을 두지 않는다 — main 이 Dex 규칙의 RegExp `source`·`flags` 를 `configure` 로 넘긴다. 엔진 시험이
    같은 글자를 node 와 파이썬에 돌려 판정표(규칙 15개 × 명령 25개)가 같은지 본다.
  - 규칙을 받기 전에는 **모든** 셸 명령을 묻는다. 물을 수 없거나(창이 없다) 모르는 대답이면 거부.
  - 대답: 한 번 · 이 대화에서 계속(엔진이 대화 id 로 기억 — Dex 와 같다) · 거부. 거부는 런타임이 알아보는
    `user_denied` 결과로 돌아가 같은 턴에 같은 일을 다른 방법으로 다시 하지 않는다.
  - ToolBatch 로 부른 셸도 같은 문을 지난다(시험으로 확인).
- 연결 폴더는 있는 폴더의 실제 경로만, `.xd`(데이터베이스·암호문) 안은 받지 않는다(심볼릭 링크로 돌아와도).

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
| M5 | 폴더 연결·IDE·사용자 MCP·위험 명령 확인 창 | 해당 E2E |
| M6 | 3 OS 설치본·같은 릴리스·업데이트·NSIS 데이터 보존 | 설치본을 풀어 엔진 기동, 제거 후 루트 보존 |

### 진행

- **M0** (2026-10-02, PR #160) — 설계·뼈대·정체성·버전/계약/CI.
- **M1** (2026-10-02) — 엔진·동봉 Python. 완료 기준 실측: 가짜 LLM 으로 도구가 든 턴이 끝까지(Write·Bash·문서 4종),
  종결 하나, 동봉본(linux-x64)에서 `ready` 0.2초. 엔진 시험 72개를 동봉 인터프리터로 통과. 찾아 고친 것: 런타임
  호스트 경로 Bash 가 취소·시간 초과 때 자식을 남기던 것(runtime 4.83.1), Windows 에서 명령마다 콘솔 창이
  뜨던 것(4.83.2).

## 12. 위험·미정

- 설치본 크기(문서 파싱 의존이 무겁다) — M1 실측.
- IDE 터미널은 네이티브 모듈(node-pty)이 필요 — 처음에는 터미널 없이.
- 서명 없음 — macOS Gatekeeper·Windows SmartScreen 안내 필요(Dex 와 같다).
- 실기기·실계정 검증은 계정이 있어야 한다 — 그 단계에서 확인을 받는다.
- (M2) Finder·시작 메뉴에서 켠 앱은 로그인 셸의 PATH 를 모른다(맥은 `/usr/bin:/bin` 정도) — 엔진을 띄울 때 로그인
  셸의 PATH 를 넘겨야 에이전트의 셸이 사용자의 `node`·`brew`·`git` 을 찾는다.
- (M6) 맥 동봉 인터프리터·확장 모듈의 서명·공증, Gatekeeper 격리 속성.
- (M3) Windows 에서 CLI(claude·codex)도 콘솔 프로그램이다 — 창 없는 엔진이 띄우면 창이 뜨는지 런타임 CLI
  클라이언트의 생성 플래그를 확인한다(Bash 는 4.83.2 에서 막았다).
