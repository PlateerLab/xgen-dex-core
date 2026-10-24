# 에이전트 브라우저 작업 속도 — BO 진입 100초 분석과 개선

2026-10-24 KST 시작. 10/23 데모 영상(`데모_수정.mov`)에서 "bo.x2bee.com 들어가서 로그인하고 상품등록 화면까지"가 약 100초 걸린 문제를 DeX와 서버 하네스(XGeny: xgen-workflow + xgen-agent-runtime)를 같이 놓고 본다. 사이트별 분기는 넣지 않고, 모든 브라우저 작업에 듣는 범용 수정만 한다.

기준 코드: DeX develop `245f334`, xgen-workflow develop `5e52aa44`, xgen-agent-runtime `v4.100.0`(develop 이 쓰는 휠). **푸시·병합·배포하지 않음.**

## 먼저 볼 핵심

- 하네스가 한 턴에 더하는 고정 대기는 없다(sleep·폴링·루프 안 DB 쓰기 없음). 100초는 거의 **"LLM 호출 수 × 약 3초 + 기기 도구 시간"** 이다. 줄일 곳은 한 턴의 군살이 아니라 **턴 수와 도구 대기**다.
- 도구 대기: BrowserNavigate 가 페이지의 모든 리소스(load)를 끝까지 기다려 25.2초, 이어서 15.2초 만에 실패했다 → 0단계에서 수정.
- 턴 수: 서버 안내문(BrowserGuide)에 **BrowserFill·BrowserFormValues 가 빠져** 있어 모델이 로그인 칸을 BrowserInteract 로 하나씩 채웠다. 실패하면 서버가 사유를 지워 모델이 고칠 정보가 없었다 → 1단계에서 수정.
- 남은 큰 몫은 에이전트 지침이다(브라우저를 열기 전 엑셀 재읽기·복사 실패 26초, 메뉴를 눌러 찾아가기). 지침 제안은 아래 "에이전트 지침 제안".

## 영상의 도구 18회 (OCR 로 다시 셈)

모델은 OpenRouter `Qwen3.8 Flash`, 생각 끄기. 도구 사이 간격은 2.5~7초(LLM 호출 + 하네스).

| # | 도구 | 시간 | 원인 | 범용 수정 |
|---|---|---|---|---|
| 1 | BrowserGuide | 2ms | 브라우저 도구가 문 뒤에 접혀 있어 메시지마다 처음 한 번 열어야 한다 | (3단계 후보) 첫 화면 노출 — 위험 있어 보류 |
| 2–7 | UserPc·명령 실행 6회 | 각 0.1~0.4초, 실패 2 | 폴더·엑셀 다시 읽기, 샌드박스 복사 실패 | 에이전트 지침 |
| 8–9 | BrowserTabs 2회 | 26·22ms | 탭 목록·공유 탭 만들기 | (필요한 호출 — 손대지 않음) |
| 10 | BrowserNavigate | **25.2초** | load(모든 하위 리소스)까지 기다림 | **0단계** |
| 11 | BrowserSnapshot | 59ms | Navigate 결과에 화면이 없어 따로 봐야 함 | 2단계 |
| 12–14 | BrowserInteract 3회 | 69~88ms | 아이디·비밀번호·로그인을 하나씩. 안내문에 BrowserFill 없음, 여러 호출을 한 응답에 내라는 안내 없음 | **1단계** |
| 15 | BrowserNavigate 실패 | **15.2초** | 로드 중 페이지가 주소를 옮겨 ERR_ABORTED. 모델은 "Connector MCP tool execution failed" 만 받음 | **0단계**, **1단계** |
| 16 | BrowserSnapshot | 7.7초 | 원인 미상(실행 기록 필요) | — |
| 17 | BrowserInteract | 157ms | 메뉴 클릭으로 상품등록 찾아가기 | 에이전트 지침 |
| 18 | BrowserSnapshot | 142ms | Interact 결과에 화면이 없음 | 2단계 |

## 한 턴의 구조 (하네스 코드로 확인)

반복 1회 = Stage 9 Parse → 10 Tool → 16 Loop → 2 Context → 3 System → 4 Guard → 5 Cache → 6 API (`rt/core/pipeline.py:3044-3167`).

- 첫 LLM 호출 전 계획 단계·AgentRouter 같은 별도 LLM 호출은 지금 경로에 없다. 메시지당 한 번 준비 작업(쿼터·카탈로그·메모리 검색 상한 10초 등)만 있다.
- 도구 왕복: 런타임 → 브리지(`controller/tools/connectorMcpWebSocket.py`, `event.wait()`) → WS → DeX `mcp-bridge.ts` → 도구 → 결과. 다른 파드면 Redis 중계. sleep·폴링 없음.
- 실행 기록은 메모리에 모았다가 턴 끝에 한 번 쓴다(`agent_traces` 1건 + `agent_trace_spans` N건).
- 한 응답에 tool_call 여러 개를 받으면 **응답 순서대로 차례로** 실행한다(기기 도구는 동시 실행 안 함) — 브라우저에는 맞는 동작.
- OpenRouter 경로는 `cache_control` 을 안 붙이고 upstream 자동 접두 캐시에만 기댄다. 실제 적중은 `agent_traces.metadata.usage.cache_read_tokens` 로 봐야 한다.
- 옛 BrowserSnapshot 결과는 접히지 않고 매 호출 다시 보내진다 → 반복마다 입력이 커진다(2단계에서 같이 다룸).

턴을 LLM/하네스/도구로 쪼개 보려면: `GET /api/agentflow/trace/by-interaction/{interaction_id}` → 다음 tool_call 의 `started_at` − 직전 tool_output 의 `finished_at` = LLM 1회 + 하네스. LLM 호출별 시간은 geny 경로에서 기록되지 않는다(`agent_geny.py:2490`).

## 0단계 — DeX: Navigate 가 느린 리소스 하나를 끝까지 기다리지 않는다 (완료)

- 브랜치 `fix/browser-navigate-ready`, 커밋 `54b419f1`. 파일 `apps/desktop/src/main/browser-runtime.ts`(`loadUntilReady`), 테스트 `apps/desktop/test/browser-security.test.ts`.
- 바뀐 것: goto 가 `contents.loadURL()`(load 까지, 시간 제한 없음) 대신 **새 문서의 dom-ready 뒤 load 를 2초만 더** 기다린다. 페이지가 스스로 주소를 옮긴 ERR_ABORTED 는 실패로 보지 않고 옮겨 간 문서를 최대 15초 기다린다. 주소를 못 찾는 등 다른 오류는 그대로 실패.
- 실측(dev 앱): 20초 걸리는 이미지가 있는 페이지 Navigate 20,027ms → 2,009ms. 로드 중 주소가 바뀌는 페이지 ERR_ABORTED 실패 → 2,009ms 성공. BO 이동은 이 맥에서 원래도 0.3~0.8초라 그대로.
- 테스트 27개 통과(새 4개: 느린 리소스, 이전 문서의 dom-ready 무시, 스스로 이동, 진짜 오류).
- 남은 위험: load 를 덜 기다리므로 늦게 그려지는 SPA 는 Navigate 직후 Snapshot 이 얇을 수 있다(357자 사례, 수정 전에도 있던 경합). 영상 당시 어느 리소스가 늦었는지는 그 맥에서만 알 수 있다 — 재현되면 바로 설정의 진단 로그를 복사(앱 메모리에만 남음).

## 1단계 — 하네스: 안내문에 브라우저 도구 전부 + 실패 코드 안내 (코드 완료, 서버 반영 전)

xgen-workflow 브랜치 `fix/connector-browser-guide`, 커밋 `f2110196` (develop `5e52aa44` 기준).

1. **브라우저 도구 판정을 접두 규칙으로** (`service/connector_mcp/injector.py`)
   - 전: 손으로 적은 6종 목록 `CONNECTOR_BROWSER_TOOL_NAMES`. DeX 가 광고하는 8종 중 BrowserFill·BrowserFormValues 가 안내문에서 빠졌다(도구 자체는 문의 접두 규칙으로 열렸지만 모델은 지도만 보고 고른다).
   - 후: `is_connector_browser_tool()` — `local` 서버의 `Browser*` 전부(문 `BrowserGuide` 제외). 런타임 문 표(`tools.gates` 의 BrowserGuide 가족)와 같은 규칙이라 DeX 가 도구를 늘려도 어긋나지 않는다. 미리보기 화면(`editor/geny_bridge/basic_info.py`)도 같은 판정을 쓴다.
2. **안내문** (`_browser_guide_text`)
   - 도구 설명은 첫 문장만(최대 200자). DeX 설명은 한 줄로 길게 온다(BrowserFill 은 수천 자) — 전문은 문이 연 도구 스키마에 있다.
   - 추가 문구: 오류 뒤에는 같은 호출을 되풀이하지 말 것, browser_stale_ref 면 새 스냅샷.
   - BrowserFill 이 광고될 때만: "공유 탭의 폼은 칸마다 BrowserInteract 말고 BrowserFill 한 번에(칸당 한 step). 값만 채운다 — 버튼·이동은 BrowserInteract/Navigate."
   - 같은 스냅샷의 여러 칸 입력은 한 응답에 여러 호출로(차례로 실행), 버튼은 그 결과를 본 뒤 따로.
   - 바꾸지 않은 것: "Usual order: BrowserTabs → …". 탭 목록 생략을 권하면 page_id 없는 호출이 사용자에게 안 보이는 백그라운드 탭으로 가고, BrowserFill 은 공유 탭이 필요해서 오히려 되돌아오는 턴이 생길 수 있다.
3. **실패 사유** (`service/connector_mcp/device_errors.py`, `connectorMcpWebSocket.py` `handle_result`)
   - 전: DeX 가 보낸 실패 원문을 전부 "Connector MCP tool execution failed" 로 바꿈(로컬 경로·명령 출력 유출 방지).
   - 후: 원문은 여전히 버리고, **맨 앞의 알려진 코드만** 서버가 쓴 문구로 바꾼다. 코드는 DeX 의 `browser_stale_ref / browser_no_page / browser_page_not_found / browser_timeout / browser_disabled / browser_denied`(`BrowserRuntimeError`)와 `[LOCAL_TIMEOUT]`(`LocalDeadlineError`). 예: `Connector MCP tool execution failed — browser_stale_ref: the element handles are from an older state of the page. Take a new BrowserSnapshot …`. 모르는 코드·코드 없음은 예전과 똑같이 머리말만.
   - 서버만 바뀌므로 **이미 설치된 DeX 에도 바로 적용**된다.
   - 한계: `browser_denied` 는 DeX 에서 여러 사유(인자 오류, 단계 대기, 확인 창 거부 등)를 묶은 코드라 문구가 일반적이다. 사용자 거부를 런타임 denial_guard 로 보내려면 DeX 가 `user_denied:` 코드를 보내야 한다(별도 작업).
4. 테스트: 커넥터 관련 33개 통과(새 7개 — 늘어난 도구가 지도에 오름, BrowserFill 안내 조건, 첫 문장만, 판정, 코드 → 문구, LOCAL_TIMEOUT, 원문 미노출). 전체 테스트의 실패 목록은 develop `5e52aa44` 와 같다(DB·외부 서비스가 없는 환경이라 원래 실패하는 384건).
5. 실제 DeX 도구 설명(develop `245f334` 의 `browserToolSchemas()`)으로 만든 안내문은 2,102자, 8개 도구가 모두 오른다. 렌더 결과:

```text
Tools:
  - mcp_local_BrowserTabs — Manage XGEN browser pages on the user desktop.
  - mcp_local_BrowserNavigate — Navigate one XGEN browser page: goto/back/forward/reload/stop/wait.
  - mcp_local_BrowserSnapshot — Return the accessibility snapshot and fresh @eN refs for a page.
  - mcp_local_BrowserInteract — Interact with a page using refs from BrowserSnapshot: click/fill/type/keypress/select/check/uncheck/hover/drag/scroll/mouse.
  - mcp_local_BrowserCapture — Capture screenshot/full screenshot/PDF or inspect console/page errors.
  - mcp_local_BrowserAdvanced — Advanced browser controls: cookies, storage, upload/download, ...
  - mcp_local_BrowserFill — Fill many fields of a form on a shared browser tab fast — pass that tab's page_id (BrowserTabs list, mode shared); it is brought to the front while filling.
  - mcp_local_BrowserFormValues — Read every field of the form on a page: field label, current value, ...

Usual order: BrowserTabs (what is open) → BrowserNavigate (go) → BrowserSnapshot (...) → BrowserInteract (...).
Element handles come from a snapshot — never guess a selector. After browser_stale_ref take a new snapshot; after any error, change something instead of repeating the identical call.
Forms: put all the fields of a form on a shared tab into ONE BrowserFill call (one step per field) instead of one BrowserInteract per field. It fills values only — buttons and going to another page stay with BrowserInteract / BrowserNavigate.
Typing into several fields of the same snapshot can go out as several calls in one response (they run in order); press a button in a separate step after you see those results.
BrowserCapture takes a screenshot; BrowserAdvanced is the escape hatch.
```

6. 남은 확인: 서버(dev)에 반영한 뒤 같은 요청으로 BrowserFill 선택·한 응답 다중 호출·오류 뒤 행동이 실제로 바뀌는지 측정.

## 2단계 — 계획: 조작 결과에 화면 요약 + 옛 스냅샷 접기

- DeX: BrowserNavigate(goto/back/reload)·BrowserInteract(click/press/select) 결과에 조작 후 짧은 interactive 스냅샷과 generation 을 붙인다(글자 상한). → 영상 11·18번 같은 "보기만 하는" 턴이 빠진다.
- 하네스: 같은 page_id 의 옛 스냅샷을 요청 사본에서 한 줄로 접는다(원본 기록은 그대로). → 결과가 커진 만큼 입력이 늘지 않게.
- 둘은 짝이다. 접는 순간 캐시 접두가 한 번 깨지므로 `cache_read_tokens` 로 실측해 판단한다.

## 3단계 — 측정 뒤 판단

- BrowserInteract 에 동작 배열(fill, fill, click) 받기 — 중간 실패 처리 필요.
- connector 대화에서 브라우저 핵심 도구를 문 없이 첫 화면에 노출 — 메시지당 1턴 줄지만 모든 호출의 고정 접두가 커지고, 09/09 "안내만 100회" 사고 이력이 있다.

## 에이전트 지침 제안 (BO 상품 등록 에이전트, 사이트 전용)

범용 수정과 별개로 이 에이전트의 system_prompt 에 넣을 문장. 영상 기준 도구 18회 → 5회 안팎.

1. "진행해줘" 뒤에는 앞 단계에서 읽은 엑셀 값을 그대로 쓴다. 폴더와 엑셀을 다시 읽지 않는다.
2. 이미지 파일은 이미지를 올리는 단계에서만 다룬다. 그 전에 복사하거나 옮기지 않는다.
3. BO 는 상품등록 주소로 바로 연다: `https://bo.x2bee.com/goods/goods-mgmt/general-goods-reg/`. 메뉴를 눌러 찾아가지 않는다.
4. 로그인 화면이 나오면 아이디·비밀번호 입력 두 개를 **한 응답에** 같이 보내고, 결과를 본 뒤 로그인 버튼을 누른다. 로그인 뒤 상품등록 주소를 다시 연다.
   - BrowserFill 은 쓰지 않는다: 공유 탭 전용이고 칸마다 판단 모델이 몇 초씩 돌며, 버튼은 누르지 않는다. 칸이 많은 상품 정보 입력에 쓴다.
5. 이미 열린 BO 탭이 있으면 새 탭을 만들지 말고 그 탭(page_id)을 쓴다. 로그인은 쿠키라 같은 DeX 안에서는 유지된다(DeX 를 다시 켜면 다시 로그인).

## 확인되지 않은 것

- 영상 당시 25.2초를 만든 리소스, Snapshot 7.7초의 원인.
- Qwen3.8 Flash(OpenRouter)가 한 응답에 여러 tool_call 을 실제로 내는지, upstream 캐시가 맞는지.
- 1단계 안내문 변경이 실제 모델 행동(BrowserFill 선택, 한 응답 다중 호출)을 바꾸는지 — 서버 반영 뒤 같은 요청으로 측정해야 한다.
