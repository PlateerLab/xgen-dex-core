/**
 * McpSettings — manage local MCP servers the connector hosts and bridges to your
 * XGEN agents. Enable the bridge, add stdio/http MCP servers, test them, and the
 * backend auto-injects their tools into your agents' next turns.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';
import { xgen, copyText } from '../bridge';
import type { McpServerConfig } from '../../../main/config';
import type { McpBridgeStatusLike, McpRuntimeLogEntryLike } from '../../../preload/index';
import { Selector } from './Selector';
import {
  McpImportError,
  parseMcpConfig,
  toDisplayCommand,
  toMcpConfigJson,
  type ImportedServer,
} from './mcp-import';

type Transport = 'stdio' | 'http' | 'sse';
type Draft = {
  name: string;
  transport: Transport;
  command: string;
  url: string;
  envText: string;
  headersText: string;
  auth: 'none' | 'oauth';
  enabled: boolean;
};

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "mcp-atlassian": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": { "JIRA_URL": "https://your-company.atlassian.net" }
    }
  }
}`;

/** 연결 테스트 결과 — 목록 행과 편집 폼이 **같은 컴포넌트**를 재사용한다. */
export type TestState = {
  busy?: boolean;
  ok?: boolean;
  msg?: string;
  hints?: string[];
  /** 기동 중인 서버가 뱉는 출력 (첫 실행 다운로드 진행 상황 등). */
  progress?: string[];
  /** 테스트 시작 시각 — 오래 걸릴 때 경과를 보여준다. */
  startedAt?: number;
};

/** '설치: <명령>' 힌트는 그대로 붙여넣을 수 있어야 쓸모가 있다. */
const INSTALL_PREFIX = '설치: ';

const HintLine: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);
  if (!text.startsWith(INSTALL_PREFIX)) return <li>{text}</li>;
  const cmd = text.slice(INSTALL_PREFIX.length);
  return (
    <li className="mcp-hint-cmd">
      <span>{text}</span>
      <button
        className="link"
        onClick={() => {
          void copyText(cmd).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? '복사됨' : '복사'}
      </button>
    </li>
  );
};

/** 초 단위 경과 — 몇 분짜리 첫 설치에서 '멈춘 건 아니다'를 알려준다. */
function useElapsed(since?: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? Math.floor((Date.now() - since) / 1000) : 0;
}

const TestResult: React.FC<{ state: TestState }> = ({ state }) => {
  const elapsed = useElapsed(state.busy ? state.startedAt : undefined);
  if (state.busy) {
    return (
      <div className="small muted mcp-test-result" role="status">
        <div>
          테스트 중…{elapsed >= 3 ? ` (${elapsed}초)` : ''}
          {elapsed >= 15 && (
            <span className="mcp-hint-note">
              {' '}
              첫 실행이면 실행기가 런타임·의존성을 내려받는 중일 수 있습니다. 끝날 때까지 기다려
              주세요.
            </span>
          )}
        </div>
        {!!state.progress?.length && (
          <ul className="mcp-hints">
            {state.progress.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (!state.msg) return null;
  return (
    <div className={`small mcp-test-result ${state.ok ? 'notice-ok' : 'error'}`} role="status">
      <div>{state.msg}</div>
      {!!state.hints?.length && (
        <ul className="mcp-hints">
          {state.hints.map((h, i) => (
            <HintLine key={i} text={h} />
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * 설정 하나를 실제로 띄워 보고 결과를 사람이 읽는 형태로 만든다.
 * 실패가 "런타임 미설치"면 메인 프로세스가 설치 안내(hints)를 함께 준다.
 */
async function testConfig(cfg: McpServerConfig): Promise<TestState> {
  try {
    const r = await xgen.mcp.testServer(cfg);
    if (r.ok) {
      const names = (r.tools ?? []).map((t) => t.name);
      return {
        ok: true,
        msg:
          `연결됨 · 도구 ${names.length}개` +
          (names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}` : ''),
      };
    }
    return { ok: false, msg: r.error || '연결 실패', hints: r.hints };
  } catch (e) {
    return { ok: false, msg: `테스트 실패: ${String((e as Error)?.message ?? e)}` };
  }
}

const EMPTY_DRAFT: Draft = {
  name: '',
  transport: 'stdio',
  command: '',
  url: '',
  envText: '',
  headersText: '',
  auth: 'none',
  enabled: true,
};

function kvToText(obj?: Record<string, string>, sep = '='): string {
  if (!obj) return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');
}
function textToKv(text: string, sep = '='): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  // Split on the FIRST delimiter char (sep[0]) so a redacted secret line like
  // `Authorization:` (trailing space trimmed off) still yields the key with an
  // empty value — instead of being dropped, which would wipe the stored secret.
  const delim = sep[0] || sep;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(delim);
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function draftFromConfig(c: McpServerConfig): Draft {
  return {
    name: c.name,
    transport: c.transport,
    // 가져오기로 들어온 args 는 편집 폼에서 한 줄 명령으로 보여준다
    // (저장 시 이 문자열이 진실이 되고 args 는 버려진다 — 왕복 일관).
    command: toDisplayCommand(c.command ?? '', c.args ?? []),
    url: c.url ?? '',
    envText: kvToText(c.env, '='),
    headersText: kvToText(c.headers, ': '),
    auth: c.auth === 'oauth' ? 'oauth' : 'none',
    enabled: c.enabled !== false,
  };
}
function configFromDraft(d: Draft): McpServerConfig {
  const c: McpServerConfig = { name: d.name.trim(), transport: d.transport, enabled: d.enabled };
  if (d.transport === 'stdio') {
    // 폼에서 명령을 직접 편집하면 그 문자열이 진실이 된다 — 가져오기로 들어온
    // args 배열은 버린다 (둘이 어긋나면 실행 인자가 예상과 달라진다).
    c.command = d.command.trim();
    const env = textToKv(d.envText, '=');
    if (env) c.env = env;
  } else {
    c.url = d.url.trim();
    const headers = textToKv(d.headersText, ': ');
    if (headers) c.headers = headers;
    if (d.auth === 'oauth') c.auth = 'oauth';
  }
  return c;
}

function firstLine(s: string): string {
  const line = String(s).split('\n')[0].trim();
  return line.length > 96 ? line.slice(0, 96) + '…' : line;
}

/** G10 — persistent surface of the tools currently exposed to the agent, with
 *  per-tool description/inputSchema and the recent invocation log. */
const ExposedToolsPanel: React.FC<{
  status: McpBridgeStatusLike | null;
  logs: McpRuntimeLogEntryLike[];
}> = ({ status, logs }) => {
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [showCalls, setShowCalls] = useState(false);
  // 이 패널은 **내가 등록한 외부 MCP 서버**의 도구만 보여준다. 커넥터 내장 도구(Shell·파일·
  // 클립보드·브라우저)는 MCP 서버가 아니고, 기본 로컬 실행 경로에서는 에이전트가 런타임 자체
  // 도구를 쓰므로 여기에 뜨는 것은 오해를 부른다 — 그 도구들은 PC 컨트롤/브라우저 탭에서 관리한다.
  // 'local'(내장) 서버와 내부 도구(`_` 접두)는 목록에서 제외한다.
  const isExposed = (name: string): boolean => !String(name || '').startsWith('_');
  const externals = (status?.servers ?? [])
    .filter((s) => s.name !== 'local')
    .map((s) => ({ ...s, tools: (s.tools ?? []).filter((t) => isExposed(t.name)) }));
  const total = externals.reduce((n, s) => n + (s.connected ? s.tools.length : 0), 0);
  const recentCalls = logs
    .filter((l) => l.kind === 'result')
    .slice(-25)
    .reverse();

  return (
    <div className="mcp-exposed">
      <div className="mcp-exposed-head">
        <strong>MCP 서버 도구 {total}개</strong>
        <span className="small muted">
          {status?.connected ? '등록한 MCP 서버가 노출하는 도구입니다' : '연결되면 자동 주입됩니다'}
        </span>
      </div>
      {externals.filter((s) => s.tools.length > 0 || !s.connected).length === 0 ? (
        <div className="small muted pad">
          등록된 MCP 서버가 노출하는 도구가 여기 표시됩니다. 아직 없습니다 — 아래에서 "+ MCP 서버
          추가" 로 등록하거나, 에이전트에게 <code>McpAddServer</code> 로 요청하세요. (Shell·파일
          같은 커넥터 내장 도구는 MCP 서버가 아니라 PC 컨트롤·브라우저 탭에서 관리합니다.)
        </div>
      ) : (
        externals
          .filter((s) => s.tools.length > 0 || !s.connected)
          .map((s) => (
            <div key={s.name} className="mcp-exposed-group">
              <div className="mcp-exposed-server small muted">
                {s.name}
                {!s.connected && (
                  <span className="mcp-dot off" style={{ marginLeft: 6 }} title="연결 안 됨" />
                )}
                <span style={{ marginLeft: 6 }}>· {s.tools.length}</span>
              </div>
              <ul className="mcp-exposed-tools">
                {s.tools.map((t) => {
                  const key = `${s.name}/${t.name}`;
                  const open = openTool === key;
                  return (
                    <li key={key} className="mcp-exposed-tool">
                      <button
                        className="mcp-exposed-tool-btn"
                        onClick={() => setOpenTool(open ? null : key)}
                        aria-expanded={open}
                      >
                        <span className="mcp-exposed-tool-name">{t.name}</span>
                        {t.description && (
                          <span className="small muted mcp-exposed-tool-desc">
                            {firstLine(t.description)}
                          </span>
                        )}
                      </button>
                      {open && (
                        <pre className="mcp-exposed-schema">
                          {(t.description ? String(t.description).trim() + '\n\n' : '') +
                            (t.inputSchema
                              ? JSON.stringify(t.inputSchema, null, 2)
                              : '(입력 스키마 없음)')}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
      )}
      <button
        className="link small"
        onClick={() => setShowCalls((v) => !v)}
        style={{ marginTop: 6 }}
      >
        {showCalls ? '최근 호출 숨기기' : `최근 호출 보기 (${recentCalls.length})`}
      </button>
      {showCalls && (
        <ul className="mcp-exposed-calls">
          {recentCalls.length === 0 && <li className="small muted">아직 호출 기록이 없습니다.</li>}
          {recentCalls.map((l) => (
            <li key={l.id} className="small mcp-exposed-call">
              <span className={`mcp-dot ${l.ok === false ? 'off' : 'ok'}`} />
              <span className="mcp-exposed-call-tool">{l.tool || l.message}</span>
              {l.server && (
                <span className="muted"> · {l.server === 'local' ? '내 PC' : l.server}</span>
              )}
              {typeof l.durationMs === 'number' && (
                <span className="muted"> · {l.durationMs}ms</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const McpSettings: React.FC<{ onClose: () => void; embedded?: boolean }> = ({
  onClose,
  embedded,
}) => {
  // 모달로 떠 있을 때만 Esc 로 닫는다 — embedded(탭 안)에서는 닫을 대상이 없다.
  useModalDismiss(onClose, !embedded);
  const [enabled, setEnabled] = useState(false);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [status, setStatus] = useState<McpBridgeStatusLike | null>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<McpRuntimeLogEntryLike[]>([]);
  const [authBusy, setAuthBusy] = useState(false);
  const [authMsg, setAuthMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [oauthAuthorized, setOauthAuthorized] = useState<Record<string, boolean>>({});
  const [rowAuthBusy, setRowAuthBusy] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [test, setTest] = useState<TestState | null>(null);
  // 목록 행별 테스트 결과 (서버 이름 기준) — 편집 모드로 들어가지 않아도
  // 바로 [테스트] 할 수 있어야 한다.
  const [rowTest, setRowTest] = useState<Record<string, TestState>>({});
  // 표준 MCP 설정 JSON 붙여넣기
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    xgen.mcp
      .getEnabled()
      .then(setEnabled)
      .catch(() => undefined);
    xgen.mcp
      .listServers()
      .then(setServers)
      .catch(() => undefined);
    xgen.mcp
      .status()
      .then(setStatus)
      .catch(() => undefined);
    // 화면을 열 때 다시 붙여 본다 — 런타임을 나중에 설치했는데 예전 실패
    // 문구가 계속 남아 있으면 안 된다.
    xgen.mcp
      .refresh()
      .then(setStatus)
      .catch(() => undefined);
    // 최근 도구 호출 로그 — G10 노출 도구 패널의 "최근 호출" 섹션.
    xgen.mcp
      .runtimeLogs()
      .then((rows) => setRuntimeLogs(rows.slice(-100)))
      .catch(() => undefined);
    const offLog = xgen.mcp.onRuntimeLog((entry) =>
      setRuntimeLogs((prev) => [...prev, entry].slice(-100)),
    );
    const offStatus = xgen.mcp.onStatus(setStatus);
    // 기동 중인 서버의 출력을 실시간으로 받아 '멈춘 게 아니다'를 보여준다.
    const offProgress = xgen.mcp.onTestProgress(({ name, lines }) => {
      setRowTest((m) =>
        name && m[name]?.busy ? { ...m, [name]: { ...m[name], progress: lines } } : m,
      );
      setTest((t) => (t?.busy ? { ...t, progress: lines } : t));
    });
    return () => {
      offStatus();
      offProgress();
      offLog();
    };
  }, []);

  const toolCount = useMemo(
    () => (status?.servers ?? []).reduce((n, s) => n + (s.connected ? s.tools.length : 0), 0),
    [status],
  );

  const persist = async (next: McpServerConfig[]) => {
    setServers(next);
    await xgen.mcp.saveServers(next);
  };

  const startEdit = (i: number | 'new') => {
    setTest(null);
    if (i === 'new') setDraft(EMPTY_DRAFT);
    else setDraft(draftFromConfig(servers[i]));
    setEditing(i);
  };

  const saveDraft = async () => {
    const c = configFromDraft(draft);
    if (!c.name) return;
    // 'local' is the reserved namespace for the connector's built-in tools —
    // a configured server with that name would collide in the exposed-tools list.
    if (c.name.toLowerCase() === 'local') {
      setTest({ ok: false, msg: "'local' 은 내장 도구 예약 이름입니다. 다른 이름을 쓰세요." });
      return;
    }
    // 이름 변경 시: 저장(삭제정리) 전에 키체인 시크릿/OAuth 를 old→new 로 이관해
    // 이름 바꾸다 시크릿이 소실되는 것을 막는다.
    if (typeof editing === 'number' && servers[editing] && servers[editing].name !== c.name) {
      await xgen.mcp.renameSecrets(servers[editing].name, c.name).catch(() => undefined);
    }
    const next = [...servers];
    if (editing === 'new') next.push(c);
    else if (typeof editing === 'number') next[editing] = c;
    await persist(next);
    setEditing(null);
    // 저장하면 곧바로 붙여 결과(도구 수/오류)를 보여준다.
    xgen.mcp
      .refresh()
      .then(setStatus)
      .catch(() => undefined);
  };

  /** 붙여넣은 표준 JSON 을 서버 목록에 병합 (같은 이름은 덮어쓰기). */
  const importJson = async () => {
    setImportMsg(null);
    let parsed;
    try {
      parsed = parseMcpConfig(importText);
    } catch (e) {
      setImportMsg({
        ok: false,
        text: e instanceof McpImportError ? e.message : `가져오기 실패: ${String(e)}`,
      });
      return;
    }
    const next = [...servers];
    const added: string[] = [];
    const replaced: string[] = [];
    const skippedReserved: string[] = [];
    for (const s of parsed.servers) {
      if (s.name.toLowerCase() === 'local') {
        skippedReserved.push(s.name);
        continue;
      }
      const cfg: McpServerConfig = {
        name: s.name,
        transport: s.transport,
        enabled: s.enabled !== false,
        ...(s.transport === 'stdio'
          ? { command: s.command, args: s.args, env: s.env }
          : { url: s.url, headers: s.headers }),
      };
      const at = next.findIndex((x) => x.name === s.name);
      if (at >= 0) {
        next[at] = cfg;
        replaced.push(s.name);
      } else {
        next.push(cfg);
        added.push(s.name);
      }
    }
    await persist(next);
    const parts = [
      added.length ? `추가 ${added.length}개 (${added.join(', ')})` : '',
      replaced.length ? `덮어씀 ${replaced.length}개 (${replaced.join(', ')})` : '',
      ...parsed.warnings,
      skippedReserved.length ? `예약어 'local' 이름은 건너뜀 (${skippedReserved.join(', ')})` : '',
    ].filter(Boolean);
    setImportMsg({ ok: true, text: parts.join(' · ') });
    setImportText('');
  };

  /** 현재 목록을 표준 JSON 으로 복사 (다른 도구에 붙여넣기). */
  const copyJson = async () => {
    // 시크릿 값은 절대 내보내지 않는다 — 키만 남기고 값은 비운다(클립보드 유출 방지).
    const redact = (o?: Record<string, string>) =>
      o ? Object.fromEntries(Object.keys(o).map((k) => [k, ''])) : undefined;
    const payload: ImportedServer[] = servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      env: redact(s.env),
      url: s.url,
      headers: redact(s.headers),
      enabled: s.enabled,
    }));
    const ok = await copyText(toMcpConfigJson(payload));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const remove = async (i: number) => {
    const next = servers.filter((_, j) => j !== i);
    await persist(next);
  };

  const toggleServer = async (i: number) => {
    const next = servers.map((s, j) => (j === i ? { ...s, enabled: s.enabled === false } : s));
    await persist(next);
  };

  /** 편집 폼의 테스트 — 저장하지 않은 초안 그대로 시험한다. */
  const runTest = async () => {
    setTest({ busy: true, startedAt: Date.now() });
    setTest(await testConfig(configFromDraft(draft)));
  };

  /** 목록 행의 테스트 — 저장된 설정 그대로 시험한다. */
  const runRowTest = async (s: McpServerConfig) => {
    setRowTest((m) => ({ ...m, [s.name]: { busy: true, startedAt: Date.now() } }));
    const r = await testConfig(s);
    setRowTest((m) => ({ ...m, [s.name]: r }));
    // 테스트가 되면 실제 연결도 되어야 한다 — 브릿지에 다시 붙여 도구가
    // 에이전트에게 실제로 광고되게 하고, 낡은 실패 문구를 지운다.
    if (r.ok)
      xgen.mcp
        .refresh()
        .then(setStatus)
        .catch(() => undefined);
  };

  /** OAuth 2.1 인가 — 브라우저 로그인 흐름을 시작한다. */
  const authorizeDraft = async () => {
    // 미저장(new) 서버를 인가하면 토큰이 draft 이름으로 저장되는데, 저장 전 이름을
    // 바꾸면 토큰이 유실된다. 먼저 저장을 권장한다(막지는 않음).
    if (editing === 'new') {
      setAuthMsg({
        ok: false,
        text: '먼저 저장한 뒤 인가하세요 — 저장 전 이름을 바꾸면 인가 토큰이 유실됩니다.',
      });
      return;
    }
    setAuthBusy(true);
    setAuthMsg(null);
    try {
      const res = await xgen.mcp.authorize(configFromDraft(draft));
      setAuthMsg(
        res.ok
          ? { ok: true, text: '인가되었습니다 — 연결에 액세스 토큰이 자동 사용됩니다.' }
          : { ok: false, text: res.error || '인가에 실패했습니다.' },
      );
      if (res.ok)
        xgen.mcp
          .refresh()
          .then(setStatus)
          .catch(() => undefined);
    } catch (e) {
      setAuthMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setAuthBusy(false);
    }
  };

  // OAuth 서버들의 인가 상태를 조회해 행에 배지로 표시한다.
  useEffect(() => {
    let cancelled = false;
    const oauthServers = servers.filter((s) => s.auth === 'oauth').map((s) => s.name);
    if (!oauthServers.length) return;
    (async () => {
      const entries = await Promise.all(
        oauthServers.map(
          async (n) =>
            [
              n,
              (await xgen.mcp.oauthStatus(n).catch(() => ({ authorized: false }))).authorized,
            ] as const,
        ),
      );
      if (!cancelled) setOauthAuthorized(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [servers]);

  /** 행에서 OAuth 인가(또는 재인가) 실행. */
  const authorizeRow = async (s: McpServerConfig) => {
    setRowAuthBusy((m) => ({ ...m, [s.name]: true }));
    try {
      const res = await xgen.mcp.authorize(s);
      setRowTest((m) => ({
        ...m,
        [s.name]: { ok: res.ok, msg: res.ok ? '인가되었습니다.' : res.error || '인가 실패' },
      }));
      const st = await xgen.mcp.oauthStatus(s.name).catch(() => ({ authorized: false }));
      setOauthAuthorized((m) => ({ ...m, [s.name]: st.authorized }));
      if (res.ok)
        xgen.mcp
          .refresh()
          .then(setStatus)
          .catch(() => undefined);
    } finally {
      setRowAuthBusy((m) => ({ ...m, [s.name]: false }));
    }
  };

  /** 행에서 OAuth 연결 해제(토큰 삭제). */
  const disconnectOauth = async (s: McpServerConfig) => {
    await xgen.mcp.clearOauth(s.name).catch(() => undefined);
    setOauthAuthorized((m) => ({ ...m, [s.name]: false }));
    xgen.mcp
      .refresh()
      .then(setStatus)
      .catch(() => undefined);
  };

  // 본문은 모달/임베드(설정 [MCP] 탭) 양쪽에서 같은 것을 쓴다 — FileSystemSettings 동형.
  const body = (
    <>
      <p className="small muted" style={{ margin: '0 0 8px' }}>
        내 PC에서 MCP 서버를 실행해, 선택된 세션의 에이전트가 그 도구를 사용하게 합니다. 로그인
        상태에서만 연결됩니다.
      </p>

      <div className="field-row">
        <span>
          로컬 MCP 사용
          {enabled && (
            <span className="small muted" style={{ marginLeft: 8 }}>
              {status?.connected ? `연결됨 · 도구 ${toolCount}개` : '연결 대기 중…'}
              {status?.error ? ` · ${status.error}` : ''}
            </span>
          )}
        </span>
        <label className="switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              void xgen.mcp.setEnabled(e.target.checked);
            }}
          />
          <span className="track" />
        </label>
      </div>

      {enabled && <ExposedToolsPanel status={status} logs={runtimeLogs} />}

      <div className="mcp-list">
        {servers.length === 0 && <div className="muted small pad">등록된 MCP 서버가 없습니다.</div>}
        {servers.map((s, i) => {
          const st = status?.servers?.find((x) => x.name === s.name);
          return (
            <div key={s.name + i} className="mcp-item">
              <label
                className="switch small-switch"
                title={s.enabled === false ? '사용 안 함' : '사용'}
              >
                <input
                  type="checkbox"
                  checked={s.enabled !== false}
                  onChange={() => void toggleServer(i)}
                />
                <span className="track" />
              </label>
              <div className="mcp-item-body">
                <div className="mcp-item-name">
                  {s.name}
                  <span className="mcp-badge">{s.transport}</span>
                  {st && (
                    <span
                      className={`mcp-dot ${st.connected ? 'ok' : 'off'}`}
                      title={st.error || (st.connected ? '연결됨' : '연결 안 됨')}
                    />
                  )}
                  {st?.connected && <span className="small muted">도구 {st.tools.length}</span>}
                  {s.auth === 'oauth' && (
                    <span
                      className={`mcp-badge ${oauthAuthorized[s.name] ? 'notice-ok' : 'notice-warn'}`}
                    >
                      {oauthAuthorized[s.name] ? 'OAuth 인가됨' : 'OAuth 인가 필요'}
                    </span>
                  )}
                </div>
                <div className="mcp-item-cmd">
                  {s.transport === 'stdio'
                    ? toDisplayCommand(s.command ?? '', s.args ?? [])
                    : s.url}
                </div>
                {/* 테스트 결과가 있으면 그것을, 없으면 자동 연결 실패 사유를
                      그대로 보여준다 (툴팁에만 숨겨두면 아무도 못 본다). */}
                {rowTest[s.name] ? (
                  <TestResult state={rowTest[s.name]} />
                ) : (
                  st &&
                  !st.connected &&
                  st.error && <TestResult state={{ ok: false, msg: st.error }} />
                )}
              </div>
              <div className="mcp-item-actions">
                <button
                  className="link"
                  onClick={() => void runRowTest(s)}
                  disabled={rowTest[s.name]?.busy}
                >
                  테스트
                </button>
                {s.auth === 'oauth' && (
                  <button
                    className="link"
                    onClick={() => void authorizeRow(s)}
                    disabled={rowAuthBusy[s.name]}
                  >
                    {rowAuthBusy[s.name] ? '인가 중…' : oauthAuthorized[s.name] ? '재인가' : '인가'}
                  </button>
                )}
                {s.auth === 'oauth' && oauthAuthorized[s.name] && (
                  <button className="link" onClick={() => void disconnectOauth(s)}>
                    인가 해제
                  </button>
                )}
                <button className="link" onClick={() => startEdit(i)}>
                  편집
                </button>
                <button className="link" onClick={() => void remove(i)}>
                  삭제
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing === null ? (
        <>
          <div className="row" style={{ marginTop: 8, gap: 6 }}>
            <button className="secondary" onClick={() => startEdit('new')}>
              + MCP 서버 추가
            </button>
            <button
              className="secondary"
              onClick={() => {
                setImportOpen((v) => !v);
                setImportMsg(null);
              }}
            >
              {importOpen ? 'JSON 붙여넣기 닫기' : 'JSON 붙여넣기'}
            </button>
            {servers.length > 0 && (
              <button
                className="secondary"
                onClick={() => void copyJson()}
                title="현재 설정을 표준 JSON 으로 복사"
              >
                {copied ? '복사됨' : 'JSON 복사'}
              </button>
            )}
          </div>

          {importOpen && (
            <div className="mcp-form">
              <label className="field">
                <span>표준 MCP 설정 JSON</span>
                <textarea
                  rows={10}
                  className="mcp-textarea mcp-json"
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  spellCheck={false}
                  placeholder={JSON_PLACEHOLDER}
                />
              </label>
              <div className="small muted" style={{ marginTop: -2 }}>
                Claude Desktop·Cursor 등에서 쓰는 <code>mcpServers</code> 블록을 그대로
                붙여넣으세요. 같은 이름은 덮어씁니다.
              </div>
              {importMsg && (
                <div className={`small ${importMsg.ok ? 'notice-ok' : 'notice-warn'}`}>
                  {importMsg.text}
                </div>
              )}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  className="link"
                  onClick={() => {
                    setImportOpen(false);
                    setImportText('');
                    setImportMsg(null);
                  }}
                >
                  취소
                </button>
                <button
                  className="primary"
                  disabled={!importText.trim()}
                  onClick={() => void importJson()}
                >
                  가져오기
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mcp-form">
          <label className="field">
            <span>이름 (고유)</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="filesystem"
            />
          </label>
          <div className="field-row">
            <span>전송 방식</span>
            <div className="seg">
              {(['stdio', 'http', 'sse'] as const).map((t) => (
                <button
                  key={t}
                  className={draft.transport === t ? 'active' : ''}
                  onClick={() => setDraft({ ...draft, transport: t })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          {draft.transport === 'stdio' ? (
            <>
              <label className="field">
                <span>실행 명령</span>
                <input
                  value={draft.command}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
                />
              </label>
              <label className="field">
                <span>환경변수 (KEY=VALUE, 한 줄에 하나)</span>
                <textarea
                  className="mcp-textarea"
                  value={draft.envText}
                  onChange={(e) => setDraft({ ...draft, envText: e.target.value })}
                  placeholder={'API_TOKEN=xxxx'}
                  rows={2}
                />
                <span className="small muted">
                  값은 OS 키체인에 암호화 저장됩니다(설정 파일에 평문으로 남지 않음). 저장된 서버를
                  다시 열면 값은 비어 보이며, 비워 두면 기존 값이 유지되고 새 값을 입력하면
                  교체됩니다.
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>엔드포인트 URL (Streamable HTTP)</span>
                <input
                  value={draft.url}
                  onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
              <label className="field">
                <span>헤더 (Key: Value, 한 줄에 하나)</span>
                <textarea
                  className="mcp-textarea"
                  value={draft.headersText}
                  onChange={(e) => setDraft({ ...draft, headersText: e.target.value })}
                  placeholder={'Authorization: Bearer xxxx'}
                  rows={2}
                />
                <span className="small muted">
                  헤더 값은 OS 키체인에 암호화 저장됩니다. 저장된 서버를 다시 열면 값은 비어 보이며,
                  비워 두면 기존 값이 유지되고 새 값을 입력하면 교체됩니다.
                </span>
              </label>
              <div className="field">
                <span>인증</span>
                <Selector
                  value={draft.auth}
                  onChange={(v) => setDraft({ ...draft, auth: v as 'none' | 'oauth' })}
                  options={[
                    { value: 'none', label: '없음 (헤더/토큰 직접 입력)' },
                    { value: 'oauth', label: 'OAuth 2.1 (브라우저 로그인)' },
                  ]}
                  ariaLabel="인증 방식 선택"
                />
              </div>
              {draft.auth === 'oauth' && (
                <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: -4 }}>
                  <button
                    className="secondary"
                    onClick={() => void authorizeDraft()}
                    disabled={authBusy || !draft.url.trim() || !draft.name.trim()}
                  >
                    {authBusy ? '인가 중… (브라우저 확인)' : '브라우저로 인가하기'}
                  </button>
                  {authMsg && (
                    <span className={`small ${authMsg.ok ? 'notice-ok' : 'notice-warn'}`}>
                      {authMsg.text}
                    </span>
                  )}
                </div>
              )}
            </>
          )}

          {test && <TestResult state={test} />}

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
            <button className="link" onClick={() => setEditing(null)}>
              취소
            </button>
            <button className="secondary" onClick={() => void runTest()} disabled={test?.busy}>
              테스트
            </button>
            <button
              className="primary"
              onClick={() => void saveDraft()}
              disabled={!draft.name.trim()}
            >
              저장
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (embedded) return <div className="mcp-embed">{body}</div>;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>로컬 MCP</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        {body}
      </div>
    </div>
  );
};
