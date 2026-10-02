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
