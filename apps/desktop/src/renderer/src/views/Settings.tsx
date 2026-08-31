import React, { useEffect, useRef, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import { xgen } from '../bridge';
import {
  BROWSER_SEARCH_PROVIDERS,
  normalizeBrowserUrl,
  type BrowserSearchProvider,
} from '@dex/protocol/browser';
import type { ConnectorConfig } from '../../../main/config';
import { HotkeyCapture } from './HotkeyCapture';
import { SettingsSection } from './SettingsSection';
import { SshSettings } from './SshSettings';
import { McpSettings } from './McpSettings';
import { SyncSettings } from './SyncSettings';
import { VoiceSettings } from './VoiceSettings';
import { Selector } from './Selector';
import { notificationStore, useNotifications } from '../notifications';
import type { NotificationEventType, NotificationPrivacy } from '@dex/protocol/notifications';
import {
  BrowserIcon,
  BellIcon,
  CloseIcon,
  FolderIcon,
  MonitorIcon,
  PlusIcon,
  SpeakerIcon,
} from '../brand/icons';

type Theme = NonNullable<ConnectorConfig['theme']>;

// 비슷한 기능끼리 탭으로 묶는다 — 세로로만 길어지던 설정을 폭을 넓혀 분류한다.
// 업데이트는 일반의 한 섹션이고(따로 탭일 만큼 크지 않다), 옛 [로컬 도구]는
// 성격이 다른 두 기능이 섞여 있어 [PC 컨트롤](셸·파일)과 [MCP]로 가른다.
type Tab =
  | 'connection' | 'general' | 'notifications' | 'avatar'
  | 'browser' | 'pc' | 'mcp' | 'ssh' | 'storage';
const TABS: { id: Tab; label: string }[] = [
  { id: 'connection', label: '연결' },
  { id: 'general', label: '일반' },
  { id: 'notifications', label: '알림' },
  { id: 'avatar', label: '아바타' },
  { id: 'browser', label: '브라우저' },
  { id: 'pc', label: 'PC 컨트롤' },
  { id: 'mcp', label: 'MCP' },
  // SSH 는 이 PC 의 기능이 아니라 **XGEN 계정의 설정**이다 (접속은 서버가 연다).
  // 그래도 여기 두는 이유: 사용자는 "Agent 가 뭘 할 수 있나"를 이 창에서 찾는다.
  { id: 'ssh', label: 'SSH' },
  { id: 'storage', label: '스토리지' },
];

const NOTIFICATION_EVENTS: Array<{
  id: NotificationEventType;
  label: string;
  hint: string;
}> = [
  { id: 'chat.completed', label: '채팅 답변 완료', hint: '보고 있지 않은 대화의 답변이 끝났을 때' },
  { id: 'chat.failed', label: '채팅 답변 실패', hint: '에이전트 응답이 오류로 종료됐을 때' },
  {
    id: 'agent.requested',
    label: '에이전트 요청 알림',
    hint: '에이전트가 이 PC의 Notify 도구를 호출했을 때',
  },
  { id: 'teams.message', label: 'Teams 새 메시지', hint: '사람이 보낸 1:1·그룹 메시지' },
  {
    id: 'teams.agent_message',
    label: 'Teams 에이전트 메시지',
    hint: 'Teams 방 안의 에이전트가 보낸 메시지',
  },
  { id: 'teams.invited', label: 'Teams 초대', hint: '대화방에 초대됐을 때(서버 이벤트 지원 시)' },
  { id: 'teams.removed', label: 'Teams 제외', hint: '대화방에서 제외됐을 때(서버 이벤트 지원 시)' },
  { id: 'system.update_ready', label: '업데이트 준비 완료', hint: '새 버전을 설치할 수 있을 때' },
];

/** 차단 명령 프리셋 — 누르면 그 묶음이 목록에 추가된다 (첫 단어 기준 매칭). */
const BLOCK_PRESETS: { label: string; cmds: string[] }[] = [
  { label: '삭제', cmds: ['rm', 'rmdir', 'del'] },
  { label: '전원·재부팅', cmds: ['shutdown', 'reboot', 'poweroff', 'halt'] },
  { label: '디스크·포맷', cmds: ['format', 'mkfs', 'diskpart', 'fdisk', 'dd'] },
  { label: '권한 상승', cmds: ['sudo', 'su', 'runas'] },
  { label: '프로세스 종료', cmds: ['kill', 'killall', 'pkill', 'taskkill'] },
];

export const Settings: React.FC<{
  config: ConnectorConfig;
  onClose: () => void;
  onChanged: () => Promise<ConnectorConfig>;
  /** true 면 모달이 아니라 메인 영역의 [설정] 탭 본문으로 렌더링된다. */
  embedded?: boolean;
}> = ({ config, onClose, onChanged, embedded }) => {
  // 탭으로 박혀 있을 때(embedded)는 Esc 로 닫을 대상이 아니다.
  useModalDismiss(onClose, !embedded);
  const [tab, setTab] = useState<Tab>('connection');
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [allowPrivateCertificate, setAllowPrivateCertificate] = useState(
    config.allowPrivateCertificate ?? false,
  );
  const [ssoEnabled, setSsoEnabled] = useState(config.ssoEnabled ?? false);
  const [ssoPath, setSsoPath] = useState(config.ssoPath ?? '/sso/signin');
  const [theme, setTheme] = useState<Theme>(config.theme ?? 'system');
  const [autoUpdate, setAutoUpdate] = useState(config.autoUpdate ?? true);
  const [updateServer, setUpdateServer] = useState<'github' | 'xgen'>(
    config.updateServer ?? 'github',
  );
  const [overlay, setOverlay] = useState(config.avatarOverlay ?? false);
  const [subtitles, setSubtitles] = useState(config.subtitles !== false);
  const [charMs, setCharMs] = useState(config.subtitleCharMs ?? 50);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>(config.subtitleSize ?? 'sm');
  const [quickChat, setQuickChat] = useState(config.quickChat ?? false);
  const [hotkey, setHotkey] = useState('Control+Shift+/');
  const [autostart, setAutostart] = useState(false);
  const [autostartRefused, setAutostartRefused] = useState(false);
  const [linuxClickThrough, setLinuxClickThrough] = useState(config.linuxClickThrough ?? false);
  const isLinux = /linux/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent);

  // ── 로컬 셸 접근 (기본 OFF, opt-in) ──
  const ls = config.localShell ?? {};
  const [shellOn, setShellOn] = useState(ls.enabled === true);
  const [shellCwd, setShellCwd] = useState(ls.cwd ?? '');
  const [shellTimeoutS, setShellTimeoutS] = useState(Math.round((ls.timeoutMs ?? 600_000) / 1000));
  // 차단 명령 — 칩 목록 + 프리셋(누르면 추가) + 직접 입력. 첫 단어 기준 매칭.
  const [shellBlocked, setShellBlocked] = useState<string[]>(
    (ls.blocked ?? []).map((b) => String(b).trim()).filter(Boolean),
  );
  const [blockedDraft, setBlockedDraft] = useState('');
  // 파일 도구(ReadFile/WriteFile/ListDir/Search)가 접근할 수 있는 폴더 목록.
  // 비우면 홈 폴더로 제한된다. 손 타이핑이 아니라 [+ 폴더 추가]의 네이티브
  // 선택기로만 늘어난다 — 오타 하나로 스코프가 빗나가는 일을 없앤다.
  const [shellRoots, setShellRoots] = useState<string[]>(
    (ls.allowedRoots ?? []).map((r) => String(r).trim()).filter(Boolean),
  );
  const [browserOn, setBrowserOn] = useState(config.browser?.enabled === true);
  const [browserNewTabUrl, setBrowserNewTabUrl] = useState(config.browser?.newTabUrl ?? '');
  const savedBrowserNewTabUrl = useRef(config.browser?.newTabUrl ?? '');
  const [browserNewTabUrlError, setBrowserNewTabUrlError] = useState('');
  const [browserSearchOn, setBrowserSearchOn] = useState(
    config.browser?.addressSearch?.enabled === true,
  );
  const [browserSearchProvider, setBrowserSearchProvider] = useState<BrowserSearchProvider>(
    config.browser?.addressSearch?.provider ?? 'google',
  );

  const [resetDone, setResetDone] = useState(false);
  const [confirmSettingsReset, setConfirmSettingsReset] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const notifications = useNotifications();
  const [notificationTest, setNotificationTest] = useState('');
  const [notificationNeedsSystemSettings, setNotificationNeedsSystemSettings] = useState(false);

  // Any status message means the check is underway/done → drop the button spinner
  // (the message line then shows progress like "내려받는 중… 45%").
  useEffect(
    () =>
      xgen.updater.onMessage((m) => {
        setUpdateMsg(m);
        if (!/^업데이트 확인 중/.test(m)) setChecking(false);
      }),
    [],
  );
  useEffect(() => {
    xgen.quickChat
      .getHotkey()
      .then(setHotkey)
      .catch(() => undefined);
    xgen.appctl
      .getAutostart()
      .then(setAutostart)
      .catch(() => undefined);
    xgen.updater
      .getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!notifications.loaded) void notificationStore.load();
  }, [notifications.loaded]);

  const changeHotkey = async (acc: string) => {
    const ok = await xgen.quickChat.setHotkey(acc);
    if (ok) setHotkey(acc);
    else
      xgen.quickChat
        .getHotkey()
        .then(setHotkey)
        .catch(() => undefined);
  };

  const apply = async (patch: Partial<ConnectorConfig>) => {
    await xgen.config.set(patch);
    await onChanged();
  };

  // 셸 설정은 여러 필드가 하나의 localShell 객체를 이룬다 — 저장 시점의 상태를
  // 통째로 쓰되, 방금 바꾼 필드는 override 로 즉시 반영한다.
  const commitShell = (
    over: Partial<{
      enabled: boolean;
      cwd: string;
      timeoutS: number;
      blocked: string[];
      roots: string[];
    }> = {},
  ) => {
    const enabled = over.enabled ?? shellOn;
    const cwd = (over.cwd ?? shellCwd).trim();
    const timeoutS = Math.max(1, Math.round(over.timeoutS ?? shellTimeoutS));
    const blocked = (over.blocked ?? shellBlocked).map((s) => s.trim()).filter(Boolean);
    const allowedRoots = (over.roots ?? shellRoots).map((s) => s.trim()).filter(Boolean);
    void apply({
      localShell: {
        enabled,
        cwd: cwd || undefined,
        timeoutMs: timeoutS * 1000,
        blocked,
        allowedRoots,
      },
    });
  };

  /** 차단 목록에 명령들을 얹는다 (중복 무시, 소문자 정규화). */
  const addBlocked = (cmds: string[]) => {
    const clean = cmds.map((c) => c.trim().toLowerCase()).filter(Boolean);
    const next = [...shellBlocked];
    for (const c of clean) if (!next.includes(c)) next.push(c);
    if (next.length === shellBlocked.length) return;
    setShellBlocked(next);
    commitShell({ blocked: next });
  };
  const removeBlocked = (idx: number) => {
    const next = shellBlocked.filter((_, i) => i !== idx);
    setShellBlocked(next);
    commitShell({ blocked: next });
  };
  const addBlockedDraft = () => {
    // 쉼표/공백으로 여러 개를 한 번에 받아도 흡수한다.
    addBlocked(blockedDraft.split(/[\s,]+/));
    setBlockedDraft('');
  };
  const presetAdded = (p: { cmds: string[] }) => p.cmds.every((c) => shellBlocked.includes(c));

  /** 기본 작업 폴더 — 네이티브 선택기로 고른다 (타이핑 금지). */
  const pickShellCwd = async () => {
    const p = await xgen.appctl.pickFolder();
    if (!p) return;
    setShellCwd(p);
    commitShell({ cwd: p });
  };
  // 설치 폴더(통합 루트) 파생 기본 — PC 컨트롤/스토리지의 기본은 이 하위다.
  const installRoot = (config.dataRoot ?? '').trim() || '~/xgen-dex';
  const sep = installRoot.includes('\\') ? '\\' : '/';
  const defaultShellCwd = `${installRoot}${sep}workspace`;
  const clearShellCwd = () => {
    // "기본값" = 설치 폴더\workspace — 홈이 아니라 통합 루트 하위다.
    setShellCwd(defaultShellCwd);
    commitShell({ cwd: defaultShellCwd });
  };

  /** 허용 폴더 — [+]로 하나씩 추가, 행의 ✕로 제거. */
  const addShellRoot = async () => {
    const p = await xgen.appctl.pickFolder();
    if (!p || shellRoots.includes(p)) return;
    const next = [...shellRoots, p];
    setShellRoots(next);
    commitShell({ roots: next });
  };
  const removeShellRoot = (idx: number) => {
    const next = shellRoots.filter((_, i) => i !== idx);
    setShellRoots(next);
    commitShell({ roots: next });
  };

  const commitBrowser = (
    over: Partial<{
      enabled: boolean;
      newTabUrl: string;
      searchEnabled: boolean;
      searchProvider: BrowserSearchProvider;
    }> = {},
  ) => {
    let newTabUrl = savedBrowserNewTabUrl.current;
    if (over.newTabUrl !== undefined) {
      const raw = over.newTabUrl.trim();
      const normalized = raw ? normalizeBrowserUrl(raw) : 'about:blank';
      if (!normalized) {
        setBrowserNewTabUrlError('http 또는 https 주소를 입력해 주세요.');
        return;
      }
      newTabUrl = normalized === 'about:blank' ? '' : normalized;
      setBrowserNewTabUrl(newTabUrl);
      savedBrowserNewTabUrl.current = newTabUrl;
      setBrowserNewTabUrlError('');
    }
    void apply({
      browser: {
        enabled: over.enabled ?? browserOn,
        newTabUrl: newTabUrl || undefined,
        addressSearch: {
          enabled: over.searchEnabled ?? browserSearchOn,
          provider: over.searchProvider ?? browserSearchProvider,
        },
      },
    });
  };

  // 서버 주소 변경은 세션 전환 — 첫 클릭에서 로그아웃 안내를 띄우고,
  // 두 번째 클릭(변경 및 로그아웃)에서 적용한다. 적용되면 main 이 세션을
  // 정리하고 authFailed 를 쏘아 로그인 화면으로 돌아간다.
  const [confirmServer, setConfirmServer] = useState(false);
  const saveServer = async () => {
    const next = serverUrl.trim().replace(/\/+$/, '');
    if (!next) return;
    const nextSsoPath = ssoPath.trim() || '/sso/signin';
    if (ssoEnabled && (!nextSsoPath.startsWith('/') || nextSsoPath.startsWith('//'))) return;
    const serverChanged = next !== (config.serverUrl ?? '');
    const optionsChanged =
      allowPrivateCertificate !== (config.allowPrivateCertificate ?? false) ||
      ssoEnabled !== (config.ssoEnabled ?? false) ||
      nextSsoPath !== (config.ssoPath ?? '/sso/signin');
    if (!serverChanged && !optionsChanged) {
      setConfirmServer(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }
    if (serverChanged && !confirmServer) {
      setConfirmServer(true);
      return;
    }
    await apply({
      serverUrl: next,
      allowPrivateCertificate,
      ssoEnabled,
      ssoPath: nextSsoPath,
    });
    setConfirmServer(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // 음성 설정은 어느 모드에서든 오버레이 모달로 뜬다 (backdrop 이 fixed 라
  // 임베드 안에서 렌더링돼도 창 전체를 덮는다).
  const voiceModal = showVoice ? <VoiceSettings onClose={() => setShowVoice(false)} /> : null;

  // 본문(탭 줄 + 패널)은 모달/임베드가 같은 것을 쓴다 — SyncSettings 동형.
  const body = (
    <>
      <div className="settings-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`settings-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="settings-panel">
        {/* ─── 연결 ─── */}
        {tab === 'connection' && (
          <SettingsSection title="서버">
            <label className="field">
              <span>서버 주소</span>
              <div className="row">
                <input
                  className="grow"
                  value={serverUrl}
                  onChange={(e) => {
                    setServerUrl(e.target.value);
                    setConfirmServer(false);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void saveServer()}
                />
                <button
                  className={confirmServer ? 'danger' : 'secondary'}
                  onClick={() => void saveServer()}
                >
                  {confirmServer ? '변경 및 로그아웃' : saved ? '저장됨' : '저장'}
                </button>
              </div>
              {confirmServer && (
                <span className="small notice-warn">
                  서버 주소를 변경하면 현재 세션이 종료되고 새 서버에 다시 로그인해야 합니다.
                  계속하려면 버튼을 한 번 더 누르세요.
                </span>
              )}
            </label>

            <label className="setup-option settings-option">
              <input
                type="checkbox"
                checked={allowPrivateCertificate}
                onChange={(e) => setAllowPrivateCertificate(e.target.checked)}
              />
              <span>
                사설 인증서 허용
                <small>설정한 서버의 사설 CA 신뢰 오류만 허용합니다.</small>
              </span>
            </label>
            <label className="setup-option settings-option">
              <input
                type="checkbox"
                checked={ssoEnabled}
                onChange={(e) => setSsoEnabled(e.target.checked)}
              />
              <span>SSO 로그인 사용</span>
            </label>
            {ssoEnabled && (
              <label className="field setup-nested-field settings-sso-path">
                <span>SSO PATH</span>
                <input
                  value={ssoPath}
                  onChange={(e) => setSsoPath(e.target.value)}
                  placeholder="/sso/signin"
                />
              </label>
            )}
            <p className="settings-hint">
              사설 인증서·SSO 를 바꾼 뒤에는 위 <b>저장</b> 버튼을 눌러 적용하세요.
            </p>
          </SettingsSection>
        )}

        {/* ─── 일반 — [일반][업데이트][설치] 세 분류(공통 SettingsSection) ─── */}
        {tab === 'general' && (
          <>
            <SettingsSection title="일반">
              <div className="field-row">
                <span>테마</span>
                <div className="seg">
                  {(['system', 'light', 'dark'] as const).map((t) => (
                    <button
                      key={t}
                      className={theme === t ? 'active' : ''}
                      onClick={() => {
                        setTheme(t);
                        void apply({ theme: t });
                      }}
                    >
                      {t === 'system' ? '시스템' : t === 'light' ? '라이트' : '다크'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span>빠른 채팅 (단축키)</span>
                <div className="row">
                  {quickChat && (
                    <HotkeyCapture value={hotkey} onCapture={(a) => void changeHotkey(a)} />
                  )}
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={quickChat}
                      onChange={(e) => {
                        setQuickChat(e.target.checked);
                        void xgen.quickChat.setEnabled(e.target.checked);
                        void onChanged();
                      }}
                    />
                    <span className="track" />
                  </label>
                </div>
              </div>

              <div className="field-row">
                <span>
                  로그인 시 시작
                  {autostartRefused && (
                    <span className="small notice-warn" style={{ marginLeft: 8 }}>
                      등록 불가 — AppImage 를 고정 경로에 두고 다시 시도하세요
                    </span>
                  )}
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autostart}
                    onChange={(e) => {
                      const wanted = e.target.checked;
                      void xgen.appctl.setAutostart(wanted).then((effective) => {
                        setAutostart(effective);
                        setAutostartRefused(wanted && !effective);
                      });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              {isLinux && (
                <div className="field-row">
                  <span>
                    오버레이 클릭 통과 (Linux)
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      켜면 오버레이가 마우스에 완전히 투명해집니다 (상호작용 불가)
                    </span>
                  </span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={linuxClickThrough}
                      onChange={(e) => {
                        setLinuxClickThrough(e.target.checked);
                        void apply({ linuxClickThrough: e.target.checked });
                      }}
                    />
                    <span className="track" />
                  </label>
                </div>
              )}

              <div className="field-row">
                <span>창 위치 초기화</span>
                <button
                  className="secondary"
                  onClick={() => {
                    xgen.appctl.resetPositions();
                    setResetDone(true);
                    setTimeout(() => setResetDone(false), 1500);
                  }}
                >
                  {resetDone ? '완료' : '초기화'}
                </button>
              </div>
              <div className="field-row">
                <span>
                  저장된 설정 초기화
                  {confirmSettingsReset && (
                    <span className="small notice-warn">
                      서버, SSO, 업데이트, MCP, 워크스페이스 설정과 저장된 로그인 정보가 모두
                      삭제됩니다. 앱은 설치본의 기본 설정으로 다시 시작됩니다.
                    </span>
                  )}
                </span>
                <div className="row">
                  {confirmSettingsReset && (
                    <button className="secondary" onClick={() => setConfirmSettingsReset(false)}>
                      취소
                    </button>
                  )}
                  <button
                    className={confirmSettingsReset ? 'danger' : 'secondary'}
                    onClick={() => {
                      if (!confirmSettingsReset) {
                        setConfirmSettingsReset(true);
                        return;
                      }
                      xgen.appctl.resetSettings();
                    }}
                  >
                    {confirmSettingsReset ? '초기화 및 재시작' : '초기화'}
                  </button>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title="업데이트">
              <div className="field-row">
                <span>
                  업데이트 서버
                  {updateServer === 'xgen' && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      설정된 XGEN 서버의 다운로드 센터
                    </span>
                  )}
                </span>
                <div className="seg">
                  {(['github', 'xgen'] as const).map((source) => (
                    <button
                      key={source}
                      className={updateServer === source ? 'active' : ''}
                      onClick={() => {
                        setUpdateServer(source);
                        void apply({ updateServer: source });
                      }}
                    >
                      {source === 'github' ? 'GitHub' : 'XGEN'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field-row">
                <span>자동 업데이트</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => {
                      setAutoUpdate(e.target.checked);
                      void xgen.updater.setEnabled(e.target.checked);
                    }}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="field-row">
                <span>
                  업데이트
                  {version && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      v{version}
                    </span>
                  )}
                </span>
                <div className="row">
                  {updateMsg && <span className="small muted">{updateMsg}</span>}
                  <button
                    className="secondary"
                    disabled={checking}
                    onClick={() => {
                      setChecking(true);
                      setUpdateMsg(null);
                      void xgen.updater.check();
                      setTimeout(() => setChecking(false), 25000);
                    }}
                  >
                    {checking ? '확인 중…' : '업데이트 확인'}
                  </button>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title="설치">
              <div className="field-row">
                <span>
                  설치 폴더
                  <span className="small muted" style={{ marginLeft: 8, wordBreak: 'break-all' }}>
                    {installRoot}
                  </span>
                </span>
                <div className="row">
                  <button className="secondary" onClick={() => void xgen.appctl.openFolder()}>
                    설치 폴더 열기
                  </button>
                </div>
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                에이전트는 서버에서 실행됩니다 — 이 PC 에는 실행 런타임이 설치되지
                않습니다. 이 앱은 서버 실행을 호출하고, 필요할 때 이 PC 의 도구
                (브라우저·셸·로컬 MCP)를 에이전트에게 빌려 줍니다.
              </p>
            </SettingsSection>
          </>
        )}

        {/* ─── 계정별 OS 알림 ─── */}
        {tab === 'notifications' && (
          <>
            <SettingsSection title="알림 사용">
              <div className="field-row">
                <span>
                  데스크톱 알림
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {notifications.supported === false
                      ? '이 환경에서 지원되지 않음'
                      : notifications.platform === 'darwin' &&
                          notifications.macCodeSignature !== 'signed'
                        ? notifications.developmentMode
                          ? 'macOS 개발 모드 · 서명된 앱 필요'
                          : 'macOS 임시/미서명 앱 · 알림 불가'
                        : notifications.platform
                          ? `${notifications.platform} · 계정별 설정`
                          : '상태 확인 중…'}
                  </span>
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={notifications.profile.enabled}
                    onChange={(event) => void notificationStore.setEnabled(event.target.checked)}
                  />
                  <span className="track" />
                </label>
              </div>
              <div className="field-row">
                <span>
                  테스트 알림
                  {notificationTest && (
                    <span className="small muted" style={{ marginLeft: 8 }}>
                      {notificationTest}
                    </span>
                  )}
                </span>
                <button
                  className="secondary"
                  onClick={() => {
                    setNotificationTest('전송 중…');
                    setNotificationNeedsSystemSettings(false);
                    void xgen.notifications
                      .test()
                      .then((result) => {
                        if (result.shown) {
                          setNotificationTest('OS에 표시됨');
                        } else if (result.reason === 'macos-unsigned-dev') {
                          setNotificationTest('개발 모드는 앱 서명이 없어 표시할 수 없습니다.');
                        } else if (result.reason === 'macos-unsigned-app') {
                          setNotificationTest('이 앱은 임시/미서명 상태라 알림을 표시할 수 없습니다.');
                        } else if (result.reason === 'os-denied') {
                          setNotificationTest('macOS 설정에서 XGen Dex 알림을 켜 주세요.');
                          setNotificationNeedsSystemSettings(true);
                        } else if (result.reason === 'unsupported') {
                          setNotificationTest('이 환경은 데스크톱 알림을 지원하지 않습니다.');
                        } else {
                          setNotificationTest('알림을 표시하지 못했습니다.');
                        }
                      })
                      .catch(() => setNotificationTest('표시 실패'));
                  }}
                >
                  <BellIcon size={14} /> 테스트
                </button>
              </div>
              {notificationNeedsSystemSettings && notifications.platform === 'darwin' && (
                <div className="field-row">
                  <span className="small muted">시스템 설정 › 알림 › XGen Dex를 확인하세요.</span>
                  <button
                    className="secondary"
                    onClick={() =>
                      void xgen.openExternal(
                        'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
                      )
                    }
                  >
                    macOS 알림 설정 열기
                  </button>
                </div>
              )}
              {notifications.platform === 'darwin' &&
                notifications.macCodeSignature !== 'signed' && (
                  <p className="small notice-warn">
                    Electron 42 이상은 macOS 알림에 유효한 코드 서명을 요구합니다. npm run dev는
                    서명되지 않은 Electron.app을 사용하고, 현재 ad-hoc 배포 서명도 알림에는
                    부족합니다. Developer ID 또는 로컬 테스트용 인증서로 서명된 앱에서 확인해 주세요.
                  </p>
                )}
              {notifications.error && <p className="small notice-warn">{notifications.error}</p>}
            </SettingsSection>

            <SettingsSection title="알림 이벤트">
              {NOTIFICATION_EVENTS.map((event) => (
                <div className="field-row" key={event.id}>
                  <span>
                    {event.label}
                    <span className="small muted notification-event-hint">{event.hint}</span>
                  </span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      disabled={!notifications.profile.enabled}
                      checked={notifications.profile.events[event.id]}
                      onChange={(input) =>
                        void notificationStore.setEvent(event.id, input.target.checked)
                      }
                    />
                    <span className="track" />
                  </label>
                </div>
              ))}
            </SettingsSection>

            <SettingsSection title="미리보기 내용">
              <div className="field-row">
                <span>
                  잠금 화면에 표시할 정보
                  <span className="small muted notification-event-hint">
                    운영체제의 자체 잠금 화면 설정이 추가로 적용됩니다.
                  </span>
                </span>
                <div className="seg">
                  {(
                    [
                      ['full', '전체'],
                      ['sender-only', '이름만'],
                      ['hidden', '숨김'],
                    ] as Array<[NotificationPrivacy, string]>
                  ).map(([privacy, label]) => (
                    <button
                      key={privacy}
                      className={notifications.profile.privacy === privacy ? 'active' : ''}
                      onClick={() => void notificationStore.setPrivacy(privacy)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsSection>

            <SettingsSection title="음소거 예외">
              <div className="field-row">
                <span>
                  개별 음소거
                  <span className="small muted notification-event-hint">
                    에이전트 {Object.keys(notifications.profile.mutedAgents).length} · 채팅{' '}
                    {Object.keys(notifications.profile.mutedChats).length} · Teams 방{' '}
                    {Object.keys(notifications.profile.mutedTeamsRooms).length}
                  </span>
                </span>
                <button
                  className="secondary"
                  disabled={
                    Object.keys(notifications.profile.mutedAgents).length === 0 &&
                    Object.keys(notifications.profile.mutedChats).length === 0 &&
                    Object.keys(notifications.profile.mutedTeamsRooms).length === 0 &&
                    Object.keys(notifications.profile.mutedTeamsSenders).length === 0
                  }
                  onClick={() => void notificationStore.resetScopes()}
                >
                  모두 해제
                </button>
              </div>
              <p className="small muted" style={{ margin: '8px 0 12px' }}>
                채팅 헤더의 종 아이콘에서 현재 대화 또는 에이전트 전체를, Teams 방 메뉴에서 해당
                방만 음소거할 수 있습니다. 에이전트 음소거는 그 아래 모든 채팅보다 우선합니다.
              </p>
            </SettingsSection>
          </>
        )}

        {/* ─── 아바타·자막 ─── */}
        {tab === 'avatar' && (
          <>
            <SettingsSection title="아바타">
              <div className="field-row">
                <span>아바타 오버레이 (플로팅)</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={overlay}
                    onChange={(e) => {
                      setOverlay(e.target.checked);
                      void xgen.overlay.setEnabled(e.target.checked);
                      void onChanged();
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              <div className="field-row">
                <span>말풍선 자막</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={subtitles}
                    onChange={(e) => {
                      setSubtitles(e.target.checked);
                      void apply({ subtitles: e.target.checked });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              <div className="field-row">
                <span>
                  자막 출력 속도
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {charMs >= 80 ? '느림' : charMs <= 30 ? '빠름' : '보통'}
                  </span>
                </span>
                <div className="seg">
                  {(
                    [
                      ['느림', 90],
                      ['보통', 50],
                      ['빠름', 25],
                    ] as const
                  ).map(([label, ms]) => (
                    <button
                      key={ms}
                      className={charMs === ms ? 'active' : ''}
                      onClick={() => {
                        setCharMs(ms);
                        void apply({ subtitleCharMs: ms });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-row">
                <span>
                  자막 창 크기
                  <span className="small muted" style={{ marginLeft: 8 }}>
                    {subtitleSize === 'sm' ? '3줄' : subtitleSize === 'md' ? '4~5줄' : '6~7줄'}
                  </span>
                </span>
                <div className="seg">
                  {(
                    [
                      ['작음', 'sm'],
                      ['중간', 'md'],
                      ['큼', 'lg'],
                    ] as const
                  ).map(([label, sz]) => (
                    <button
                      key={sz}
                      className={subtitleSize === sz ? 'active' : ''}
                      onClick={() => {
                        setSubtitleSize(sz);
                        void apply({ subtitleSize: sz });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </SettingsSection>
            <SettingsSection plain title="음성">
              {/* 음성 — 아바타가 말하고 듣는 통로라 아바타 탭에 둔다. */}
              <div className="tool-card">
                <div className="tool-card-main">
                  <span className="tool-card-icon">
                    <SpeakerIcon size={18} />
                  </span>
                  <div className="tool-card-text">
                    <div className="tool-card-title">음성 (STT/TTS)</div>
                    <div className="tool-card-desc">
                      마이크 음성 입력과 답변 음성 출력. 입·출력 장치와 음성 프로필을 관리합니다.
                    </div>
                  </div>
                  <button className="secondary" onClick={() => setShowVoice(true)}>
                    관리
                  </button>
                </div>
              </div>
            </SettingsSection>
          </>
        )}

        {/* ─── 브라우저 ─── */}
        {tab === 'ssh' && <SshSettings />}

        {tab === 'browser' && (
          <SettingsSection plain title="브라우저">
            <div className="tool-card">
              <div className="tool-card-main">
                <span className="tool-card-icon">
                  <BrowserIcon size={18} />
                </span>
                <div className="tool-card-text">
                  <div className="tool-card-title">에이전트 브라우저 접근</div>
                  <div className="tool-card-desc">
                    workflow별 격리 페이지를 열고 접근성 snapshot·클릭·입력·탐색을 에이전트가 수행할
                    수 있게 합니다. 로그인 쿠키는 이 XGEN 계정 전용 partition에만 저장됩니다.
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={browserOn}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setBrowserOn(enabled);
                      commitBrowser({ enabled });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>
              {browserOn && (
                <div className="tool-card-body">
                  <label className="field">
                    <span>
                      새 탭 URL <span className="small muted">(비우면 빈 페이지)</span>
                    </span>
                    <input
                      value={browserNewTabUrl}
                      placeholder="예: example.com 또는 https://example.com/start"
                      aria-invalid={browserNewTabUrlError ? true : undefined}
                      onChange={(event) => {
                        setBrowserNewTabUrl(event.target.value);
                        setBrowserNewTabUrlError('');
                      }}
                      onBlur={(event) => commitBrowser({ newTabUrl: event.currentTarget.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                    {browserNewTabUrlError && (
                      <span className="small notice-warn">{browserNewTabUrlError}</span>
                    )}
                  </label>
                  <p className="settings-hint">
                    프로토콜을 생략하면 https://를 자동으로 붙입니다. 이 설정은 새로 여는 사용자
                    브라우저 탭에만 적용됩니다.
                  </p>
                  <div className="field-row">
                    <span>
                      주소창 검색
                      <span className="small muted" style={{ marginLeft: 8 }}>
                        URL이 아닌 입력을 검색
                      </span>
                    </span>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={browserSearchOn}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setBrowserSearchOn(enabled);
                          commitBrowser({ searchEnabled: enabled });
                        }}
                      />
                      <span className="track" />
                    </label>
                  </div>
                  {browserSearchOn && (
                    <div className="field">
                      <span>검색 엔진</span>
                      <Selector
                        value={browserSearchProvider}
                        onChange={(provider) => {
                          setBrowserSearchProvider(provider as BrowserSearchProvider);
                          commitBrowser({ searchProvider: provider as BrowserSearchProvider });
                        }}
                        options={Object.entries(BROWSER_SEARCH_PROVIDERS).map(([id, provider]) => ({
                          value: id,
                          label: provider.label,
                        }))}
                        ariaLabel="검색 엔진 선택"
                      />
                    </div>
                  )}
                  <p className="settings-hint warn">
                    페이지 내용은 신뢰하지 않는 데이터로 처리됩니다. 쿠키·스토리지, 업로드·다운로드,
                    클립보드, credentials, 요청 변조와 raw eval은 실행 직전 이 PC에서 별도 승인을
                    요청합니다. 업로드·다운로드 경로는 아래 로컬 파일 도구의 허용 폴더 범위를 함께
                    사용합니다.
                  </p>
                </div>
              )}
            </div>
          </SettingsSection>
        )}

        {/* ─── 로컬 도구 ─── */}
        {/* ─── PC 컨트롤 (셸·파일 — 에이전트가 이 PC 를 다룬다) ─── */}
        {tab === 'pc' && (
          <SettingsSection plain title="PC 컨트롤">
            <div className="tool-card">
              <div className="tool-card-main">
                <span className="tool-card-icon">
                  <MonitorIcon size={18} />
                </span>
                <div className="tool-card-text">
                  <div className="tool-card-title">
                    로컬 도구 접근 (셸 · 파일) — 서버 실행 시 이 PC 프록시
                  </div>
                  <div className="tool-card-desc">
                    켜면, 에이전트가 <b>서버(웹)에서 실행되거나 로컬 실행이 서버로 폴백된 상황</b>
                    에서도 이 PC 의 셸(PowerShell/bash)·파일 읽기/쓰기·목록·검색·클립보드·알림으로
                    "내 컴퓨터"를 직접 조작할 수 있습니다 — 커넥터가 자동으로 프록시가 됩니다(MCP
                    설정과 무관, 이 스위치만으로 동작). 커넥터에서 그대로 <b>로컬 실행</b>되는 기본
                    경우엔 에이전트가 이미 이 PC 에서 자기 런타임 도구로 직접 조작하므로 이 도구들은
                    쓰이지 않습니다. 파일 도구는 아래 허용 폴더로 제한됩니다.
                  </div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={shellOn}
                    onChange={(e) => {
                      setShellOn(e.target.checked);
                      commitShell({ enabled: e.target.checked });
                    }}
                  />
                  <span className="track" />
                </label>
              </div>

              {shellOn && (
                <div className="tool-card-body">
                  <div className="field">
                    <span>기본 작업 폴더</span>
                    <div className="picker-row">
                      <span
                        className={`picker-path ${shellCwd ? '' : 'muted'}`}
                        title={shellCwd || undefined}
                      >
                        {shellCwd || `${defaultShellCwd} (기본값)`}
                      </span>
                      <button className="secondary" onClick={() => void pickShellCwd()}>
                        폴더 선택…
                      </button>
                      {shellCwd && (
                        <button className="link" onClick={clearShellCwd}>
                          기본값으로
                        </button>
                      )}
                    </div>
                    <span className="small muted" style={{ marginTop: 4 }}>
                      지정하면 <b>연결된 에이전트의 워크스페이스</b>가 이 폴더 아래로 동기화됩니다 —
                      커넥터로 접속한 에이전트는 서버 sandbox 대신 그 폴더를 자기 작업 공간으로
                      씁니다. (스토리지 탭에서 에이전트 연결)
                    </span>
                  </div>
                  <div className="field">
                    <span>
                      허용 폴더 <span className="small muted">(파일 도구 접근 범위)</span>
                    </span>
                    <div className="roots-list">
                      {shellRoots.length === 0 && (
                        <div className="roots-empty small muted">
                          홈 디렉터리만 허용 (기본값)
                          {shellCwd ? ' — 기본 작업 폴더는 항상 포함됩니다.' : ''}
                        </div>
                      )}
                      {shellRoots.map((r, i) => (
                        <div className="root-item" key={r}>
                          <span className="root-icon">
                            <FolderIcon size={14} />
                          </span>
                          <span className="root-path" title={r}>
                            {r}
                          </span>
                          <button
                            className="root-remove"
                            title="허용 목록에서 제거"
                            onClick={() => removeShellRoot(i)}
                          >
                            <CloseIcon size={13} />
                          </button>
                        </div>
                      ))}
                      <button className="root-add" onClick={() => void addShellRoot()}>
                        <PlusIcon size={14} /> 폴더 추가…
                      </button>
                    </div>
                    {shellRoots.length > 0 && shellCwd && (
                      <span className="small muted" style={{ marginTop: 4 }}>
                        기본 작업 폴더는 목록과 무관하게 항상 허용에 포함됩니다.
                      </span>
                    )}
                  </div>
                  <div className="field">
                    <span>
                      차단할 명령 <span className="small muted">(첫 단어 기준 — 편의용 가드)</span>
                    </span>
                    {/* 프리셋 — 누르면 그 묶음이 아래 목록에 추가된다. 전부
                          이미 있으면 ✓ 로 표시하고 다시 눌러도 변화 없다. */}
                    <div className="preset-row">
                      {BLOCK_PRESETS.map((p) => {
                        const added = presetAdded(p);
                        return (
                          <button
                            key={p.label}
                            className={`chip ${added ? 'active' : ''}`}
                            title={p.cmds.join(', ')}
                            onClick={() => addBlocked(p.cmds)}
                          >
                            {added ? '✓ ' : '+ '}
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="cmd-chips">
                      {shellBlocked.length === 0 && (
                        <span className="small muted">차단하는 명령이 없습니다.</span>
                      )}
                      {shellBlocked.map((c, i) => (
                        <span className="cmd-chip" key={c}>
                          {c}
                          <button
                            className="cmd-chip-x"
                            title="차단 해제"
                            onClick={() => removeBlocked(i)}
                          >
                            <CloseIcon size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="cmd-add-row">
                      <input
                        value={blockedDraft}
                        placeholder="직접 입력 (쉼표/공백으로 여러 개)"
                        onChange={(e) => setBlockedDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addBlockedDraft()}
                      />
                      <button
                        className="secondary"
                        disabled={!blockedDraft.trim()}
                        onClick={addBlockedDraft}
                      >
                        추가
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <span>명령 시간 제한</span>
                    <div className="unit-row">
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        className="num-input"
                        value={shellTimeoutS}
                        onChange={(e) => setShellTimeoutS(Number(e.target.value) || 120)}
                        onBlur={() => commitShell()}
                      />
                      <span className="unit">초</span>
                    </div>
                    <span className="small muted" style={{ marginTop: 4 }}>
                      한 명령이 이 시간을 넘으면 중단됩니다. background 실행(ShellJob)은 제한을 받지
                      않습니다.
                    </span>
                  </div>
                  <p className="settings-hint warn">
                    ⚠ 켜면 파일 읽기/쓰기·목록·검색·클립보드·알림 도구와 셸이 에이전트에 노출됩니다.
                    셸은 로그인 사용자 권한으로 실행되며, 되돌리기 어려운 명령(rm -rf 등)은 실행
                    직전 확인을 요청합니다. 파일 도구는 위 허용 폴더 범위로 제한됩니다. 실행 내역은
                    항상 도구 로그에 기록됩니다.
                  </p>
                </div>
              )}
            </div>
          </SettingsSection>
        )}

        {/* ─── MCP — 내 PC 에서 호스팅하는 MCP 서버 관리 (임베드) ─── */}
        {tab === 'mcp' && (
          <SettingsSection plain title="MCP 서버">
            <McpSettings embedded onClose={() => undefined} />
          </SettingsSection>
        )}

        {/* ─── 스토리지 ─── */}
        {/* 예전에는 카드 + [관리] 버튼을 한 번 더 눌러야 전체 설정이 떴다.
              스토리지 탭이 곧 워크스페이스 동기화 화면이므로 본문을 그대로
              임베드해 한 단계 클릭을 없앤다. */}
        {tab === 'storage' && (
          <SettingsSection plain title="스토리지">
            <SyncSettings embedded />
          </SettingsSection>
        )}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="settings-page">
        <div className="settings-page-inner">{body}</div>
        {voiceModal}
      </div>
    );
  }
  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal wide settings-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <h2>설정</h2>
            <button className="link" onClick={onClose}>
              닫기
            </button>
          </div>
          {body}
        </div>
      </div>
      {voiceModal}
    </>
  );
};
