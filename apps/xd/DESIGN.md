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

1. **화면** — 기본 부품만 Dex 와 공유하고, 나머지는 XD 에 맞춘 XD 전용 화면이다(같은 날 수정 — 처음 결정은 "Dex
   화면 공유 + 기능 스위치" 였다. 까닭은 §8). Dex 코드는 고치지 않는다.
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
│     mcp_bridge.py             CLI 턴의 도구 다리 — 턴 표면을 루프백 MCP 로 (M3)
│     mcp_shim.py               CLI 가 띄우는 stdio 중계 (M3)
│   bundle/                     동봉 목록 — bundle.json · requirements.in/.lock · nodeps.lock · verify.py
│   tests/                      pytest — 데몬은 실제 프로세스로 띄워 stdio 로 시험한다
├─ scripts/bundle-engine.mjs    동봉본 만들기 → engine/dist/<platform>-<arch>/python
├─ src/main/                    Electron main
│     data-root.ts              루트 폴더 결정·구조
│     store.ts                  SQLite(node:sqlite) — 에이전트·대화·턴·계정·설정 (M2)
│     secrets.ts                API 키 — safeStorage 암호 파일 (M2)
│     engine-service.ts         엔진 데몬 띄우기·재시작·턴 중계 (M2)
│     turn-runner.ts            턴: 이력·계정 → 엔진, 사건 → Dex ChatEvent, 끝나면 저장 (M2)
│     xd-api.ts                 화면이 IPC 로 부르는 일들(Electron 모름) (M2)
│     workspace-name.ts         에이전트 이름 → 작업 공간 폴더 이름 (M2)
│     cli/                      CLI 감지·설치·로그인·상태 (M3)
├─ src/shared/                  main·화면이 같이 쓰는 것 — 실패 코드 → 사람이 읽는 말 (M4)
├─ src/preload/                 window.xd (XD 전용) + 공유 마크다운의 [복사]용 window.xgen.clipboard 한 칸
└─ src/renderer/                XD 전용 화면 (M4) — Dex 와 같은 부품은 dex.ts 한 곳으로만 가져온다
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
| `build_turn_memory_llm` | 그 턴의 API 제공자 그대로(CLI 제공자는 증류를 건너뛴다 — 자동 기억 계층은 돈다) |
| `build_cli_runtime` | `build_cli_client`·`build_codex_cli_client` + XD 전용 홈 + 도구 다리(MCP) — §6. 턴 설정에 `cli{binary, home, auth}` 가 없으면 `bad_request` |
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

계정 종류: `anthropic` · `openai` · `google` · `ollama` · `lmstudio` · `openai_compatible`(vLLM 등, 주소 필수) ·
`claude_code` · `codex`. 런타임 제공자로는 그대로, OpenAI 호환은 `vllm`(=custom 프로필), Ollama·LM Studio 는 런타임의
전용 프로필(도구 지원·기본 주소)이다.

### API 키 제공자

- 키는 safeStorage 로 `.xd/secrets/` 에(§7). Ollama·LM Studio·OpenAI 호환은 키 없이도 된다.
- **모델 목록 = 연결 시험** — 엔진의 `models` 명령이 런타임의 `discover_models`(XGEN 과 같은 코드)로 묻는다
  (Anthropic `/v1/models`, OpenAI·호환 `/models`, Gemini `/v1beta/models`, Ollama `/api/tags`). 실패는 예외가 아니라
  `ok:false` 와 까닭. 저장 전에도 시험할 수 있다(`modelsProbe`, 키를 저장하지 않는다).

### Claude Code·Codex

- **감지**: XD 가 설치한 것(`.xd/cli/<이름>/bin`) → PATH(로그인 셸로 보강) → 알려진 자리. `--version` 이 판을 내야 쓴다.
- **설치·업데이트**: 공식 배포처에서 실행 파일 하나를 직접 받고 sha256 을 확인한다(설치 스크립트를 돌리지 않는다 —
  사용자 셸 설정을 고치지 않고, Windows 도 같은 길). 받은 파일이 이 PC 에서 `--version` 을 내야 바꿔 끼운다(실패하면
  쓰던 판이 남는다).
  - Claude Code: `downloads.claude.ai/claude-code-releases/{stable}` → 판 → `{판}/manifest.json` 의
    `platforms[darwin-arm64|darwin-x64|linux-x64|win32-x64].checksum` → `{판}/<플랫폼>/claude(.exe)` (약 240MB).
  - Codex: GitHub `openai/codex` 최신 릴리스(`rust-v<판>`) — 자산 sha256 은 API 의 `digest`. 맥·리눅스는
    `codex-<삼중항>.tar.gz`, Windows 는 `codex-<삼중항>.exe` 그대로 (약 110MB).
  - 실측(2026-10-02, 리눅스): Codex 0.160.0·Claude Code 2.1.285 를 받아 확인·설치.
- **로그인**: XD 전용 홈(`CLAUDE_CONFIG_DIR`·`CODEX_HOME` = `.xd/cli/<이름>/home`)에서, **파이프로**(PTY 없음).
  사용자의 `~/.claude`·`~/.codex` 는 쓰지 않는다 — 그쪽의 훅·플러그인·MCP·지시가 턴에 섞이고, 한 번 쓰면 바뀌는
  토큰을 두 곳이 나눠 쓰면 한쪽이 끊긴다. 그래서 XD 에서 따로 한 번 로그인한다.
  - Claude: `claude auth login --claudeai` → 주소 → 브라우저가 보여 준 코드를 stdin 으로(코드를 쓰고 잠시 뒤 Enter —
    붙여넣기로 보고 Enter 를 버리는 판이 있다). 잘못된 코드는 기다리지 않고 실패로. 상태 `claude auth status --json`.
  - Codex: `codex login --device-auth` → 주소·일회용 코드 → 사용자가 마치면 스스로 끝난다. 상태 `codex login status`
    (로그인 안 됐어도 종료 0 — 글을 읽는다).
  - 끝났다고 다 된 것이 아니다 — 그 홈에서 상태를 다시 물어 확인한다. 로그인·상태에는 키·`CLAUDE_CODE_SIMPLE`·
    `CLAUDE_CODE_OAUTH_TOKEN` 을 넣지 않는다(2026-09-09 XGEN 사고).
  - CLI 마다 홈이 하나 — 같은 CLI 계정을 여럿 만들어도 같은 로그인을 쓴다(v1).
- **인증 방식**: 계정 설정 `auth` = `oauth`(구독 로그인, 키 없음) | `api_key`(이 계정의 키). 키 방식에서만 주소(base
  URL)가 뜻이 있다 — Anthropic·OpenAI 호환 게이트웨이(사내 프록시·LiteLLM). Claude 는 `ANTHROPIC_BASE_URL`, Codex 는
  사용자 지정 제공자(`-c model_provider=xd_gateway`).
- **모델**: Claude Code 는 판에 상관없는 별칭(sonnet·opus·haiku). Codex 는 홈의 `models_cache.json`(보이는 것만) —
  없으면 이름을 직접 쓴다.
- **도구 다리** (엔진 `mcp_bridge.py` + `mcp_shim.py`): 런타임의 턴 도구 표면(`TurnToolSurface`)을 엔진 안 루프백
  HTTP(토큰)로 열고, CLI 가 stdio 중계(표준 라이브러리만, 파일 경로로 실행)로 붙는다 — XGEN 서버 브릿지와 같은
  메서드·응답·동작(요청마다 스레드, 알림 무응답, 목록이 바뀌면 `list_changed` 후 재조회까지 호출 응답을 붙듦 —
  Claude 3초·Codex 0). Windows 는 중계를 창 없는 `pythonw.exe` 로.
  - Claude: `--settings {"permissions":{"allow":["mcp__connector"]}}` + `--allowedTools mcp__connector`(`--print` 에서
    도구마다 묻지 않게), `ENABLE_TOOL_SEARCH=false`(우리 표면이 이미 계층을 가진다), 네이티브는 런타임이 전부 끈다.
  - Codex: 네이티브는 런타임이 끈다(`host_tools_only`), 남는 것은 끌 수 없는 MCP 리소스 조회 셋과
    `request_user_input`(exec 에서 "지원 안 함")뿐 — 시험이 확인한다.
- **실측(2026-10-02)**: 실제 claude 2.1.285·codex 0.160.0 + 가짜 모델(키 없음)로, 앱 전체 경로(main → 엔진 → CLI →
  XD 도구 다리 → 작업 공간)에서 턴이 돈다. CI 는 앱 설치기로 두 CLI 를 받아 같은 E2E 를 돌리고, 엔진 잡도 실제 CLI 로
  CLI 턴 시험을 돈다.
- **Windows**: 런타임 4.83.3 — CLI 를 창 없이(`CREATE_NO_WINDOW`) 띄우고 `taskkill /T` 로 트리째 끝낸다.

### 남은 확인 (실제 계정)

키·구독 로그인으로 하는 실제 턴은 계정이 있어야 한다 — 사용자 확인을 받아 한다(M3 완료 기준).

## 7. 저장소 (M2)

SQLite(`node:sqlite`, 네이티브 모듈 없음 — Electron 43 = Node 24.18, SQLite 3.53), `<루트>/.xd/xd.db`, WAL.

- `agents`(이름·설명·시스템 프롬프트·계정·모델·작업 공간 이름·연결 폴더·기억·옵션) · `conversations` · `turns`
  (질문·첨부·답·작업 과정·사용량·상태·오류) · `accounts`(비밀 아닌 설정) · `settings`.
- 마이그레이션은 앞으로만(`PRAGMA user_version`). 더 새 판 XD 가 쓴 DB 는 열지 않는다(앱을 내렸을 때 망가뜨리지
  않게).
- 앱이 턴 도중 꺼지면 다음 시작 때 그 턴을 `interrupted` 로 끝낸다(영원히 "실행 중" 으로 남지 않게).
- 작업 공간 이름은 에이전트를 만들 때 이름에서 정하고(엔진 규칙과 같은 검사, 겹치면 ` (2)`, 디스크에 남은 폴더도
  피한다) 이름을 바꿔도 그대로다. 에이전트를 지우면 엔진 상태(`.xd/agents/<id>`)만 지우고 작업 공간은 남긴다.
  대화를 지우면 그 대화의 기록(STM)도 지운다.
- 대화 id 는 부르는 쪽이 줄 수 있다 — Dex 화면은 대화 id 를 스스로 만든다(`conn-<에이전트>-<시각>`).
- 작업 과정은 Dex 의 `HistoryFlowItem`(`{kind:'text'|'tool', …, at}`) 그대로 — 지난 턴도 같은 타임라인으로 그린다.
- 엔진에 넘기는 이력: 답이 있는 끝난 턴만, 끝에서 50개.
- 비밀: `.xd/secrets/<계정 id>.bin` 을 safeStorage 로 암호화. 쓸 수 없으면(리눅스 키링 없음·`basic_text`) 파일
  권한만으로 두고 `secretsStatus` 가 그 사실을 알린다. 다른 PC 로 옮긴 루트의 키는 풀리지 않는다 — 다시 입력.

### 턴 (M2)

- main 의 턴 실행기가 엔진 사건을 Dex 화면의 `ChatEvent` 로 바꿔 내보낸다(`@dex/protocol` 의
  `turnEventToChatEvent` 그대로): 글 → `text`, 도구 → `tool`, 끝·취소 → `end`, 실패 → `error`(+`XgenErrorInfo`).
- 엔진에 가기 전에 아는 실패(계정·키·모델 없음, 아직 못 쓰는 제공자)는 엔진을 깨우지 않고 그 까닭으로 끝난다.
  제공자의 실패 글은 Dex 와 같은 분류기(`describeStreamError`)로 사람이 읽는 말로.
- 대화 하나에 턴 하나 — 도는 중에 같은 대화로 보내면 거절하고 기록하지 않는다.
- 위험 명령 확인 창은 Dex 데스크톱과 같은 문구·버튼(`@dex/engine/dangerous-commands`): 거부가 기본값·Esc,
  "이 대화에서 계속" 은 그 대화에만.
- 끌 때는 엔진이 도는 턴을 취소로 마무리하고(저장까지) 저장소를 닫은 뒤에 끝난다. 엔진이 죽으면 도는 턴은
  `engine_exited` 로 끝나고 다음 턴에 다시 뜬다. 엔진은 창 없이, 로그인 셸의 PATH 로(`@dex/engine/exec-resolve`).

## 8. 화면 (M4)

### 결정: 기본은 공유, 나머지는 XD 전용 (2026-10-02 수정)

처음에는 Dex 화면을 통째로 쓰고 기능 스위치로 감추려 했다. 조사해 보니 맞지 않았다.

- Dex 화면에는 **기능 스위치 장치가 없다.** 감추기는 흩어진 조건(옵셔널 체이닝·돌려받은 값·설정 값)뿐이다.
- 채팅 경로에서 **없으면 바로 깨지는** 호출이 많다: `guardrails.*`·`overlay.pushState`·`quickChat.onQuickSend`·
  `config.get/onChange/set`·`chatFolders.list/remote/on*`·`chat.stream/stop`·`history.turns/snapshot`,
  에이전트 목록의 `agents.list`·`history.conversations`.
- 서버 전제(로그인·서버 주소·사용자 id·Teams·알림 계정·`ioId`/피드백·원격 실행 모델)가 App·Workspace 에 박혀 있다.

통째로 쓰려면 Dex 화면 곳곳에 XD 조건을 넣어야 하고, 그러면 Dex 가 바뀐다. 그래서 **기본 부품만 공유**하고
화면의 짜임(셸·채팅·에이전트·제공자·설정)은 XD 가 따로 짓는다.

| 공유 (Dex 코드 그대로) | XD 전용 |
|---|---|
| `Markdown`·`ProcessTimeline`(작업 과정)·`Tooltip`·아이콘 | 셸(활동 막대·사이드바)·첫 화면 |
| CSS: `@dex/ide/ide.css`·Dex `styles.css`·`process-timeline.css` (채팅 마크업 `chat-log`·`msg-row`·`bubble` 같은 이름을 그대로 써서 모양이 같다) | 채팅 화면(턴 저장소 + 도는 턴), 에이전트 편집, 제공자(API 키·Claude Code·Codex 설치·로그인), 설정 |
| `@dex/protocol` — `ChatEvent`·`HistoryFlowItem` 모양, `describeStreamError`, `INTERRUPTED_TEXT` | 실패 코드 문구 `src/shared/error-info.ts`(XD 에만 있는 까닭: 계정·키·CLI 없음 등) |

규칙:

- 화면이 Dex 부품을 가져오는 곳은 **`src/renderer/src/dex.ts` 한 곳**(CSS 는 `main.tsx`). 다른 파일은
  `apps/desktop` 을 직접 가져오지 않는다.
- 공유 부품은 `window.xgen` 에 기대지 않는 것만 고른다. 예외는 마크다운의 [복사] 하나 — preload 가
  `window.xgen.clipboard` 한 칸만 같은 모양으로 연다(없어도 브라우저 클립보드로 간다).
- Dex 의 파일은 고치지 않는다. Dex 부품이 바뀌면 XD 는 그대로 따라간다 — CI 의 XD 잡이 Dex 쪽 변경에도 돈다.

### 화면

- **셸** — 활동 막대(대화·AI 제공자·설정) + 사이드바(에이전트 → 고른 에이전트의 대화) + 본문.
- **첫 화면** — 제공자 연결 → 에이전트 만들기 두 걸음.
- **채팅** — 지난 턴은 저장소에서, 도는 턴은 `live-store`(사건 구독 하나)에서 그린다. 도구를 쓴 답은 작업
  과정 타임라인, 아니면 마크다운. 정지한 답은 Dex 와 같은 "작업이 중단되었습니다". 실패는 Dex 와 같은 실패
  블록(제목·설명·코드). 끝난 턴은 저장소에서 다시 읽힐 때까지 그 모습을 붙들어 깜박이지 않는다.
- **에이전트** — 이름·설명·제공자·모델(그 제공자에게 물은 목록, 없으면 직접 입력)·지시·도구 묶음(파일·명령
  실행·웹·문서 읽기 → 엔진 설정 `GENY_TOOLS_<묶음>_ENABLED`)·기억·연결 폴더.
- **AI 제공자** — API 키·로컬 서버 계정(연결 확인=모델 목록), Claude Code·Codex 카드(상태·설치/업데이트·
  로그인·로그아웃). 설치·로그인의 진행은 main(`CliService`)이 들고 있어 화면을 떠났다 와도 이어 보이고(같은 설치를
  두 번 받지 않는다), 로그인이 끝나면 main 이 그 CLI 계정을 하나만 만든다(`cliAccountEnsure`).
- **보내기** — 보내기 대답을 기다리는 동안(CLI 를 처음 찾느라 몇 초) 다시 보내지 못하고, 그 사이 다른 대화로
  옮기면 끌고 오지 않는다. 엔진이 처음 뜨는 동안 누른 [정지]도 듣는다(엔진에 보내지 않고 취소로 끝낸다).
- **문구** — 한 문장, 내부 글(영어 원문·코드) 없이. main 의 실패 글은 `errorText` 가 아는 까닭만 풀고 나머지는
  화면이 준 문장으로(원문은 개발자 콘솔). 실패 블록의 코드 칩은 Dex 와 같은 모양이라 그대로 둔다.
- **설정** — 루트·작업 공간 폴더, 키 보관 상태, 엔진 상태, 판.
- 창: 새 창은 열지 않고 https 링크만 브라우저로, 창 안 이동은 막는다.

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
- **M4** (2026-10-03) — 화면. 기본 부품만 Dex 와 공유하고 나머지는 XD 전용(§8). 완료 기준 실측(실제 Electron 43 +
  동봉 엔진 + 가짜 LLM, 모든 단계를 화면 조작으로): 첫 실행 → 제공자 추가 → 에이전트 → 대화(작업 과정·표) →
  껐다 켜도 이어짐, 정지 → 중단, 제공자 없음 → 까닭, CLI 카드, 가짜 claude 로 로그인(떠났다 와도 이어짐·계정 하나).
  독립 검토로 찾아 고친 것: CLI 계정 중복 생성, 보내기 중 두 번 보내기, 엔진 기동 중 정지 무시, 새 대화 첫 답
  깜박임, 제공자 바꿔도 모델이 남음, 화면 이탈 후 설치·로그인 상태 잃음, 문구(두 문장·영어 원문·암호화 문구).
  Dex 파일 변경 0, 공유 규칙은 시험으로 고정(`renderer-sharing.test.ts`). XD 단위 시험 70개, E2E 7개.
- **M3** (2026-10-02, 코드) — 제공자·CLI: 계정 종류 8개, 모델 목록=연결 시험(엔진), Claude Code·Codex 감지·설치(공식
  배포처·sha256)·로그인(파이프)·상태·로그아웃, CLI 턴의 도구 다리. 실측: 실제 CLI 로 앱 전체 경로 턴(가짜 모델), 실제
  배포처에서 설치. 찾아 고친 것: 런타임 4.83.3(Windows CLI 창·트리 종료). **실제 계정 턴은 확인 대기.**
- **M2** (2026-10-02) — 저장소·에이전트·대화·턴·엔진 관리. 완료 기준 실측(E2E, 실제 Electron 43 + 동봉 엔진 +
  가짜 LLM): 턴이 작업 공간에 파일을 만들고, 앱을 껐다 켜도 에이전트·대화·턴(답·작업 과정)이 그대로이며, 다음 턴에
  앞 대화가 이력으로 엔진까지 간다(요청 메시지 수 1·3 → 3·5). 위험 명령은 Dex 와 같은 확인 창을 거치고 거부하면
  실행되지 않는다. XD 단위 시험 45개(Node 22·24), CI `xd-app` 잡(Node 24·E2E).
- **M1** (2026-10-02) — 엔진·동봉 Python. 완료 기준 실측: 가짜 LLM 으로 도구가 든 턴이 끝까지(Write·Bash·문서 4종),
  종결 하나, 동봉본에서 `ready` 0.2~0.3초. 엔진 시험 73개를 동봉 인터프리터로 — 리눅스·맥 전부, 윈도우는 POSIX 전용 3개를 뺀 전부(CI). 동봉본 크기: linux-x64 242MB · win32-x64 222MB · darwin-arm64 225MB. 찾아 고친 것: 런타임
  호스트 경로 Bash 가 취소·시간 초과 때 자식을 남기던 것(runtime 4.83.1), Windows 에서 명령마다 콘솔 창이
  뜨던 것(4.83.2).

## 12. 위험·미정

- 설치본 크기(문서 파싱 의존이 무겁다) — M1 실측.
- IDE 터미널은 네이티브 모듈(node-pty)이 필요 — 처음에는 터미널 없이.
- 서명 없음 — macOS Gatekeeper·Windows SmartScreen 안내 필요(Dex 와 같다).
- 실기기·실계정 검증은 계정이 있어야 한다 — 그 단계에서 확인을 받는다.
- Finder·시작 메뉴에서 켠 앱은 로그인 셸의 PATH 를 모른다(맥은 `/usr/bin:/bin` 정도) — 엔진을 로그인 셸의
  PATH 로 띄운다(M2, Dex 의 exec-resolve). 실제 맥에서 켠 앱으로는 M6 설치본에서 확인한다.
- (M6) 맥 동봉 인터프리터·확장 모듈의 서명·공증, Gatekeeper 격리 속성.
- (M3) Windows 에서 CLI(claude·codex)도 콘솔 프로그램이다 — 창 없는 엔진이 띄우면 창이 뜨는지 런타임 CLI
  클라이언트의 생성 플래그를 확인한다(Bash 는 4.83.2 에서 막았다).
