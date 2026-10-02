import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { CanonicalTuiController } from './canonical-controller';
import type { CanonicalTuiAccount } from './canonical-types';
import { canonicalTranscript, displayLine } from './canonical-display';
import { maximumScroll, viewportOf } from './transcript';
import { useTerminalSize } from './use-terminal-size';

export function CanonicalScreen({ account, controller, onExit }: {
  account: CanonicalTuiAccount;
  controller: CanonicalTuiController;
  onExit: () => void;
}) {
  const [view, setView] = useState(controller.state);
  const [scroll, setScroll] = useState({ id: null as string | null, up: 0 });
  const { columns, rows } = useTerminalSize();
  const width = Math.max(2, columns);
  const compact = rows < 12;
  const height = Math.max(0, rows - (compact ? 4 : 8));
  useEffect(() => controller.subscribe(setView), [controller]);
  const sessionId = view.conversation?.snapshot?.id ?? null;
  const lines = useMemo(() => canonicalTranscript(view, width), [view, width]);
  const page = viewportOf(lines, height, scroll.id === sessionId ? scroll.up : 0);
  const move = (calculate: (old: number) => number) => setScroll((old) => ({
    id: sessionId, up: calculate(old.id === sessionId ? old.up : 0),
  }));
  useInput((input, key) => {
    const value = input.toLowerCase();
    if (value === 'q' || (key.ctrl && value === 'c')) { onExit(); return; }
    if (key.ctrl || key.meta) return;
    if (value === 'r') void controller.read();
    else if (value === 'w') void controller.watch();
    else if (value === 's') void controller.stop();
    else if (key.pageUp || key.upArrow) move((old) => Math.min(maximumScroll(lines.length, height), old + (key.pageUp ? Math.max(1, height - 1) : 1)));
    else if (key.pageDown || key.downArrow) move((old) => Math.max(0, old - (key.pageDown ? Math.max(1, height - 1) : 1)));
    else if (key.home) move(() => maximumScroll(lines.length, height));
    else if (key.end) move(() => 0);
  });
  const snapshot = view.conversation?.snapshot;
  const partial = view.hasMore || !!view.conversation?.omittedMessages || snapshot?.message_history_complete === false;
  const row = (value: string, color?: string) => <Text wrap="truncate" color={color}>{displayLine(value, width)}</Text>;
  return <Box flexDirection="column" width={width} height={Math.max(1, rows)} overflow="hidden">
    {row(`Canonical 공유 대화 · ${view.status}${view.busy ? ' · 처리 중' : ''}`, 'cyan')}
    {!compact && row(`CLI · ${account.profile} · ${account.origin} · 계정 ${account.userId}`)}
    {!compact && row(snapshot ? `${snapshot.title} · ${snapshot.id}` : '현재 대화: 없음')}
    {!compact && row(snapshot ? `workflow ${snapshot.workflow_id} · 버전 ${snapshot.state_version} · 실행 ${snapshot.latest_turn?.status ?? '없음'}` : 'CLI Platform Session이 필요합니다. dex session login으로 로그인하세요.')}
    {row(view.error || view.notice, view.error ? 'red' : 'yellow')}
    <Box flexDirection="column" height={height} flexShrink={0} overflow="hidden">
      {page.lines.map((line) => <Text key={line.key} color={line.color} wrap="truncate">{line.text || ' '}</Text>)}
    </Box>
    {!compact && row(partial ? `일부 기록만 표시 · 생략 ${view.conversation?.omittedMessages ?? 0}개 · R로 재조회` : '완료된 검증 본문만 표시 · 실행 중 본문은 수신하지 않습니다.', partial ? 'yellow' : 'gray')}
    {!compact && row(`화면 위 ${page.above}줄 · 아래 ${page.below}줄 · ↑↓/PgUp/PgDn/Home/End 스크롤`, 'gray')}
    {row('조회 전용 · R 조회 · W 실시간 · S 연결 중단 · Q 종료', 'cyan')}
  </Box>;
}
