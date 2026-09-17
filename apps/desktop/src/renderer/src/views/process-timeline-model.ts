/**
 * 작업 과정 타임라인의 규칙 — **정본은 @dex/protocol 의 process-timeline 이다.**
 *
 * 웹 채팅(xgen-frontend)이 같은 타임라인을 그리므로 규칙을 패키지로 올렸다. 이 파일은 그 자리를
 * 가리키는 이름표만 남긴다: 화면 코드가 상대 경로로 부르던 것을 한 번에 바꾸지 않아도 되고,
 * 무엇이 정본인지는 여기 한 줄로 드러난다.
 */
export type {
  ResultView,
  TimelineFlowItem,
  TimelineRow,
  TimelineStep,
  ToolIcon,
} from '@dex/protocol/process-timeline';
export {
  buildSteps,
  describeTool,
  descriptionHeadline,
  parseToolInput,
  resultView,
  splitFirstParagraph,
  summarizeArgs,
  summarizeCommand,
  trimAnswer,
} from '@dex/protocol/process-timeline';
