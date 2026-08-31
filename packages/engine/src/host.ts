/**
 * 엔진이 호스트에게 받은 것을 한 번 붙여 두는 자리.
 *
 * 앱은 시작할 때 `bindHost(...)` 를 한 번 부르고, 엔진 안의 모듈들은
 * `hostPorts()` 로 꺼내 쓴다. 파라미터로 꿰지 않는 이유는 두 가지다 — MCP
 * 매니저와 OAuth 프로바이더가 이미 모듈 싱글턴이라 결이 같고, 포트를 12개
 * 호출부에 손으로 넘기면 한 곳만 빠뜨렸을 때 그 경로만 조용히 다른 저장소를
 * 쓰게 된다.
 *
 * **붙이지 않고 쓰면 던진다.** 메모리 구현으로 조용히 폴백하지 않는다 — 그러면
 * 사용자의 MCP 인증이 매번 사라지는데 아무 오류도 안 보인다. 테스트가 메모리를
 * 원하면 `bindHost(memoryPorts())` 를 명시적으로 부른다.
 */
import { type HostPorts, type InteractionPort } from './ports/index';
import { createMcpOAuthStore, createMcpSecretStore, type McpOAuthStore, type McpSecretStore } from './secret-stores';

interface Bound {
  ports: HostPorts;
  mcpSecrets: McpSecretStore;
  mcpOAuth: McpOAuthStore;
}

let bound: Bound | null = null;

export function bindHost(ports: HostPorts): void {
  bound = {
    ports,
    mcpSecrets: createMcpSecretStore(ports.secrets),
    mcpOAuth: createMcpOAuthStore(ports.secrets),
  };
}

/** 테스트 격리용 — 다음 bindHost 까지 미바인딩 상태로 되돌린다. */
export function unbindHost(): void {
  bound = null;
}

export function isHostBound(): boolean {
  return bound !== null;
}

function need(): Bound {
  if (!bound) {
    throw new Error(
      '@dex/engine: 호스트가 붙지 않았습니다. 앱 시작 시 bindHost({ secrets, config, paths }) 를 한 번 호출하세요.',
    );
  }
  return bound;
}

export function hostPorts(): HostPorts {
  return need().ports;
}

/**
 * 사용자와 주고받는 능력. 호스트가 안 줬으면 빈 객체다 — 각 도구가 자기 능력만
 * 확인하고 미지원을 알린다. 여기서 통째로 던지면 클립보드가 없는 호스트에서
 * 무관한 도구까지 죽는다.
 */
export function interaction(): InteractionPort {
  return need().ports.interaction ?? {};
}

/**
 * MCP 시크릿·OAuth 저장소.
 *
 * 함수가 아니라 **객체**로 노출한다 — 기존 호출부가 `mcpOAuthStore.patch(...)`
 * 형태라, 여기서 형태를 바꾸면 12곳을 고쳐야 하고 그중 하나를 빠뜨리기 쉽다.
 * 접근 시점에 바인딩을 확인하므로 import 순서에 영향받지 않는다.
 */
export const mcpSecretStore: McpSecretStore = {
  save: (s, v) => need().mcpSecrets.save(s, v),
  get: (s) => need().mcpSecrets.get(s),
  clear: (s) => need().mcpSecrets.clear(s),
};

export const mcpOAuthStore: McpOAuthStore = {
  load: (s) => need().mcpOAuth.load(s),
  save: (s, v) => need().mcpOAuth.save(s, v),
  patch: (s, p) => need().mcpOAuth.patch(s, p),
  clear: (s) => need().mcpOAuth.clear(s),
};
