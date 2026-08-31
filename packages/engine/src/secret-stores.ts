/**
 * SecretPort 위에 얹은 두 개의 좁은 저장소 — MCP 서버 시크릿과 OAuth 상태.
 *
 * 예전에는 데스크톱 keychain.ts 안에 값으로 박혀 있었다. 그래서 MCP 매니저가
 * Electron 의 safeStorage 를 끌어왔고, CLI 는 같은 개념을 keytar 로 다시 썼다.
 * 이제 둘 다 이 파일을 쓰고, 무엇으로 저장하는지는 호스트가 준 포트가 정한다.
 *
 * 이름 접두사(`xgen_mcp_*`)는 그대로 둔다 — 이미 사용자 키체인에 저장된 항목들이
 * 있고, 접두사를 바꾸면 업데이트하는 순간 그 사람들의 MCP 서버가 전부 인증을
 * 잃는다.
 */
import type { SecretPort } from './ports/index';
import type { McpOAuthState, McpServerSecrets } from './mcp-types';

const MCP_SECRET_PREFIX = 'xgen_mcp_secret_';
const MCP_OAUTH_PREFIX = 'xgen_mcp_oauth_';

function nonEmpty(o?: Record<string, string>): boolean {
  return !!o && Object.values(o).some((v) => typeof v === 'string' && v.length > 0);
}

function parseObject<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const p: unknown = JSON.parse(raw);
    return p && typeof p === 'object' ? (p as T) : fallback;
  } catch {
    return fallback;
  }
}

export interface McpSecretStore {
  save(server: string, secrets: McpServerSecrets): Promise<boolean>;
  get(server: string): Promise<McpServerSecrets | null>;
  clear(server: string): Promise<void>;
}

export function createMcpSecretStore(secrets: SecretPort): McpSecretStore {
  return {
    /** 비어 있으면 저장이 아니라 **삭제**다 — 빈 객체를 남기면 다음 로드가
     *  "설정됨"으로 읽고 사용자는 왜 인증이 안 되는지 알 수 없다. */
    async save(server, value) {
      if (!nonEmpty(value.env) && !nonEmpty(value.headers)) {
        await secrets.set(MCP_SECRET_PREFIX + server, null);
        return true;
      }
      return secrets.set(MCP_SECRET_PREFIX + server, JSON.stringify(value));
    },
    async get(server) {
      return parseObject<McpServerSecrets | null>(
        await secrets.get(MCP_SECRET_PREFIX + server),
        null,
      );
    },
    async clear(server) {
      await secrets.set(MCP_SECRET_PREFIX + server, null);
    },
  };
}

export interface McpOAuthStore {
  load(server: string): Promise<McpOAuthState>;
  save(server: string, state: McpOAuthState): Promise<boolean>;
  patch(server: string, patch: Partial<McpOAuthState>): Promise<boolean>;
  clear(server: string): Promise<void>;
}

export function createMcpOAuthStore(secrets: SecretPort): McpOAuthStore {
  // 서버별 쓰기 직렬화 — patch() 는 하나의 항목에 대한 load-modify-save 라,
  // 조용한 갱신과 대화형 인증이 겹치면 서로의 필드를 지운다. 실제로 났던 일이다.
  const writeChain = new Map<string, Promise<unknown>>();

  const store: McpOAuthStore = {
    async load(server) {
      return parseObject<McpOAuthState>(await secrets.get(MCP_OAUTH_PREFIX + server), {});
    },
    async save(server, state) {
      return secrets.set(MCP_OAUTH_PREFIX + server, JSON.stringify(state));
    },
    async patch(server, patch) {
      const prev = writeChain.get(server) ?? Promise.resolve();
      const next = prev.then(async () => {
        const cur = await store.load(server);
        return store.save(server, { ...cur, ...patch });
      });
      writeChain.set(
        server,
        next.catch(() => undefined),
      );
      return next;
    },
    async clear(server) {
      await secrets.set(MCP_OAUTH_PREFIX + server, null);
      writeChain.delete(server);
    },
  };
  return store;
}
