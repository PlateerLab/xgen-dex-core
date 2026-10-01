/**
 * 작업 과정 타임라인 — 데스크톱 ProcessTimeline 과 같은 것을 폰 자리에 맞춰 그린다.
 *
 * 무엇이 없었나 (2026-10-01 사용자 보고)
 * --------------------------------------
 * 폰에는 답변 위를 지나가는 칩 한 칸뿐이었다. 웹·데스크톱은 "작업 중 7분 18초 · 도구 24회" 머리 줄 아래
 * 단계와 도구(종류 배지·설명·소요 시간·실패 표시)를 쌓아 보여 주는데, 같은 턴을 폰으로 열면 글 몇 줄만
 * 보였다. 어디서 열어도 같은 것을 봐야 한다.
 *
 * - 단계·도구 이름표·결과 모양은 전부 정본(@dex/protocol process-timeline)의 규칙이다. 여기는 그리기만 한다.
 * - 실행 중에는 펼쳐서 단계와 도구를 실시간으로, 끝나면 한 줄 요약으로 접는다(눌러서 다시 펼친다).
 * - 짧게 끝나는 도구는 실행 중 표시를 건너뛴다 — 번쩍였다 사라지면 고장처럼 보인다.
 * - 도구 한 줄을 누르면 [도구 실행 기록] 이 그 호출을 펼친 채 열린다(입력·결과 전문, 복사).
 * - 마지막 단계에 도구가 없으면 그 글이 답이다 — 타임라인 아래 본문으로 그린다.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  buildSteps,
  describeTool,
  resultView,
  shortToolName,
  splitFirstParagraph,
  trimAnswer,
  type ResultView,
  type TimelineFlowItem,
  type TimelineRow,
  type ToolEvent,
  type ToolIcon,
} from '@dex/protocol';
import { PALETTES, alpha, useP, type Palette } from '../theme';
import { AssistantMarkdown } from './markdown';
import type { ChatMessage } from './message-model';

/** 이벤트가 이 시간 넘게 없으면 "다음 단계를 준비하고 있어요" 줄을 띄운다. */
const IDLE_HINT_MS = 2500;
/** 도구가 이만큼 넘게 돌 때만 "실행 중" 으로 보여 준다 — 0.1~0.3초 도구가 번쩍이지 않게. */
const RUNNING_VISIBLE_MS = 700;
/** 이보다 오래 걸린 도구는 소요 시간을 눈에 띄게. */
const SLOW_TOOL_MS = 10_000;

const visiblyRunning = (row: TimelineRow, now: number): boolean =>
  row.phase === 'run' && now - row.startedAt >= RUNNING_VISIBLE_MS;

const fmtSec = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const fmtDuration = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;

/** 이 답변을 타임라인으로 그릴 수 있는가 — 순서를 알고, 도구를 한 번이라도 불렀을 때. */
export const hasProcessFlow = (m: ChatMessage): boolean =>
  m.role === 'assistant' && !!m.flow && m.flow.some((item) => item.kind === 'tool');

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const ICONS: Record<ToolIcon, IconName> = {
  terminal: 'terminal-outline',
  package: 'cube-outline',
  search: 'search-outline',
  file: 'document-text-outline',
  edit: 'create-outline',
  web: 'globe-outline',
  list: 'list-outline',
  external: 'extension-puzzle-outline',
};

/** 도구 종류별 배지 색 — 데스크톱과 같은 색, 어두운 화면에서는 밝은 쪽. */
function kindColor(kind: ToolIcon, p: Palette): { fg: string; bg: string } {
  const dark = p === PALETTES.dark;
  const pick = (light: string, darkFg: string, base: string, pct: number) => ({
    fg: dark ? darkFg : light,
    bg: alpha(base, dark ? pct + 8 : pct),
  });
  switch (kind) {
    case 'package':
      return pick('#B45309', '#FBBF24', '#F59E0B', 14);
    case 'search':
      return pick('#7C3AED', '#C4B5FD', '#7C3AED', 11);
    case 'file':
      return pick('#2563EB', '#93C5FD', '#2563EB', 11);
    case 'edit':
      return pick('#0F766E', '#5EEAD4', '#0D9488', 12);
    case 'web':
      return pick('#0E7490', '#67E8F9', '#0891B2', 12);
    case 'external':
      return { fg: '#FFFFFF', bg: p.primary };
    default:
      return pick('#334155', '#CBD5E1', '#475569', 10);
  }
}

/** 스트리밍 중에만 1초마다 다시 그려 경과 초를 올린다. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** 실행 중 진행선 — 좌에서 우로 흐르는 브랜드 색 막대. */
const ProgressLine: React.FC = () => {
  const p = useP();
  const x = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(x, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [x]);
  const bar = width * 0.4;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height: 2, borderRadius: 2, overflow: 'hidden', backgroundColor: alpha(p.primary, 14), marginTop: 8 }}
    >
      <Animated.View
        style={{
          width: bar,
          height: 2,
          borderRadius: 2,
          backgroundColor: p.primary,
          transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-bar, width + bar] }) }],
        }}
      />
    </View>
  );
};

/** 실행 중 머리 점 — 천천히 숨 쉰다. */
const Pulse: React.FC = () => {
  const p = useP();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.35, duration: 800, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={{ opacity: v, width: 9, height: 9, borderRadius: 5, backgroundColor: p.primary }} />
    </View>
  );
};

/** 도구 결과 — JSON 모양대로(카드·표·키값), 아니면 첫 줄. */
const ResultBlock: React.FC<{ view: ResultView }> = ({ view }) => {
  const p = useP();
  if (view.line !== undefined && !view.title && !view.table) {
    return (
      <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12, paddingLeft: 48, paddingRight: 12, paddingBottom: 8, marginTop: -3 }}>
        {view.line}
      </Text>
    );
  }
  return (
    <View
      style={{
        marginLeft: 48,
        marginRight: 12,
        marginBottom: 10,
        gap: 6,
        ...(view.title
          ? {
              borderWidth: 1,
              borderColor: alpha(p.primary, 30),
              backgroundColor: alpha(p.primary, 8),
              borderRadius: 10,
              paddingHorizontal: 10,
              paddingVertical: 8,
            }
          : {}),
      }}
    >
      {view.title ? (
        <Text numberOfLines={2} style={{ color: p.text, fontSize: 13.5, fontWeight: '600' }}>
          {view.title}
        </Text>
      ) : null}
      {view.fields.length > 0 || view.flags.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 3 }}>
          {view.fields.map(([k, v]) => (
            <Text key={`f-${k}`} numberOfLines={1} style={{ color: p.text, fontSize: 12, maxWidth: '100%' }}>
              <Text style={{ color: p.muted }}>{k} </Text>
              {v}
            </Text>
          ))}
          {view.flags.map(([k, on]) => (
            <Text key={`b-${k}`} style={{ color: on ? p.ok : p.muted, fontSize: 12 }}>
              {k} {on ? '✓' : '✗'}
            </Text>
          ))}
        </View>
      ) : null}
      {view.table ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ borderWidth: 1, borderColor: p.border, borderRadius: 8, overflow: 'hidden' }}>
              {[view.table.columns, ...view.table.rows].map((cells, r) => (
                <View
                  key={r}
                  style={{
                    flexDirection: 'row',
                    backgroundColor: r === 0 ? p.panel2 : 'transparent',
                    borderTopWidth: r === 0 ? 0 : 1,
                    borderTopColor: p.border,
                  }}
                >
                  {cells.map((cell, c) => (
                    <Text
                      key={c}
                      numberOfLines={1}
                      style={{
                        width: 110,
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        color: r === 0 ? p.muted : p.text,
                        fontSize: 11.5,
                        fontWeight: r === 0 ? '600' : '400',
                      }}
                    >
                      {cell}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          </ScrollView>
          {view.table.more > 0 ? (
            <Text style={{ color: p.muted, fontSize: 11, marginTop: 3 }}>외 {view.table.more}건</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

const ToolRowView: React.FC<{
  row: TimelineRow;
  now: number;
  first: boolean;
  onOpen: () => void;
}> = ({ row, now, first, onOpen }) => {
  const p = useP();
  const d = describeTool(row.name, row.input);
  const external = d.icon === 'external';
  const view = row.phase === 'run' ? null : resultView(row.error ?? row.result);
  // 기본 도구가 돌려준 키·값뿐인 JSON(환경 id 같은 것)은 잡음이다 — 표·카드·글 첫 줄만 보인다.
  const shown = view && (external || view.line !== undefined || view.title || view.table) ? view : null;
  const showRunning = visiblyRunning(row, now);
  const color = kindColor(d.icon, p);
  const dur = row.durationMs;
  const failed = row.phase === 'err';
  const pill = (label: string, fg: string, bg: string) => (
    <View style={{ borderRadius: 999, paddingHorizontal: 8, backgroundColor: bg }}>
      <Text style={{ color: fg, fontSize: 11, lineHeight: 18, fontVariant: ['tabular-nums'] }}>{label}</Text>
    </View>
  );
  const status =
    row.phase === 'run' ? (
      showRunning ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <ActivityIndicator size="small" color={p.primary} style={{ transform: [{ scale: 0.7 }] }} />
          <Text style={{ color: p.primary, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
            {fmtSec(now - row.startedAt)}
          </Text>
        </View>
      ) : null
    ) : failed ? (
      pill(`실패${dur !== undefined ? ` · ${fmtDuration(dur)}` : ''}`, p.danger, alpha(p.danger, 12))
    ) : dur !== undefined ? (
      dur >= SLOW_TOOL_MS
        ? pill(fmtDuration(dur), '#B45309', alpha('#F59E0B', 16))
        : pill(fmtDuration(dur), p.muted, p.panel2)
    ) : null;
  return (
    <View
      style={{
        borderTopWidth: first ? 0 : 1,
        borderTopColor: alpha(p.border, 70),
        backgroundColor: showRunning ? alpha(p.primary, 8) : 'transparent',
      }}
    >
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${shortToolName(row.name)} — 눌러서 입력과 결과 보기`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 8,
          minHeight: 42,
          backgroundColor: pressed ? p.panel2 : 'transparent',
        })}
      >
        <View
          style={{
            width: 26,
            height: 26,
            borderRadius: 8,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: color.bg,
          }}
        >
          <Ionicons name={ICONS[d.icon]} size={14} color={color.fg} />
        </View>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            fontSize: 13.5,
            color: failed ? p.danger : row.phase === 'run' && !showRunning ? p.muted : p.text,
          }}
        >
          {d.text}
        </Text>
        {status}
      </Pressable>
      {shown ? <ResultBlock view={shown} /> : null}
    </View>
  );
};

type StepPhase = 'run' | 'err' | 'pending' | 'ok';

const StepNode: React.FC<{ phase: StepPhase; n: number }> = ({ phase, n }) => {
  const p = useP();
  const tone =
    phase === 'ok'
      ? { fg: p.ok, bg: alpha(p.ok, 14), border: 'transparent' }
      : phase === 'err'
        ? { fg: p.danger, bg: alpha(p.danger, 12), border: alpha(p.danger, 40) }
        : phase === 'run'
          ? { fg: p.primary, bg: alpha(p.primary, 12), border: alpha(p.primary, 45) }
          : { fg: p.muted, bg: p.panel, border: p.border };
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 1.5,
        borderColor: tone.border,
        backgroundColor: tone.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {phase === 'ok' ? (
        <Ionicons name="checkmark" size={13} color={tone.fg} />
      ) : phase === 'err' ? (
        <Text style={{ color: tone.fg, fontSize: 11, fontWeight: '800' }}>!</Text>
      ) : (
        <Text style={{ color: tone.fg, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{n}</Text>
      )}
    </View>
  );
};

export const ProcessTimeline: React.FC<{
  message: ChatMessage;
  /** 글 조각의 표시용 정리(에이전트 마커 제거) — 본문과 같은 규칙. */
  clean: (text: string) => string;
  /** 도구 한 줄을 눌렀다 — 그 호출을 펼친 채 전체 기록을 연다. */
  onOpenLog: (events: ToolEvent[], initialOpen?: number) => void;
  /** 답 본문 아래 깜빡이는 자리. */
  caret?: React.ReactNode;
}> = ({ message: m, clean, onOpenLog, caret }) => {
  const p = useP();
  const live = !!m.streaming || !!m.remotePartial;
  const now = useNow(live);
  // 펼침: 사용자가 누르기 전에는 실행 중이면 펼치고, 끝나면 접는다.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const expanded = manualOpen ?? live;
  const flow = useMemo<TimelineFlowItem[]>(
    () => (m.flow ?? []).map((item) => (item.kind === 'text' ? { ...item, text: clean(item.text) } : item)),
    [m.flow, clean],
  );
  const steps = useMemo(() => buildSteps(flow), [flow]);

  const allRows = steps.flatMap((s) => s.rows);
  const running = allRows.find((r) => visiblyRunning(r, now));
  const anyRunning = allRows.some((r) => r.phase === 'run');
  const failed = allRows.filter((r) => r.phase === 'err').length;
  const startedAt = m.startedAt ?? flow[0]?.at ?? now;
  const lastAt = m.lastEventAt ?? startedAt;
  const tools = m.tools ?? [];
  const openRow = (row: TimelineRow, index: number): void => {
    const at = tools.findIndex((t) => (t.toolUseId || t.runId) === row.key);
    onOpenLog([...tools], at >= 0 ? at : index < tools.length ? index : undefined);
  };

  // 마지막 단계에 도구가 없으면 그 뒤 본문은 최종 답이다.
  let answer = '';
  let stepNo = 0;
  let rowIndex = 0;
  const rendered = steps.map((step, i) => {
    const last = i === steps.length - 1;
    let { title, body } = splitFirstParagraph(step.text);
    if (last && step.rows.length === 0) {
      if (body) {
        answer = trimAnswer(body);
      } else if (!live) {
        answer = trimAnswer(title);
        title = '';
      }
    } else if (body) {
      title = `${title} ${body.replace(/\s+/g, ' ').trim()}`;
    }
    const firstRow = rowIndex;
    rowIndex += step.rows.length;
    if (!title && step.rows.length === 0) return null;
    stepNo += 1;
    const typing = last && live && step.rows.length === 0 && !answer;
    const phase: StepPhase =
      step.rows.some((r) => visiblyRunning(r, now)) || typing
        ? 'run'
        : step.rows.some((r) => r.phase === 'err')
          ? 'err'
          : step.rows.some((r) => r.phase === 'run')
            ? 'pending'
            : 'ok';
    const current = live && last;
    return (
      <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ alignItems: 'center', width: 22 }}>
          <StepNode phase={phase} n={stepNo} />
          {!last ? (
            <View style={{ flex: 1, width: 2, borderRadius: 1, marginVertical: 3, backgroundColor: phase === 'ok' ? alpha(p.ok, 35) : p.border }} />
          ) : null}
        </View>
        <View style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 14, gap: 8 }}>
          {title ? (
            <Text style={{ color: current ? p.primary : p.text, fontSize: 14, fontWeight: '500', lineHeight: 22 }}>
              {title}
            </Text>
          ) : null}
          {step.rows.length > 0 ? (
            <View
              style={{
                borderWidth: 1,
                borderColor: p.border,
                borderRadius: 12,
                backgroundColor: p.panel,
                overflow: 'hidden',
              }}
            >
              {step.rows.map((row, j) => (
                <ToolRowView key={row.key} row={row} now={now} first={j === 0} onOpen={() => openRow(row, firstRow + j)} />
              ))}
            </View>
          ) : null}
        </View>
      </View>
    );
  });

  const idle = live && !anyRunning && !answer && now - lastAt >= IDLE_HINT_MS;
  const summary = live
    ? `${fmtSec(now - startedAt)} · 도구 ${allRows.length}회${running ? ` · ${shortToolName(running.name)} 실행 중` : ''}`
    : `${stepNo}단계 · 도구 ${allRows.length}회${failed ? ` · 실패 ${failed}` : ''} · ${fmtSec(lastAt - startedAt)}`;

  return (
    <View style={{ minWidth: 0 }}>
      <Pressable
        onPress={() => setManualOpen(!expanded)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${live ? '작업 중' : '작업 과정'} ${summary} — 눌러서 ${expanded ? '접기' : '펼치기'}`}
        hitSlop={6}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          alignSelf: 'flex-start',
          maxWidth: '100%',
          paddingVertical: 5,
          paddingLeft: 6,
          paddingRight: 12,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: !live && !expanded ? p.border : 'transparent',
          backgroundColor: pressed || (!live && !expanded) ? p.panel2 : 'transparent',
        })}
      >
        {live ? (
          <Pulse />
        ) : (
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: alpha(p.ok, 14),
            }}
          >
            <Ionicons name="checkmark" size={11} color={p.ok} />
          </View>
        )}
        <Text style={{ color: p.text, fontSize: 13, fontWeight: '600' }}>{live ? '작업 중' : '작업 과정'}</Text>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: p.muted, fontSize: 13, fontVariant: ['tabular-nums'] }}>
          {summary}
        </Text>
        <Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={12} color={p.muted} />
      </Pressable>
      {live ? <ProgressLine /> : null}
      {expanded ? (
        <View style={{ marginTop: 12 }}>
          {rendered}
          {idle ? (
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginTop: rendered.some(Boolean) ? 14 : 0 }}>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 1.5,
                  borderStyle: 'dashed',
                  borderColor: alpha(p.primary, 45),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ActivityIndicator size="small" color={p.primary} style={{ transform: [{ scale: 0.55 }] }} />
              </View>
              <Text style={{ color: p.muted, fontSize: 14 }}>다음 단계를 준비하고 있어요</Text>
              <Text style={{ color: p.muted, fontSize: 12, fontVariant: ['tabular-nums'] }}>{fmtSec(now - lastAt)}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {answer ? (
        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: p.border }}>
          <AssistantMarkdown text={answer} />
          {live ? caret : null}
        </View>
      ) : null}
    </View>
  );
};
