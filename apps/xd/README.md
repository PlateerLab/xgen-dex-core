# XD

서버 없이 **이 PC 에서** 에이전트를 돌리는 로컬용 XGEN Dex. Dex 와 같은 버전으로 같은 릴리스에 나간다.

- 설계·단계: [DESIGN.md](DESIGN.md)
- 화면은 Dex 의 화면 코드(`apps/desktop/src/renderer`)를 공유한다 — 빌드 전에 `npm --prefix apps/desktop ci`.

```bash
npm --prefix apps/desktop ci
npm --prefix apps/xd ci
npm --prefix apps/xd run build      # out/
npm --prefix apps/xd test
XD_DATA_ROOT=/tmp/xd npx --prefix apps/xd electron apps/xd   # 시험 루트로 실행
```

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
