/**
 * 에이전트 상세 — 데스크톱 [에이전트] 보기와 같은 일곱 칸을 폰에 맞게 한 칸씩:
 *
 *   개요 · 메모리 · 작업 · 도구 · 앱 · 스토리지 · 실행 기록
 *
 * 읽기 전용이다(고치는 일은 대화로 시킨다). 앱은 폰 안에서 열고(app-viewer), 스토리지의 파일은 그려서
 * 보여 준다(file-preview). 판정과 말(실행 상태·연결된 도구 묶음)은 데스크톱과 같은 한 곳(@dex/protocol)이다.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  appDescription,
  connectedToolGroups,
  fmtDuration,
  formatBytes,
  isAppPreviewPath,
  myAppTags,
  traceStatus,
  type Agent,
  type AgentViewerSub,
  type AppSummary,
  type MemoryFile,
  type Span,
  type Task,
  type Trace,
  type WsNode,
} from '@dex/protocol';
import { MONO, TAP, alpha, useP, type Palette } from '../theme';
import type { XgenMobileClient } from '../lib/xgen';
import { serverLink } from '../lib/links';
import { friendlyError } from '../lib/errors';
import { ScreenModal } from '../lib/screen-modal';
import { AssistantMarkdown } from '../chat/markdown';
import { AppCard } from '../apps/apps-section';
import { AppViewer, myAppTarget, type AppViewTarget } from '../apps/app-viewer';
import { FilePreviewScreen, type PreviewFile } from '../files/file-preview';
import { folderEntries, folderTrail, parentOf, type FolderEntry } from '../files/workspace-tree';

const TABS: [AgentViewerSub, string][] = [
  ['basic', '개요'],
  ['memory', '메모리'],
  ['tasks', '작업'],
  ['tools', '도구'],
  ['apps', '앱'],
  ['storage', '스토리지'],
  ['fulllog', '실행 기록'],
];

/** 한 번 읽고, 당겨서 다시 읽는다. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    load()
      .then((v) => alive && setData(v))
      .catch((e) => alive && setError(friendlyError(e, '불러오지 못했습니다.')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

function when(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const AgentDetail: React.FC<{
  client: XgenMobileClient;
  agent: Agent | null;
  initialSub?: AgentViewerSub;
  onClose: () => void;
  /** [대화 시작] — 이 에이전트와 새 대화. */
  onOpenChat?: (agent: Agent) => void;
}> = ({ client, agent, initialSub = 'basic', onClose, onOpenChat }) => {
  const p = useP();
  const st = useMemo(() => makeStyles(p), [p]);
  const [sub, setSub] = useState<AgentViewerSub>(initialSub);
  useEffect(() => {
    if (agent) setSub(initialSub);
  }, [agent, initialSub]);
  const wf = agent?.workflowId ?? '';
  return (
    <ScreenModal
      visible={!!agent}
      title={agent?.workflowName || wf}
      subtitle="에이전트 상세"
      onClose={onClose}
      actions={agent && onOpenChat ? [{ icon: 'chatbubble-ellipses-outline', label: '대화 시작', onPress: () => onOpenChat(agent) }] : []}
    >
      {agent ? (
        <View style={{ flex: 1 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.tabsBar} contentContainerStyle={st.tabs}>
            {TABS.map(([id, label]) => (
              <Pressable
                key={id}
                onPress={() => setSub(id)}
                style={[st.tab, sub === id && st.tabOn]}
                accessibilityRole="tab"
                accessibilityState={{ selected: sub === id }}
              >
                <Text style={[st.tabText, sub === id && st.tabTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={{ flex: 1 }}>
            {sub === 'basic' && <Overview client={client} wf={wf} st={st} onGo={setSub} />}
            {sub === 'memory' && <MemoryTab client={client} wf={wf} st={st} />}
            {sub === 'tasks' && <TasksTab client={client} wf={wf} st={st} />}
            {sub === 'tools' && <ToolsTab client={client} wf={wf} st={st} />}
            {sub === 'apps' && <AppsTab client={client} wf={wf} name={agent.workflowName} st={st} />}
            {sub === 'storage' && <StorageTab client={client} wf={wf} name={agent.workflowName || wf} st={st} />}
            {sub === 'fulllog' && <RunsTab client={client} wf={wf} st={st} />}
          </View>
        </View>
      ) : null}
    </ScreenModal>
  );
};

type St = ReturnType<typeof makeStyles>;

const Note: React.FC<{ st: St; loading?: boolean; error?: string; empty?: string; onRetry?: () => void }> = ({ st, loading, error, empty, onRetry }) => {
  if (loading) return <ActivityIndicator style={{ marginTop: 28 }} />;
  if (error) {
    return (
      <View style={st.noteBox}>
        <Text style={st.noteText}>{error}</Text>
        {onRetry ? (
          <Pressable onPress={onRetry} style={st.smallBtn}>
            <Text style={st.smallBtnText}>다시 시도</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (empty) return <Text style={st.empty}>{empty}</Text>;
  return null;
};

// ── 개요 ──────────────────────────────────────────────────────────

const Overview: React.FC<{ client: XgenMobileClient; wf: string; st: St; onGo: (s: AgentViewerSub) => void }> = ({ client, wf, st, onGo }) => {
  const api = client.api.agentData;
  const info = useLoad(() => api.basicInfo(wf), [wf]);
  const counts = useLoad(
    async () => {
      const [memory, tasks, tools, apps] = await Promise.allSettled([api.memoryList(wf), api.tasksList(wf), api.toolsList(wf), api.appList(wf)]);
      const val = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
      return {
        memory: val(memory)?.files.length ?? null,
        tasks: (() => {
          const t = val(tasks);
          return t ? t.tasks.length + (t.jobs?.length ?? 0) : null;
        })(),
        tools: val(tools)?.tools.length ?? null,
        apps: val(apps)?.apps.length ?? null,
      };
    },
    [wf],
  );
  const runs = useLoad(() => api.traceList(wf, 1, 5), [wf]);
  const connected = useMemo(() => connectedToolGroups(info.data?.surfaces?.connector).reduce((n, g) => n + g.tools.length, 0), [info.data]);
  const metric = (label: string, value: number | null, go: AgentViewerSub) => (
    <Pressable key={label} onPress={() => onGo(go)} style={st.metric} accessibilityRole="button">
      <Text style={st.metricValue}>{value == null ? '…' : value}</Text>
      <Text style={st.metricLabel}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView
      contentContainerStyle={st.pad}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => (info.reload(), counts.reload(), runs.reload())} />}
    >
      <View style={st.card}>
        <Text style={st.cardLabel}>모델</Text>
        <Text style={st.cardTitle}>{info.data?.model || (info.loading ? '…' : '알 수 없음')}</Text>
        {info.data?.provider ? <Text style={st.muted}>{info.data.provider}</Text> : null}
        {info.error ? <Text style={st.errorText}>{info.error}</Text> : null}
      </View>
      <View style={st.metrics}>
        {metric('메모리', counts.data?.memory ?? null, 'memory')}
        {metric('작업', counts.data?.tasks ?? null, 'tasks')}
        {metric('연결된 도구', info.data ? connected : null, 'tools')}
        {metric('앱', counts.data?.apps ?? null, 'apps')}
      </View>
      <Text style={st.sectionTitle}>최근 실행</Text>
      <Note st={st} loading={runs.loading && !runs.data} error={runs.error} empty={runs.data && !runs.data.traces.length ? '아직 실행 기록이 없습니다.' : undefined} />
      {(runs.data?.traces ?? []).map((t) => (
        <TraceRow key={t.trace_id} t={t} st={st} />
      ))}
      {runs.data?.traces.length ? (
        <Pressable onPress={() => onGo('fulllog')} style={st.linkRow}>
          <Text style={st.link}>실행 기록 전체 보기</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
};

const TraceRow: React.FC<{ t: Trace; st: St; onPress?: () => void }> = ({ t, st, onPress }) => {
  const status = traceStatus(t);
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={st.row}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={st.rowTitle} numberOfLines={1}>
          {t.model_name || '실행'}
        </Text>
        <Text style={st.muted} numberOfLines={1}>
          {[when(t.created_at), t.duration_ms != null ? fmtDuration(t.duration_ms) : '', t.total_tool_calls ? `도구 ${t.total_tool_calls}회` : '']
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {t.error_message ? (
          <Text style={st.errorText} numberOfLines={2}>
            {t.error_message}
          </Text>
        ) : null}
      </View>
      <Text style={[st.badge, st[`tone_${status.tone}` as keyof St] as object]}>{status.label}</Text>
    </Pressable>
  );
};

// ── 메모리 ────────────────────────────────────────────────────────

const MemoryTab: React.FC<{ client: XgenMobileClient; wf: string; st: St }> = ({ client, wf, st }) => {
  const list = useLoad(() => client.api.agentData.memoryList(wf), [wf]);
  const [open, setOpen] = useState<MemoryFile | null>(null);
  const body = useLoad(() => (open ? client.api.agentData.memoryRead(wf, open.filename) : Promise.resolve(null)), [wf, open?.filename]);
  const files = useMemo(() => [...(list.data?.files ?? [])].sort((a, b) => String(b.modified ?? '').localeCompare(String(a.modified ?? ''))), [list.data]);
  return (
    <>
      <FlatList
        data={files}
        keyExtractor={(f) => f.filename}
        contentContainerStyle={st.pad}
        refreshControl={<RefreshControl refreshing={list.loading && !!list.data} onRefresh={list.reload} />}
        ListEmptyComponent={<Note st={st} loading={list.loading} error={list.error} empty="아직 기억한 것이 없습니다." onRetry={list.reload} />}
        renderItem={({ item: f }) => (
          <Pressable onPress={() => setOpen(f)} style={st.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.rowTitle} numberOfLines={1}>
                {f.title || f.filename}
              </Text>
              {f.first_paragraph ? (
                <Text style={st.muted} numberOfLines={2}>
                  {f.first_paragraph}
                </Text>
              ) : null}
              <Text style={st.mutedSmall}>{[f.category, when(f.modified)].filter(Boolean).join(' · ')}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={st.muted.color as string} />
          </Pressable>
        )}
      />
      <ScreenModal visible={!!open} title={open?.title || open?.filename || ''} subtitle="메모리" onClose={() => setOpen(null)}>
        <ScrollView contentContainerStyle={st.pad}>
          <Note st={st} loading={body.loading} error={body.error} />
          {body.data ? <AssistantMarkdown text={body.data.body} /> : null}
        </ScrollView>
      </ScreenModal>
    </>
  );
};

// ── 작업 ──────────────────────────────────────────────────────────

const TasksTab: React.FC<{ client: XgenMobileClient; wf: string; st: St }> = ({ client, wf, st }) => {
  const list = useLoad(() => client.api.agentData.tasksList(wf), [wf]);
  const [open, setOpen] = useState<Task | null>(null);
  const output = useLoad(() => (open ? client.api.agentData.taskOutput(wf, open.task_id) : Promise.resolve(null)), [wf, open?.task_id]);
  const jobs = list.data?.jobs ?? [];
  const tasks = list.data?.tasks ?? [];
  return (
    <>
      <ScrollView contentContainerStyle={st.pad} refreshControl={<RefreshControl refreshing={list.loading && !!list.data} onRefresh={list.reload} />}>
        <Note st={st} loading={list.loading && !list.data} error={list.error} onRetry={list.reload} />
        {jobs.length ? <Text style={st.sectionTitle}>예약한 작업</Text> : null}
        {jobs.map((j) => (
          <View key={j.session_id} style={st.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.rowTitle} numberOfLines={1}>
                {j.name || j.session_id}
              </Text>
              <Text style={st.muted} numberOfLines={1}>
                {[j.cron_expression || (j.interval_seconds ? `${j.interval_seconds}초마다` : j.schedule_type), j.next_execution_at ? `다음 ${when(j.next_execution_at)}` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Text style={st.badge}>{j.status || '예약'}</Text>
          </View>
        ))}
        {list.data ? <Text style={st.sectionTitle}>최근 작업</Text> : null}
        {list.data && !tasks.length ? <Text style={st.empty}>아직 작업이 없습니다.</Text> : null}
        {tasks.map((t) => (
          <Pressable key={t.task_id} onPress={() => setOpen(t)} style={st.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.rowTitle} numberOfLines={1}>
                {t.title || t.kind || t.task_id}
              </Text>
              <Text style={st.muted} numberOfLines={1}>
                {[when(t.created_at), t.duration_s != null ? `${Math.round(t.duration_s)}초` : ''].filter(Boolean).join(' · ')}
              </Text>
              {t.error ? (
                <Text style={st.errorText} numberOfLines={2}>
                  {t.error}
                </Text>
              ) : null}
            </View>
            <Text style={st.badge}>{t.status || '알 수 없음'}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScreenModal visible={!!open} title={open?.title || open?.kind || '작업'} subtitle="작업 결과" onClose={() => setOpen(null)}>
        <ScrollView contentContainerStyle={st.pad}>
          <Note st={st} loading={output.loading} error={output.error} />
          {output.data ? (
            <Text selectable style={st.code}>
              {output.data.result || output.data.output || '출력이 없습니다.'}
            </Text>
          ) : null}
        </ScrollView>
      </ScreenModal>
    </>
  );
};

// ── 도구 ──────────────────────────────────────────────────────────

const ToolsTab: React.FC<{ client: XgenMobileClient; wf: string; st: St }> = ({ client, wf, st }) => {
  const info = useLoad(() => client.api.agentData.basicInfo(wf), [wf]);
  const made = useLoad(() => client.api.agentData.toolsList(wf), [wf]);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => (open ? client.api.agentData.toolGet(wf, open) : Promise.resolve(null)), [wf, open]);
  const groups = useMemo(() => connectedToolGroups(info.data?.surfaces?.connector), [info.data]);
  return (
    <>
      <ScrollView contentContainerStyle={st.pad} refreshControl={<RefreshControl refreshing={false} onRefresh={() => (info.reload(), made.reload())} />}>
        <Text style={st.sectionTitle}>만든 도구</Text>
        <Note st={st} loading={made.loading && !made.data} error={made.error} empty={made.data && !made.data.tools.length ? '에이전트가 만든 도구가 없습니다.' : undefined} />
        {(made.data?.tools ?? []).map((t) => (
          <Pressable key={t.name} onPress={() => setOpen(t.name)} style={st.row}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.rowTitle}>{t.name}</Text>
              {t.description ? (
                <Text style={st.muted} numberOfLines={2}>
                  {t.description}
                </Text>
              ) : null}
            </View>
            <Text style={st.badge}>{t.enabled === false ? '꺼짐' : t.verified === false ? '확인 전' : '사용 중'}</Text>
          </Pressable>
        ))}
        <Text style={st.sectionTitle}>연결된 도구</Text>
        <Note st={st} loading={info.loading && !info.data} error={info.error} empty={info.data && !groups.length ? '연결된 도구가 없습니다.' : undefined} />
        {groups.map((g) => (
          <View key={g.key} style={st.card}>
            <Text style={st.cardLabel}>{g.title}</Text>
            {g.tools.map((t) => (
              <View key={t.name} style={{ marginTop: 8 }}>
                <Text style={st.rowTitle}>{t.name}</Text>
                {t.description ? (
                  <Text style={st.muted} numberOfLines={2}>
                    {t.description}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
      <ScreenModal visible={!!open} title={open ?? ''} subtitle="만든 도구" onClose={() => setOpen(null)}>
        <ScrollView contentContainerStyle={st.pad}>
          <Note st={st} loading={detail.loading} error={detail.error} />
          {detail.data ? (
            <>
              {detail.data.description ? <Text style={[st.muted, { marginBottom: 10 }]}>{detail.data.description}</Text> : null}
              {detail.data.last_test_error ? <Text style={st.errorText}>{detail.data.last_test_error}</Text> : null}
              {detail.data.source ? (
                <ScrollView horizontal>
                  <Text selectable style={st.code}>
                    {detail.data.source}
                  </Text>
                </ScrollView>
              ) : null}
            </>
          ) : null}
        </ScrollView>
      </ScreenModal>
    </>
  );
};

// ── 앱 ────────────────────────────────────────────────────────────

const AppsTab: React.FC<{ client: XgenMobileClient; wf: string; name?: string; st: St }> = ({ client, wf, name, st }) => {
  const list = useLoad(() => client.api.agentData.appList(wf), [wf]);
  const [viewing, setViewing] = useState<AppViewTarget | null>(null);
  const preview = (url?: string) =>
    url && isAppPreviewPath(url)
      ? { uri: serverLink(client.session.serverUrl, url), headers: { Authorization: `Bearer ${client.session.accessToken}` } }
      : null;
  const open = (app: AppSummary) => setViewing(myAppTarget(client, { ...app, workflow_id: wf, workflow_name: name }));
  return (
    <>
      <FlatList
        data={list.data?.apps ?? []}
        keyExtractor={(a) => a.slug}
        contentContainerStyle={[st.pad, { gap: 12 }]}
        refreshControl={<RefreshControl refreshing={list.loading && !!list.data} onRefresh={list.reload} />}
        ListEmptyComponent={<Note st={st} loading={list.loading} error={list.error} empty="이 에이전트가 만든 앱이 없습니다." onRetry={list.reload} />}
        renderItem={({ item: app }) => (
          <AppCard
            title={app.title}
            tags={myAppTags({ ...app, workflow_id: wf, workflow_name: '' })}
            description={appDescription(app)}
            kind={app.kind}
            preview={preview(app.preview_url)}
            onPreview={app.ready ? () => open(app) : undefined}
            actions={[{ label: '열기', strong: true, disabled: !app.ready, onPress: () => open(app) }]}
          />
        )}
      />
      <AppViewer client={client} target={viewing} onClose={() => setViewing(null)} />
    </>
  );
};

// ── 스토리지 ──────────────────────────────────────────────────────

const StorageTab: React.FC<{ client: XgenMobileClient; wf: string; name: string; st: St }> = ({ client, wf, name, st }) => {
  const list = useLoad(() => client.api.agentData.workspaceTree(wf), [wf]);
  const [dir, setDir] = useState('');
  const [file, setFile] = useState<PreviewFile | null>(null);
  const files: WsNode[] = list.data?.files ?? [];
  const entries = useMemo(() => folderEntries(files, dir), [files, dir]);
  const trail = folderTrail(dir);
  const open = (e: FolderEntry) => (e.isDir ? setDir(e.path) : setFile({ path: e.path, name: e.name, size: e.size }));
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={st.trailBar} contentContainerStyle={st.trail}>
        <Pressable onPress={() => setDir('')}>
          <Text style={[st.trailText, !dir && st.trailOn]}>{name}</Text>
        </Pressable>
        {trail.map((t) => (
          <React.Fragment key={t.path}>
            <Ionicons name="chevron-forward" size={13} color={st.muted.color as string} />
            <Pressable onPress={() => setDir(t.path)}>
              <Text style={[st.trailText, t.path === dir && st.trailOn]}>{t.name}</Text>
            </Pressable>
          </React.Fragment>
        ))}
      </ScrollView>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.path}
        contentContainerStyle={st.pad}
        refreshControl={<RefreshControl refreshing={list.loading && !!list.data} onRefresh={list.reload} />}
        ListHeaderComponent={
          dir ? (
            <Pressable onPress={() => setDir(parentOf(dir))} style={st.fileRow}>
              <Ionicons name="arrow-up" size={18} color={st.muted.color as string} />
              <Text style={st.fileName}>위 폴더</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={<Note st={st} loading={list.loading} error={list.error} empty="아직 저장된 파일이 없습니다." onRetry={list.reload} />}
        renderItem={({ item: e }) => (
          <Pressable onPress={() => open(e)} style={st.fileRow}>
            <Ionicons name={e.isDir ? 'folder' : fileIcon(e.name)} size={20} color={e.isDir ? '#E8A33D' : (st.muted.color as string)} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.fileName} numberOfLines={1}>
                {e.name}
              </Text>
              {!e.isDir ? <Text style={st.mutedSmall}>{[e.size != null ? formatBytes(e.size) : '', when(e.modifiedAt)].filter(Boolean).join(' · ')}</Text> : null}
            </View>
            <Ionicons name="chevron-forward" size={16} color={st.muted.color as string} />
          </Pressable>
        )}
      />
      <FilePreviewScreen client={client} workflowId={wf} file={file} onClose={() => setFile(null)} />
    </>
  );
};

function fileIcon(name: string): React.ComponentProps<typeof Ionicons>['name'] {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)) return 'image-outline';
  if (['md', 'txt', 'markdown'].includes(ext)) return 'document-text-outline';
  if (['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document-outline';
  if (['csv', 'tsv'].includes(ext)) return 'grid-outline';
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'musical-notes-outline';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'film-outline';
  return 'code-slash-outline';
}

// ── 실행 기록 ────────────────────────────────────────────────────

const PAGE = 20;

const RunsTab: React.FC<{ client: XgenMobileClient; wf: string; st: St }> = ({ client, wf, st }) => {
  const [page, setPage] = useState(1);
  const list = useLoad(() => client.api.agentData.traceList(wf, page, PAGE), [wf, page]);
  const [open, setOpen] = useState<Trace | null>(null);
  const detail = useLoad(() => (open ? client.api.agentData.traceDetail(open.trace_id) : Promise.resolve(null)), [open?.trace_id]);
  const total = list.data?.total ?? null;
  const hasNext = total == null ? (list.data?.traces.length ?? 0) >= PAGE : page * PAGE < total;
  const spans: Span[] = useMemo(() => [...(detail.data?.spans ?? [])].sort((a, b) => (a.span_order ?? 0) - (b.span_order ?? 0)), [detail.data]);
  return (
    <>
      <FlatList
        data={list.data?.traces ?? []}
        keyExtractor={(t) => t.trace_id}
        contentContainerStyle={st.pad}
        refreshControl={<RefreshControl refreshing={list.loading && !!list.data} onRefresh={list.reload} />}
        ListEmptyComponent={<Note st={st} loading={list.loading} error={list.error} empty="아직 실행 기록이 없습니다." onRetry={list.reload} />}
        renderItem={({ item: t }) => <TraceRow t={t} st={st} onPress={() => setOpen(t)} />}
        ListFooterComponent={
          list.data && (page > 1 || hasNext) ? (
            <View style={st.pager}>
              <Pressable disabled={page <= 1} onPress={() => setPage((n) => Math.max(1, n - 1))} style={[st.smallBtn, page <= 1 && { opacity: 0.4 }]}>
                <Text style={st.smallBtnText}>이전</Text>
              </Pressable>
              <Text style={st.muted}>{page}쪽</Text>
              <Pressable disabled={!hasNext} onPress={() => setPage((n) => n + 1)} style={[st.smallBtn, !hasNext && { opacity: 0.4 }]}>
                <Text style={st.smallBtnText}>다음</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
      <ScreenModal visible={!!open} title={open?.model_name || '실행'} subtitle={when(open?.created_at)} onClose={() => setOpen(null)}>
        <FlatList
          data={spans}
          keyExtractor={(s, i) => `${s.span_order ?? i}`}
          contentContainerStyle={st.pad}
          ListEmptyComponent={<Note st={st} loading={detail.loading} error={detail.error} empty="단계 기록이 없습니다." />}
          renderItem={({ item: s }) => (
            <View style={st.row}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={st.rowTitle} numberOfLines={1}>
                  {s.tool_name || spanLabel(s.span_type)}
                </Text>
                <Text style={st.mutedSmall}>{[spanLabel(s.span_type), s.duration_ms != null ? fmtDuration(s.duration_ms) : ''].filter(Boolean).join(' · ')}</Text>
                {s.error_message ? (
                  <Text style={st.errorText} numberOfLines={4}>
                    {s.error_message}
                  </Text>
                ) : null}
              </View>
            </View>
          )}
        />
      </ScreenModal>
    </>
  );
};

function spanLabel(type: string): string {
  return (
    ({ llm_call: '모델 호출', tool_call: '도구 호출', tool_output: '도구 결과', rag_search: '문서 검색', error: '오류', warning: '경고' } as Record<string, string>)[type] ??
    type
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    tabsBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: p.border, backgroundColor: p.panel },
    tabs: { paddingHorizontal: 8, gap: 4, alignItems: 'center' },
    tab: { height: 42, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
    tabOn: { borderBottomColor: p.primary },
    tabText: { color: p.muted, fontSize: 14, fontWeight: '600' },
    tabTextOn: { color: p.text, fontWeight: '800' },
    pad: { padding: 12, paddingBottom: 40 },
    card: { backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14, padding: 14, marginBottom: 12 },
    cardLabel: { color: p.muted, fontSize: 12, fontWeight: '700' },
    cardTitle: { color: p.text, fontSize: 18, fontWeight: '800', marginTop: 4 },
    metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 6 },
    metric: { flexBasis: '47%', flexGrow: 1, backgroundColor: p.panel, borderWidth: 1, borderColor: p.border, borderRadius: 14, padding: 14, minHeight: TAP },
    metricValue: { color: p.text, fontSize: 22, fontWeight: '800' },
    metricLabel: { color: p.muted, fontSize: 13, marginTop: 2 },
    sectionTitle: { color: p.text, fontSize: 15, fontWeight: '800', marginTop: 16, marginBottom: 8 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: p.panel,
      borderWidth: 1, borderColor: p.border, borderRadius: 12, padding: 12, marginBottom: 8, minHeight: TAP,
    },
    rowTitle: { color: p.text, fontSize: 14.5, fontWeight: '700' },
    muted: { color: p.muted, fontSize: 13, marginTop: 2 },
    mutedSmall: { color: p.muted, fontSize: 12, marginTop: 2 },
    errorText: { color: p.danger, fontSize: 12.5, marginTop: 4 },
    badge: { color: p.muted, fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: p.panel2, overflow: 'hidden' },
    tone_emerald: { color: p.ok, backgroundColor: alpha(p.ok, 14) },
    tone_red: { color: p.danger, backgroundColor: alpha(p.danger, 14) },
    tone_amber: { color: '#D97706', backgroundColor: alpha('#D97706', 14) },
    tone_gray: { color: p.muted },
    empty: { color: p.muted, textAlign: 'center', marginTop: 28, fontSize: 14 },
    noteBox: { alignItems: 'center', marginTop: 28, gap: 10 },
    noteText: { color: p.text, textAlign: 'center' },
    smallBtn: { height: 36, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: p.border, backgroundColor: p.panel, alignItems: 'center', justifyContent: 'center' },
    smallBtnText: { color: p.text, fontWeight: '700' },
    linkRow: { alignItems: 'center', paddingVertical: 10 },
    link: { color: p.primary, fontWeight: '700' },
    pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, paddingVertical: 12 },
    code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: p.text, backgroundColor: p.code, padding: 10, borderRadius: 8 },
    trailBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: p.border },
    trail: { paddingHorizontal: 12, gap: 6, alignItems: 'center', height: 40 },
    trailText: { color: p.muted, fontSize: 13.5, fontWeight: '600' },
    trailOn: { color: p.text, fontWeight: '800' },
    fileRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 10, minHeight: TAP,
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border,
    },
    fileName: { color: p.text, fontSize: 14.5, fontWeight: '600' },
  });
}

