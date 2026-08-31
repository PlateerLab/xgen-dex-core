/**
 * 테스트용 호스트 바인딩.
 *
 * 엔진은 호스트가 안 붙으면 던진다 — 조용히 메모리로 폴백하면 프로덕션에서
 * 사용자의 MCP 인증이 매번 사라지는데 아무 오류도 안 보이기 때문이다. 그래서
 * 테스트는 **명시적으로** 붙인다.
 *
 * 각 테스트 파일이 자기 스텁을 따로 만들면 그 스텁들이 갈라진다 — 이 저장소가
 * 없애려는 바로 그 병이라 여기 한 곳에 둔다.
 */
import { bindHost, memoryPorts, type InteractionPort } from '../src/index';

export interface TestHostOptions {
  /** 기본은 거부 — 안전장치가 실제로 도는지 보려면 명시적으로 켜야 한다. */
  interaction?: InteractionPort;
}

export function bindTestHost(options: TestHostOptions = {}): void {
  const ports = memoryPorts();
  bindHost({ ...ports, interaction: options.interaction });
}

/** 사용자가 무엇을 승인했는지 기록하는 상호작용 스텁. */
export function recordingInteraction(answer: 'once' | 'session' | 'deny' = 'once') {
  const asked: string[] = [];
  const clipboard = { value: '' };
  const notified: Array<{ title: string; body: string }> = [];
  const opened: string[] = [];
  const port: InteractionPort = {
    async confirmDangerous(command) {
      asked.push(command);
      return answer;
    },
    clipboard: {
      async read() {
        return clipboard.value;
      },
      async write(text) {
        clipboard.value = text;
      },
    },
    async notify(title, body) {
      notified.push({ title, body });
      return true;
    },
    async openExternal(url) {
      opened.push(url);
    },
    async openPath(p) {
      opened.push(p);
      return '';
    },
  };
  return { port, asked, clipboard, notified, opened };
}
