/**
 * connector.json — the connector's local config file (Electron userData dir).
 *
 * Mirrors geny-connector: a tiny JSON file holding the server URL and app
 * preferences. The JWT token is NOT stored here — it lives in the OS keychain
 * (see keychain.ts). `XGEN_SERVER_URL` env pre-seeds the base URL on first run.
 */
import { app } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserAddressSearchConfig, BrowserPopupPermissions } from '@dex/protocol/browser';
import type { AgentViewerSub } from '@dex/protocol/agent-data';
import type { NotificationSettings } from '@dex/protocol/notifications';
import { DEPLOYMENT_DEFAULTS } from '@dex/engine/deployment-defaults';

/** A local MCP server the connector hosts + proxies to the user's XGEN agents. */
export interface McpServerConfig {
  /** Unique, stable id used to namespace the server's tools. */
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** stdio: 실행 명령. `args` 가 없으면 따옴표 인식 분해로 argv 를 만든다
   *  (사람이 한 줄로 적는 경로), `args` 가 있으면 이 값은 **실행 파일**이다. */
  command?: string;
  /** stdio: 표준 MCP 설정(JSON)에서 가져온 argv. 문자열로 합쳤다 다시 쪼개면
   *  공백·따옴표가 든 인자가 깨지므로 분리 보존한다. */
  args?: string[];
  /** stdio: extra environment merged over the connector's env (e.g. API tokens). */
  env?: Record<string, string>;
  /** http: the MCP endpoint URL (Streamable HTTP). */
  url?: string;
  /** http: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** http/sse: 'oauth' runs an OAuth 2.1 (PKCE) browser flow and attaches the
   *  access token automatically (tokens stored encrypted). Default 'none'. */
  auth?: 'none' | 'oauth';
  /** Off servers are never connected/advertised. Default true. */
  enabled?: boolean;
}

export interface ConnectorConfig {
  /** Gateway origin, e.g. "https://xgen.example.com". Empty on first run. */
  serverUrl: string;
  /** 설정된 서버에서 사설 CA 신뢰 실패만 예외로 허용한다. 기본 false. */
  allowPrivateCertificate?: boolean;
  /** 로그인 화면에서 SSO 팝업 로그인을 제공한다. 기본 false. */
  ssoEnabled?: boolean;
  /** 서버 origin 기준 SSO 진입 상대 경로. 예: "/sso/signin". */
  ssoPath?: string;
  /** SSO 팝업에서 분리된 Chromium DevTools를 자동으로 연다. 기본 false. */
  ssoDebug?: boolean;
  theme?: 'system' | 'dark' | 'light';
  lang?: 'ko' | 'en';
  autoUpdate?: boolean; // default true
  /** 업데이트 제공처. XGEN은 설정된 serverUrl의 다운로드 센터를 사용한다. */
  updateServer?: 'github' | 'xgen';
  autoLaunch?: boolean;
  /** Last selected agent (workflow_id) so the app reopens on it. */
  lastWorkflowId?: string;
  /** Persisted window bounds. */
  window?: { width: number; height: number; x?: number; y?: number };
  /** Show the floating avatar overlay window (Geny-style). Default false. */
  avatarOverlay?: boolean;
  /** Hide only the avatar inside the overlay (keep the floating chat + subtitle). */
  avatarHidden?: boolean;
  /** Show the live subtitle bubble on the overlay. Default true. */
  subtitles?: boolean;
  /** Subtitle typewriter pace — ms per character (throttles fast streams so the
   * speech bubble stays readable). Lower = faster. Default 50. */
  subtitleCharMs?: number;
  /** Speech-bubble size on the overlay: sm ≈ 3 lines, md ≈ 4–5, lg ≈ 6–7.
   * Default 'sm'. */
  subtitleSize?: 'sm' | 'md' | 'lg';
  /** Remember credentials and sign in automatically on launch. Default false. */
  autoLogin?: boolean;
  /** Persisted floating-overlay bounds (legacy single-monitor fallback). */
  overlayBounds?: { width: number; height: number; x?: number; y?: number };
  /** Avatar overlay geometry remembered PER MONITOR (key = display signature),
   *  so moving across mixed-DPI monitors restores each screen's own size instead
   *  of a rescaled one. Preferred over `overlayBounds`. */
  overlayByDisplay?: Record<string, { x: number; y: number; width: number; height: number }>;
  /** Enable the global quick-chat hotkey (Spotlight-style input bar). */
  quickChat?: boolean;
  /** Quick-chat global accelerator. Default Control+Shift+/ (Ctrl + ?). */
  quickChatHotkey?: string;
  /** Remembered quick-chat bar position. */
  quickChatBar?: { x: number; y: number };
  /** Device-local voice INPUT (STT) toggle. Default true. The server gate still
   *  applies — voice input works only when preferences.stt.enabled is also on. */
  voiceInput?: boolean;
  /** 아바타 오버레이 핸즈프리 음성 대화 (VAD 마이크 → STT → 자동 전송). */
  voiceHandsfree?: boolean;
  /** TTS 재생 볼륨 % (0~300, 100 = 원음) — 이 기기 로컬, WebAudio 게인. */
  voiceVolume?: number;
  /** Device-local voice OUTPUT (TTS) toggle. Default true. Server gate applies. */
  voiceOutput?: boolean;
  // ── 화면 캡처 ──
  //
  // 채팅을 보낼 때 지금 화면을 함께 보낸다. 에이전트가 "지금 뭐가 보이냐" 를
  // 물을 필요 없이 답할 수 있게 하는 기능이다.
  //
  // 기본 **꺼짐**이다. 화면에는 다른 사람의 메시지·비밀번호·미공개 문서가
  // 있을 수 있고, 그걸 서버로 보내는 것은 사용자가 명시적으로 골라야 하는
  // 종류의 일이다. (음성처럼 '안 쓰려면 꺼라' 로 둘 수 없다.)
  screenCapture?: boolean;
  /** 캡처할 화면/창의 id. 비우면 주 디스플레이. */
  screenCaptureSource?: string;
  /** Sandboxed Electron browser + agent automation. Separate opt-in capability. */
  browser?: BrowserPersistConfig;
  /** Enable hosting local MCP servers + bridging their tools to your agents. */
  mcp?: boolean;
  /** 채팅창 로컬 MCP 상태·실행 로그 디버그 UI. connector.json 직접 설정, 기본 false. */
  mcpDebug?: boolean;
  /** Configured local MCP servers. */
  mcpServers?: McpServerConfig[];
  /** 설치 폴더(기본 ~/xgen-dex) — 설치 로그(install.log)가 쌓이는 곳.
   *  인스톨러에서 고르고, 첫 부팅이 config 에 못박는다(data-root.ts). */
  dataRoot?: string;
  /** 이 설치본의 안정 디바이스 id (최초 1회 생성) — 기기 식별(연결된 기기 목록 등). */
  deviceId?: string;
  /** Linux 전용: 오버레이 클릭 통과 옵트인 ({forward:true} 미지원 플랫폼 안전장치). */
  linuxClickThrough?: boolean;
  /** 메인 창 크롬 상태와 두 패널 탭 배치. */
  ui?: {
    /** 'artifacts' 는 이름을 앱으로 바꾸기 전(2026-09-28)에 저장된 값 — 읽을 때 'apps' 로 본다. */
    sideView?: 'agent' | 'explorer' | 'teams' | 'apps' | 'artifacts';
    sidebarCollapsed?: boolean;
    sidebarWidth?: number;
    workspaceLayout?: WorkspaceLayoutPersistConfig;
    /**
     * 저장된 배치를 만든 계정(userId).
     *
     * 배치에는 대화 탭이 들어 있고, 대화 탭에는 상대 에이전트의 이름이 붙는다.
     * 계정이 바뀐 뒤에도 그대로 되살리면 남의 에이전트 이름이 탭 줄에 뜬다.
     * 주인이 다르면 대화 탭만 버린다 — 창 크기·사이드바 같은 나머지는 이 PC 의
     * 취향이므로 남긴다.
     */
    workspaceOwner?: string;
  };
  /**
   * Teams 로컬 상태. 서버는 "안 읽음" 을 세어 주지 않으므로(웹 Teams 도 항상 0)
   * 방별 마지막 열람 시각을 이 PC 가 기억해 배지를 계산한다.
   * 키는 room id, 값은 ISO 시각.
   */
  teams?: {
    lastReadAt?: Record<string, string>;
    /**
     * 알림을 끈 방 id 목록. **서버에 per-room 음소거 API 가 없어서**
     * (웹 Teams 도 마찬가지) 이 PC 가 기억한다 — lastReadAt 과 같은 이유.
     */
    mutedRooms?: string[];
    /** 새 메시지 OS 알림 전체 스위치. 미설정 = 켜짐. */
    notifications?: boolean;
  };
  /** 계정(serverUrl+userId)별 OS 알림 정책. teams.* 알림 필드는 v1 마이그레이션 입력이다. */
  notifications?: NotificationSettings;
}

export interface BrowserPersistConfig {
  /** Master switch. Default OFF because pages can contain private account data. */
  enabled?: boolean;
  /** Initial URL for user-visible shared tabs. Empty means about:blank. */
  newTabUrl?: string;
  /** Optional omnibox search fallback. Default OFF. */
  addressSearch?: BrowserAddressSearchConfig;
  /** Popup allow/block rules isolated by the account-hashed browser partition. */
  popupPermissions?: BrowserPopupPermissions;
}

export interface WorkspaceLayoutPersistConfig {
  groups: Array<{
    id: string;
    tabs: Array<{
      id: string;
      kind:
        | 'chat'
        | 'browser'
        | 'avatar'
        | 'teams'
        | 'settings'
        | 'agent-viewer'
        | 'agent-create'
        | 'file-viewer';
      sessionKey?: string;
      workflowId?: string;
      workflowName?: string;
      roomId?: string;
      roomName?: string;
      viewerSub?: AgentViewerSub;
      fileRel?: string;
      fileName?: string;
      fileSection?: 'cloud' | 'agent';
    }>;
    activeTabId: string | null;
  }>;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  focusedGroupId: string;
}

const DEFAULTS: ConnectorConfig = {
  serverUrl: '',
  allowPrivateCertificate: false,
  ssoEnabled: false,
  ssoPath: '/sso/signin',
  ssoDebug: false,
  mcpDebug: false,
  browser: { enabled: false },
  theme: 'system',
  lang: 'ko',
  autoUpdate: true,
  updateServer: 'github',
  autoLaunch: false,
  ...DEPLOYMENT_DEFAULTS,
};

function configPath(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'connector.json');
}

/**
 * 이제 아무도 읽지 않는 옛 키 — 읽을 때 걷어 내서 다음 저장에 파일에서도 사라지게 한다.
 * (가상 드라이브 워크스페이스 `workspace`·`workspaces`, 저장소 로컬 동기화 토글 `fileSystems`)
 */
const RETIRED_KEYS = ['workspace', 'workspaces', 'fileSystems'];

export function loadConfig(): ConnectorConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf-8'));
    if (raw && typeof raw === 'object') for (const k of RETIRED_KEYS) delete raw[k];
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS, serverUrl: process.env.XGEN_SERVER_URL || DEFAULTS.serverUrl };
  }
}

export function saveConfig(patch: Partial<ConnectorConfig>): ConnectorConfig {
  const next = { ...loadConfig(), ...patch };
  writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/** 저장된 로컬 설정을 제거해 다음 실행에서 배포 기본값부터 다시 시작한다. */
export function resetConfig(): void {
  rmSync(configPath(), { force: true });
}

/** 계정 키 — `${serverUrl}|${userId}`. 이 PC 에 계정별로 남기는 설정의 키다. */
export function accountKey(serverUrl: string, userId: string | number): string {
  return `${serverUrl}|${userId}`;
}

/** Server-URL 정규화 (geny-connector 동형):
 *  - 뒤 슬래시 제거 (`${base}/api/...` 가 `//api` 가 되지 않게)
 *  - 스킴 없는 입력 보정: localhost/.local/IPv4 → http://, 그 외 → https://
 *    ("xgen.example.com" 만 입력해도 base URL 이 깨지지 않는다). */
export function normalizeServerUrl(url: string): string {
  let u = (url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) {
    const host = u.split('/')[0].split(':')[0];
    const isLocal =
      host === 'localhost' || host.endsWith('.local') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    u = `${isLocal ? 'http' : 'https'}://${u}`;
  }
  return u;
}
