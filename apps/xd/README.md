# XD

서버 없이 **이 PC 에서** 에이전트를 돌리는 로컬용 XGEN Dex. Dex 와 같은 버전으로 같은 릴리스에 나간다.

- 설계·단계: [DESIGN.md](DESIGN.md)
- 화면은 XD 전용이고, Dex 와 같은 기본 부품(마크다운·작업 과정·아이콘·스타일)만 `src/renderer/src/dex.ts` 로
  가져온다(DESIGN.md §8) — 빌드 전에 `npm --prefix apps/desktop ci`.

```bash
npm --prefix apps/desktop ci
npm --prefix apps/xd ci
npm --prefix apps/xd run build      # out/
npm --prefix apps/xd test           # Node 22 이상(node:sqlite) — CI 는 Electron 과 같은 Node 24
XD_DATA_ROOT=/tmp/xd npx --prefix apps/xd electron apps/xd   # 시험 루트로 실행
```

실제 앱 E2E(가짜 LLM, 키·네트워크 없음) — 동봉 엔진과 빌드가 먼저다:

```bash
node apps/xd/scripts/bundle-engine.mjs && npm --prefix apps/xd run build
xvfb-run -a npm --prefix apps/xd run e2e      # 화면이 있으면 xvfb-run 없이
```

`e2e/screens.e2e.ts` 는 모든 단계를 화면 조작으로 한다(제공자 추가 → 에이전트 → 대화 → 다시 켜기 → 정지·실패).
`XD_E2E_SHOTS=<폴더>` 를 주면 단계마다 화면을 찍어 둔다.

## 엔진 (Python)

`engine/xd_engine` — 런타임(xgen-agent-runtime)의 턴 실행기를 이 PC 에서 돌리는 상주 데몬. 앱에는 이 OS·아키텍처용
Python 과 함께 동봉된다(DESIGN.md §5).

```bash
node apps/xd/scripts/bundle-engine.mjs        # → apps/xd/engine/dist/<platform>-<arch>/python, 끝에 검증까지
PY=apps/xd/engine/dist/linux-x64/python/bin/python3
"$PY" -I -m xd_engine --root /tmp/xd          # stdio JSON 줄(프로토콜 v1)
# 시험: 동봉 인터프리터 + pytest(따로 받은 것)
pip install --target /tmp/pytest-lib pytest==9.1.1
(cd apps/xd/engine && PYTHONPATH=/tmp/pytest-lib "../../../$PY" -m pytest -q tests)
```

의존성을 바꿀 때는 `engine/bundle/requirements.in` 을 고치고 잠금을 다시 만든다(파일 머리의 명령).
