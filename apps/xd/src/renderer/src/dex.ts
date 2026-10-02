/**
 * Dex 와 같이 쓰는 화면 부품 — **이 파일 한 곳으로만** 들어온다(2026-10-02 결정: 기본 부품은 공유, 나머지는 XD 전용).
 *
 * Dex 코드는 고치지 않고 그대로 가져다 쓴다. 여기 있는 것은 `window.xgen` 에 기대지 않는 부품이다 — 마크다운의
 * [복사]만 `xgen.clipboard` 를 찾는데, XD preload 가 그 한 칸만 같은 모양으로 연다(없어도 브라우저 클립보드로 간다).
 */
export type { ChatMsg, FlowItem } from '../../../../desktop/src/renderer/src/session-store';
export { Markdown } from '../../../../desktop/src/renderer/src/views/Markdown';
export { ProcessTimeline } from '../../../../desktop/src/renderer/src/views/ProcessTimeline';
export { Tooltip } from '../../../../desktop/src/renderer/src/views/Tooltip';
// 작업 공간 IDE(M5b) — 편집기(Monaco 와 그 worker 를 이 앱 번들로)·미리보기(그림·PDF·마크다운·표).
export { loadMonaco } from '../../../../desktop/src/renderer/src/ide/monaco';
export { FileViewerPane, type FileViewerSource } from '../../../../desktop/src/renderer/src/views/FileViewerPane';
// MCP 서버(M5c) — 표준 MCP 설정 JSON(Claude Desktop·Cursor·mcp.json) 붙여 넣기와 표시용 명령줄.
export { McpImportError, parseMcpConfig, toDisplayCommand } from '../../../../desktop/src/renderer/src/views/mcp-import';
export {
  BotIcon,
  ChatIcon,
  CheckIcon,
  CloseIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  FolderCodeIcon,
  FolderOpenIcon,
  HistoryIcon,
  InfoIcon,
  ModelIcon,
  PanelRightIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  ServerIcon,
  SettingsIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from '../../../../desktop/src/renderer/src/brand/icons';
