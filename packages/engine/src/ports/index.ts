/**
 * 호스트마다 다른 것 — 저장 둘, 상호작용 하나.
 *
 * 엔진 전체를 뒤져 실제로 갈라지는 지점을 셌다. 처음엔 둘이라고 봤는데(설정·비밀),
 * 정적 import 만 세었던 탓이었다. `await import('electron')` 로 숨어 있던 것이
 * 다섯 군데 더 있었고 전부 **사용자와 직접 주고받는 일**이었다 — 위험한 명령
 * 확인, 클립보드, 알림, 링크/파일 열기. 그래서 셋이다.
 *
 * 넷째를 늘리지 않는다. "호스트가 다르니까"는 아무 코드나 앱으로 밀어내는 좋은
 * 핑계이고, 그렇게 밀려난 코드가 앱마다 갈라지는 것이 이 저장소가 없애려는 바로
 * 그 병이다. 포트를 늘리는 것은 설계 결정이지 편의가 아니다.
 */

/**
 * 비밀 저장소 — 문자열 하나를 이름에 붙여 두고 꺼내는 것.
 *
 * 이 좁은 계약 위에 MCP 서버 시크릿, OAuth 상태, 로그인 토큰이 전부 얹힌다.
 * 데스크톱은 OS 키체인(실패하면 암호화 파일 → 메모리 순으로 내려간다), CLI 는
 * keytar, 테스트는 메모리 Map 을 준다.
 *
 * `set(name, null)` 은 삭제다. 지우기를 별도 메서드로 두지 않는 이유: 호스트마다
 * "빈 문자열 저장"과 "삭제"를 다르게 처리하다 한쪽만 지워지는 상태가 실제로 났다.
 */
export interface SecretPort {
  get(name: string): Promise<string | null>;
  /** `null` 이면 삭제. 저장에 성공했으면 true. */
  set(name: string, value: string | null): Promise<boolean>;
}

/**
 * 설정 저장소 — 앱이 재시작을 넘겨 기억하는 것.
 *
 * 엔진은 자기가 쓰는 조각만 읽고 쓴다. 전체 설정 객체의 형태는 앱이 정한다 —
 * 데스크톱 설정에는 오버레이 위치와 단축키가 있고 CLI 에는 없는데, 엔진이 그걸
 * 알아야 할 이유가 없다.
 */
export interface ConfigPort<T = unknown> {
  load(): T;
  /** 얕은 병합. 반환은 병합된 전체. */
  save(patch: Partial<T>): T;
}

/**
 * 사용자와 직접 주고받는 일.
 *
 * 전부 선택 사항이다 — 터미널에는 알림 센터가 없고, 헤드리스 실행에는 클립보드가
 * 없다. 구현이 없으면 그 도구는 "이 호스트에서는 지원하지 않습니다" 라고 **말한다**.
 * 조용히 성공한 척하지 않는다: 에이전트가 클립보드에 복사했다고 믿고 다음 단계를
 * 진행하는 것이 아무것도 안 한 것보다 나쁘다.
 *
 * `confirmDangerous` 만은 예외적으로 다르게 다룬다 — 아래 참조.
 */
export interface InteractionPort {
  /**
   * 위험한 셸 명령을 실행하기 전에 사용자에게 묻는다.
   *
   * **구현이 없으면 거부한다.** 다른 능력들과 반대다. 물을 방법이 없다는 것은
   * "물을 필요가 없다"가 아니라 "동의를 받을 수 없다"이고, 그때 실행하면 사용자가
   * 모르는 사이에 파괴적인 명령이 돈다.
   *
   * `'session'` 은 이번 세션 동안 다시 묻지 않는다는 뜻이다.
   */
  confirmDangerous?(command: string): Promise<'once' | 'session' | 'deny'>;

  /** 없으면 클립보드 도구가 미지원을 알린다. */
  clipboard?: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };

  /** 표시했으면 true. 사용자 설정으로 억제했으면 false — 오류가 아니다. */
  notify?(title: string, body: string): Promise<boolean>;

  /** 기본 브라우저로 URL 을 연다. MCP OAuth 인증도 이 길을 쓴다. */
  openExternal?(url: string): Promise<void>;

  /** OS 기본 앱으로 파일/폴더를 연다. 성공이면 빈 문자열, 실패면 사유. */
  openPath?(absolutePath: string): Promise<string>;
}

/** 어디에 무엇을 쓰는지 — 엔진이 파일을 두는 뿌리. */
export interface PathsPort {
  /** 사용자 데이터 루트 (workspace 레플리카·로그·캐시가 이 아래로). */
  dataRoot(): string;
}

/** 엔진이 호스트에게 받는 전부. */
export interface HostPorts<T = unknown> {
  secrets: SecretPort;
  config: ConfigPort<T>;
  paths: PathsPort;
  /** 없으면 사용자와 주고받는 도구들이 전부 미지원으로 응답하고, 위험한 셸
   *  명령은 거부된다 — 그게 안전한 기본값이다. */
  interaction?: InteractionPort;
}

/**
 * 테스트·헤드리스 실행용 메모리 구현.
 *
 * 프로덕션 경로에 섞이지 않도록 여기 함께 둔다 — 각 앱이 자기 테스트용 스텁을
 * 따로 쓰면 그 스텁들이 또 갈라진다.
 */
export function memoryPorts<T extends object = Record<string, unknown>>(
  initial: Partial<T> = {},
  root = '/tmp/dex-memory',
): HostPorts<T> {
  const secrets = new Map<string, string>();
  let config = { ...initial } as T;
  return {
    secrets: {
      async get(name) {
        return secrets.get(name) ?? null;
      },
      async set(name, value) {
        if (value === null) secrets.delete(name);
        else secrets.set(name, value);
        return true;
      },
    },
    config: {
      load: () => config,
      save: (patch) => {
        config = { ...config, ...patch };
        return config;
      },
    },
    paths: { dataRoot: () => root },
    // interaction 은 일부러 비운다 — 테스트에서 위험한 명령이 통과하면
    // 프로덕션의 안전장치가 실제로 도는지 알 수 없다.
  };
}
