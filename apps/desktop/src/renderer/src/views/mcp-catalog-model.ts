/**
 * MCP 카탈로그 화면의 규칙 — 검색 · 분류 · 카드 상태(설치됨/업데이트) · 런타임 배지 ·
 * 입력 폼 초기값 · 오류 문구. 화면(McpCatalog.tsx)에서 떼어 두어 렌더러 없이 시험한다.
 */
import type { CatalogItem, CatalogSpec, CatalogValues } from '@dex/protocol/mcp-catalog';
import { catalogUpdateAvailable, isSecretVariable } from '@dex/protocol/mcp-catalog';
import type { McpServerConfig } from '../../../main/config';

/** 계약의 분류 순서. 그 밖의 분류는 뒤에 이름순. */
const CATEGORY_ORDER = ['개발', '문서', '브라우저', '데이터', '협업', '검색', '기타'];

export function catalogCategories(items: CatalogItem[]): string[] {
  const seen = new Set(items.map((i) => i.category || '기타'));
  const known = CATEGORY_ORDER.filter((c) => seen.has(c));
  const rest = [...seen]
    .filter((c) => !CATEGORY_ORDER.includes(c))
    .sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

export function filterCatalog(
  items: CatalogItem[],
  query: string,
  category: string | null,
): CatalogItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((i) => {
    if (category && (i.category || '기타') !== category) return false;
    if (!q) return true;
    return [i.name, i.description, i.catalog_id, i.publisher, ...(i.tags ?? [])]
      .filter(Boolean)
      .some((t) => String(t).toLowerCase().includes(q));
  });
}

export type CatalogCardState = 'available' | 'installed' | 'update';

export interface CatalogInstallState {
  state: CatalogCardState;
  /** 이 항목으로 설치한 서버들. */
  servers: McpServerConfig[];
  /** 업데이트할 서버(판이 가장 낮은 것). */
  outdated?: McpServerConfig;
}

export function catalogInstallState(
  item: CatalogItem,
  servers: McpServerConfig[],
): CatalogInstallState {
  const mine = servers.filter((s) => s.catalog?.catalog_id === item.catalog_id);
  if (!mine.length) return { state: 'available', servers: [] };
  const outdated = mine
    .filter((s) => catalogUpdateAvailable(item, s.catalog))
    .sort((a, b) => (a.catalog?.revision ?? 0) - (b.catalog?.revision ?? 0))[0];
  return outdated
    ? { state: 'update', servers: mine, outdated }
    : { state: 'installed', servers: mine };
}

/** 카드의 런타임 배지 — "Node 24+", "uv", "Docker", "원격". */
export function runtimeBadge(spec: CatalogSpec): string {
  if (spec.transport !== 'stdio') return '원격 연결';
  const min = spec.runtime?.min_version ? String(spec.runtime.min_version).split('.')[0] : '';
  switch (spec.runtime?.kind) {
    case 'node':
      return min ? `Node ${min}+` : 'Node';
    case 'python':
      return spec.runtime.min_version
        ? `Python ${spec.runtime.min_version.split('.').slice(0, 2).join('.')}+`
        : 'Python';
    case 'uv':
      return 'uv (Python)';
    case 'docker':
      return 'Docker';
    case 'binary':
      return '실행 파일';
    default:
      return '추가 설치 없음';
  }
}

/** 폼 초기값 — 기본값 · 저장된 값. 비밀은 언제나 비워 둔다(업데이트면 "저장됨" 으로 유지). */
export function initialCatalogValues(
  spec: CatalogSpec,
  stored: Record<string, string> = {},
): CatalogValues {
  const out: CatalogValues = {};
  for (const v of spec.variables ?? []) {
    if (isSecretVariable(v)) {
      out[v.name] = '';
      continue;
    }
    const saved = stored[v.name];
    if (saved !== undefined) out[v.name] = v.type === 'boolean' ? saved === 'true' : saved;
    else if (v.default !== null && v.default !== undefined && v.default !== '')
      out[v.name] =
        v.type === 'boolean' ? v.default === true || v.default === 'true' : String(v.default);
    else out[v.name] = v.type === 'boolean' ? false : '';
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

export const CATALOG_STAGE_LABELS: Record<string, string> = {
  check: '런타임 확인',
  install: '설치',
  setup: '설정',
  test: '연결 테스트',
  done: '완료',
};

/** 오류 코드 → 사용자가 무엇을 하면 되는지 한 줄. 본문(message)은 엔진이 준 것을 그대로 함께 보인다. */
export function catalogErrorTitle(code?: string): string {
  switch (code) {
    case 'validation':
      return '입력값을 확인해 주세요.';
    case 'dexon_too_old':
      return 'Dexon 을 업데이트해야 설치할 수 있습니다.';
    case 'spec_invalid':
      return '카탈로그 항목 정의에 문제가 있습니다. 관리자에게 알려 주세요.';
    case 'runtime_manual_required':
      return '이 런타임은 직접 설치해야 합니다.';
    case 'runtime_unsupported':
      return '이 PC 에서는 런타임을 자동으로 설치할 수 없습니다.';
    case 'download_failed':
      return '런타임을 내려받지 못했습니다. 네트워크(프록시 · 방화벽)를 확인하고 다시 시도하세요.';
    case 'checksum_mismatch':
      return '내려받은 파일이 검증을 통과하지 못해 설치하지 않았습니다. 다시 시도하세요.';
    case 'extract_failed':
      return '런타임 압축을 풀지 못했습니다.';
    case 'runtime_test_failed':
    case 'python_install_failed':
    case 'runtime_install_failed':
      return '런타임 설치를 마치지 못했습니다.';
    case 'exec_not_found':
      return '실행 파일을 찾지 못했습니다.';
    case 'setup_failed':
      return '설치 후 설정 단계가 실패했습니다.';
    case 'setup_timeout':
      return '설치 후 설정 단계가 너무 오래 걸려 멈췄습니다.';
    case 'test_failed':
      return '서버를 띄웠지만 연결 시험에 실패했습니다.';
    case 'save_failed':
      return '설정을 저장하지 못했습니다.';
    case 'user_cancelled':
    case 'consent_denied':
      return '설치를 취소했습니다.';
    default:
      return '설치하지 못했습니다.';
  }
}

/** 설치 작업 id — 진행 이벤트를 이 작업의 것만 받는다. */
export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
