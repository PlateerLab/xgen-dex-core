"""XD 엔진 — 이 PC 에서 에이전트 턴을 돌리는 상주 데몬.

XD(Electron main)가 자식 프로세스로 띄우고 stdio JSON 줄(프로토콜 v1)로 말한다. 턴은 런타임
(xgen-agent-runtime)의 제품 실행기 ``AgentTurnExecutor`` 가 그대로 돌고, 이 패키지는 그 실행기가
요구하는 호스트(:class:`xd_engine.host.XdHostServices`)를 이 PC 로 채운다. 런타임은 고치지 않는다
— XGEN 은 서버 전용이고, 로컬 호스트는 XD 안에만 있다(apps/xd/DESIGN.md §3).
"""

PROTOCOL_VERSION = 1
