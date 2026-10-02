/**
 * 에이전트 편집의 [MCP 서버] 칸 — 이 에이전트가 쓸 MCP 서버(명령 실행·주소). 에이전트를 저장할 때 같이 저장된다.
 *
 * 비밀(환경 변수·헤더의 값)은 저장된 뒤 화면에 돌아오지 않는다(키만 온다) — 값 칸을 비워 두면 저장된 값을 그대로
 * 쓰고, 새로 적으면 바뀐다. 표준 MCP 설정(Claude Desktop·Cursor 의 `mcpServers` JSON)을 붙여 넣어 한 번에 더할 수
 * 있다(Dex 와 같은 가져오기).
 */
import React, { useState } from 'react';
import type { McpServerConfig } from '../../../main/mcp-config';
import { xd } from '../bridge';
import { errorText } from '../data';
import { McpImportError, parseMcpConfig, PlusIcon, toDisplayCommand, TrashIcon } from '../dex';

type Transport = McpServerConfig['transport'];

const TRANSPORT_LABEL: Record<Transport, string> = { stdio: '명령 실행', http: '주소(HTTP)', sse: '주소(SSE)' };

/** `KEY=VALUE` 줄 ↔ 객체. */
const kvText = (o?: Record<string, string>) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    const key = (i < 0 ? line : line.slice(0, i)).trim();
    if (key) out[key] = i < 0 ? '' : line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

const summary = (s: McpServerConfig) => (s.transport === 'stdio' ? toDisplayCommand(s.command ?? '', s.args) : s.url ?? '');

type Probe = { state: 'busy' } | { state: 'ok'; tools: number } | { state: 'fail'; reason: string; detail?: string };

/** 연결 확인의 실패 → 한 문장(엔진의 원문은 풍선 도움말로). */
function failReason(error: string | undefined): string {
  const e = (error ?? '').toLowerCase();
  // HTTP 상태가 먼저 — "404 Not Found" 를 "명령을 찾을 수 없다" 로 읽지 않게.
  if (/\b(401|403)\b/.test(e) || e.includes('unauthorized') || e.includes('forbidden')) return '서버가 인증을 받아 주지 않았습니다.';
  if (/\b404\b/.test(e)) return '그 주소에 MCP 서버가 없습니다.';
  if (e.includes('filenotfound') || e.includes('no such file') || e.includes('enoent')) return '명령을 찾을 수 없습니다.';
  if (e.includes('timed out') || e.includes('timeout')) return '서버가 시간 안에 응답하지 않았습니다.';
  if (e.includes('connect') || e.includes('unreachable')) return '서버에 닿지 않습니다.';
  return '서버에 연결하지 못했습니다.';
}

const ProbeLine: React.FC<{ probe?: Probe }> = ({ probe }) => {
  if (!probe) return null;
  if (probe.state === 'busy') return <span className="xd-probe busy">확인하는 중…</span>;
  if (probe.state === 'ok') return <span className="xd-probe ok">연결됨 · 도구 {probe.tools}개</span>;
  return (
    <span className="xd-probe fail" title={probe.detail}>
      {probe.reason}
    </span>
  );
};

interface Draft {
  /** 저장된 서버를 고칠 때 그 원래 이름 — 이름을 바꾸면 저장된 비밀을 이어받으려고(previousName). */
  origin?: string;
  name: string;
  transport: Transport;
  line: string;
  /** 표준 설정에서 가져온 서버의 인자(따로 보존 — 한 줄로 합쳤다 쪼개면 공백이 든 인자가 깨진다). */
  args?: string[];
  kv: string;
  enabled: boolean;
}

const toDraft = (s?: McpServerConfig): Draft => ({
  origin: s ? s.previousName ?? s.name : undefined,
  name: s?.name ?? '',
  transport: s?.transport ?? 'stdio',
  line: s ? (s.transport === 'stdio' ? s.command ?? '' : s.url ?? '') : '',
  args: s?.args,
  kv: kvText(s?.transport === 'stdio' ? s?.env : s?.headers),
  enabled: s?.enabled !== false,
});

function fromDraft(d: Draft): McpServerConfig {
  const kv = parseKv(d.kv);
  const name = d.name.trim();
  const renamed = d.origin && d.origin !== name ? { previousName: d.origin } : {};
  return d.transport === 'stdio'
    ? { name, ...renamed, transport: 'stdio', command: d.line.trim(), ...(d.args ? { args: d.args } : {}), ...(kv ? { env: kv } : {}), enabled: d.enabled }
    : { name, ...renamed, transport: d.transport, url: d.line.trim(), ...(kv ? { headers: kv } : {}), enabled: d.enabled };
}

export const McpServers: React.FC<{
  value: McpServerConfig[];
  onChange: (next: McpServerConfig[]) => void;
  /** 저장된 에이전트면 그 id — 연결 확인에서 저장된 비밀을 쓴다. */
  agentId: string | null;
}> = ({ value, onChange, agentId }) => {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(toDraft());
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [note, setNote] = useState('');

  const test = async (key: string, server: McpServerConfig) => {
    setProbes((p) => ({ ...p, [key]: { state: 'busy' } }));
    try {
      const res = await xd.mcp.test({ server, agentId });
      setProbes((p) => ({ ...p, [key]: res.ok ? { state: 'ok', tools: res.tools.length } : { state: 'fail', reason: failReason(res.error), detail: res.error } }));
    } catch (e) {
      setProbes((p) => ({ ...p, [key]: { state: 'fail', reason: errorText(e, '서버 설정이 올바르지 않습니다.') } }));
    }
  };

  const nameTaken = (name: string, except: number | 'new' | null) =>
    value.some((s, i) => i !== except && s.name.toLowerCase() === name.trim().toLowerCase());

  /** 바뀐 서버의 지난 확인 결과는 걷는다(이름으로 묶여 있다). */
  const forget = (...names: string[]) =>
    setProbes((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !names.includes(k))));

  const apply = () => {
    const server = fromDraft(draft);
    forget(server.name, typeof editing === 'number' ? value[editing].name : '');
    if (editing === 'new') onChange([...value, server]);
    else if (typeof editing === 'number') onChange(value.map((s, i) => (i === editing ? server : s)));
    setEditing(null);
  };

  const importServers = () => {
    setNote('');
    try {
      const { servers } = parseMcpConfig(importText);
      const fresh = servers.filter((s) => !value.some((v) => v.name.toLowerCase() === s.name.toLowerCase()));
      onChange([...value, ...fresh.map((s) => ({ ...s, enabled: s.enabled !== false }))]);
      setNote(fresh.length < servers.length ? '이름이 같은 서버는 빼고 더했습니다.' : '');
      setImporting(false);
      setImportText('');
    } catch (e) {
      setNote(e instanceof McpImportError ? '설정을 읽지 못했으니 MCP 설정 JSON 을 붙여 넣으세요.' : errorText(e, '설정을 읽지 못했습니다.'));
    }
  };

  const draftValid = draft.name.trim() && draft.line.trim() && !nameTaken(draft.name, editing) && (draft.transport === 'stdio' || /^https?:\/\//i.test(draft.line.trim()));

  return (
    <section className="xd-card">
      <h3>MCP 서버</h3>
      <p className="muted small">이 에이전트가 도구로 쓸 MCP 서버이며, 서버가 하는 일은 이 PC 에서 그대로 일어납니다.</p>
      {value.map((s, i) =>
        editing === i ? null : (
          <div key={s.name} className="xd-mcp-row">
            <label className="xd-mcp-toggle" title={s.enabled === false ? '꺼 둠' : '켜 둠'}>
              <input
                type="checkbox"
                checked={s.enabled !== false}
                disabled={editing !== null}
                aria-label={`${s.name} 쓰기`}
                onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
              />
            </label>
            <div className="xd-mcp-main">
              <strong>{s.name}</strong>
              <span className="muted small" title={summary(s)}>
                {TRANSPORT_LABEL[s.transport]} · {summary(s)}
              </span>
              <ProbeLine probe={probes[s.name]} />
            </div>
            {/* 다른 서버를 고치는 동안은 손대지 않는다 — 지우면 고치던 자리가 밀려 엉뚱한 서버를 덮는다. */}
            {editing === null && (
              <>
                <button type="button" className="secondary" disabled={probes[s.name]?.state === 'busy'} onClick={() => void test(s.name, s)}>
                  연결 확인
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setDraft(toDraft(s));
                    forget('__draft');
                    setEditing(i);
                  }}
                >
                  고치기
                </button>
                <button
                  type="button"
                  className="icon-btn sm"
                  aria-label={`${s.name} 빼기`}
                  onClick={() => {
                    forget(s.name);
                    onChange(value.filter((_, j) => j !== i));
                  }}
                >
                  <TrashIcon size={13} />
                </button>
              </>
            )}
          </div>
        ),
      )}

      {editing !== null && (
        <div className="xd-add xd-mcp-form">
          <label className="field">
            <span>이름</span>
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="예: GitHub" maxLength={60} />
          </label>
          {draft.name.trim() && nameTaken(draft.name, editing) && <p className="voice-error small">같은 이름의 서버가 이미 있습니다.</p>}
          <div className="xd-kind-picker" role="radiogroup" aria-label="연결 방식">
            {(Object.keys(TRANSPORT_LABEL) as Transport[]).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={draft.transport === t}
                className={`chip${draft.transport === t ? ' active' : ''}`}
                onClick={() => setDraft((d) => ({ ...d, transport: t, args: undefined }))}
              >
                {TRANSPORT_LABEL[t]}
              </button>
            ))}
          </div>
          <label className="field">
            <span>{draft.transport === 'stdio' ? '실행할 명령' : '서버 주소'}</span>
            <input
              value={draft.args ? toDisplayCommand(draft.line, draft.args) : draft.line}
              onChange={(e) => setDraft((d) => ({ ...d, line: e.target.value, args: undefined }))}
              placeholder={draft.transport === 'stdio' ? '예: npx -y @modelcontextprotocol/server-github' : 'https://example.com/mcp'}
            />
          </label>
          <label className="field">
            <span>{draft.transport === 'stdio' ? '환경 변수(한 줄에 이름=값)' : '헤더(한 줄에 이름=값)'}</span>
            <textarea
              rows={3}
              value={draft.kv}
              onChange={(e) => setDraft((d) => ({ ...d, kv: e.target.value }))}
              placeholder={draft.transport === 'stdio' ? 'GITHUB_TOKEN=…' : 'Authorization=Bearer …'}
            />
          </label>
          <p className="muted small">값은 이 PC 에만 두고, 저장한 값은 다시 보이지 않으니 값을 비워 두면 저장된 값을 씁니다.</p>
          <ProbeLine probe={probes.__draft} />
          <div className="xd-actions">
            <button type="button" className="secondary" disabled={!draftValid || probes.__draft?.state === 'busy'} onClick={() => void test('__draft', fromDraft(draft))}>
              연결 확인
            </button>
            <button type="button" className="primary" disabled={!draftValid} onClick={apply}>
              {editing === 'new' ? '더하기' : '적용'}
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(null)}>
              취소
            </button>
          </div>
        </div>
      )}

      {importing && (
        <div className="xd-add">
          <label className="field">
            <span>MCP 설정 JSON</span>
            <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }'} />
          </label>
          <div className="xd-actions">
            <button type="button" className="primary" disabled={!importText.trim()} onClick={importServers}>
              가져오기
            </button>
            <button type="button" className="secondary" onClick={() => setImporting(false)}>
              취소
            </button>
          </div>
        </div>
      )}
      {note && <p className="muted small">{note}</p>}

      {editing === null && !importing && (
        <div className="xd-actions">
          <button
            type="button"
            className="secondary xd-inline-btn"
            onClick={() => {
              setDraft(toDraft());
              forget('__draft');
              setEditing('new');
            }}
          >
            <PlusIcon size={13} /> 서버 더하기
          </button>
          <button type="button" className="secondary" onClick={() => setImporting(true)}>
            설정 붙여 넣기
          </button>
        </div>
      )}
    </section>
  );
};
