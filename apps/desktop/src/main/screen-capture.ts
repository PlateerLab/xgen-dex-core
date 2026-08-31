/**
 * 화면 캡처 — 채팅을 보낼 때 지금 화면을 함께 보낸다.
 *
 * 에이전트가 "지금 뭐가 보이나요" 를 되묻지 않고 답할 수 있게 하는 기능이다.
 * (geny-connector 의 화면 관찰과 같은 목적이고, 이쪽은 **보낼 때 한 장**이다 —
 * 주기적으로 올리지 않으므로 사용자가 언제 무엇이 갔는지 안다.)
 *
 * ## 왜 desktopCapturer 인가
 *
 * `getDisplayMedia` 를 쓰면 페이지에 미디어 스트림 권한 협상이 필요하고,
 * Electron 에서는 앱이 그 요청을 대신 만족시켜야 한다. 우리는 프레임 **한 장**만
 * 필요하므로 메인에서 `desktopCapturer.getSources` 로 직접 받는다 — 스트림도,
 * 페이지 권한도, 렌더러 코드도 필요 없다.
 *
 * ## 크기
 *
 * 원본 해상도를 그대로 보내면 4K 화면 한 장이 수 MB 다. 모델이 읽는 데
 * 필요한 것보다 훨씬 크고, 매 턴 그만큼 올리면 사용자의 회선과 토큰을 같이
 * 태운다. 긴 변 기준 1600px 로 줄인다 (geny 와 같은 기준).
 *
 * ## 실패
 *
 * **조용히 넘어가지 않는다.** macOS 는 화면 기록 권한이 없으면 검은 화면이나
 * 빈 목록을 준다. 그걸 "캡처했다" 로 처리하면 사용자는 에이전트가 화면을 보고
 * 있다고 믿은 채 엉뚱한 답을 받는다 — 이유를 돌려주고 호출자가 알리게 한다.
 */
import { desktopCapturer, screen, systemPreferences } from 'electron';

/** 긴 변 기준 상한. 4K 원본은 수 MB 이고 모델이 읽는 데 그만큼이 필요하지 않다. */
const MAX_EDGE = 1600;

/** JPEG 품질 (0~100). 화면은 텍스트가 많아 너무 낮추면 읽히지 않는다. */
const JPEG_QUALITY = 80;

export interface CaptureSource {
  id: string;
  name: string;
  /** 화면이면 디스플레이 id, 창이면 빈 문자열. */
  displayId: string;
  kind: 'screen' | 'window';
}

export interface CaptureResult {
  ok: boolean;
  /** `data:image/jpeg;base64,...` — 그대로 멀티모달 content 에 넣을 수 있다. */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** 무엇을 찍었는지 — 사용자가 "이게 왜 이 화면이지" 를 알 수 있게. */
  sourceName?: string;
  /** 실패 사유. 사용자에게 그대로 보여 줄 수 있는 문장. */
  error?: string;
}

/**
 * macOS 화면 기록 권한 상태.
 *
 * 다른 OS 에서는 항상 `granted` — 물어볼 것이 없다.
 */
export function screenAccessStatus(): 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

/** 고를 수 있는 화면/창 목록 (설정 화면용). */
export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    // 목록에는 미리보기가 필요 없다 — 1×1 로 받아 비용을 0 에 가깝게.
    thumbnailSize: { width: 1, height: 1 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    displayId: s.display_id || '',
    kind: s.id.startsWith('window:') ? 'window' : 'screen',
  }));
}

/** 긴 변이 {@link MAX_EDGE} 를 넘지 않도록 줄인 크기. */
function fit(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const k = MAX_EDGE / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/**
 * 화면 한 장을 찍는다.
 *
 * @param sourceId 비우면 주 디스플레이.
 */
export async function captureScreen(sourceId?: string): Promise<CaptureResult> {
  const access = screenAccessStatus();
  if (access === 'denied' || access === 'restricted') {
    return {
      ok: false,
      error:
        'macOS 화면 기록 권한이 없습니다. 시스템 설정 > 개인정보 보호 및 보안 > ' +
        '화면 기록 에서 XGen Dex 를 허용한 뒤 앱을 다시 시작하세요.',
    };
  }

  // 잡을 크기는 **대상 디스플레이 기준**으로 정한다. thumbnailSize 를 고정값으로
  // 주면 비율이 어긋나 찌그러진 그림이 나온다.
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;
  const full = {
    width: Math.round(primary.size.width * scale),
    height: Math.round(primary.size.height * scale),
  };
  const want = fit(full.width, full.height);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: want,
      fetchWindowIcons: false,
    });
  } catch (e) {
    return { ok: false, error: `화면을 캡처하지 못했습니다: ${(e as Error).message}` };
  }

  if (sources.length === 0) {
    return {
      ok: false,
      error:
        process.platform === 'darwin'
          ? '캡처할 화면을 찾지 못했습니다 — 화면 기록 권한을 확인하세요.'
          : '캡처할 화면을 찾지 못했습니다.',
    };
  }

  // 고른 것이 사라졌으면(창을 닫았다) 주 화면으로 떨어진다 — 조용히 실패하는
  // 것보다 무엇이든 보여 주는 편이 낫고, 무엇을 찍었는지는 함께 돌려준다.
  const wanted = sourceId ? sources.find((s) => s.id === sourceId) : undefined;
  const primaryId = String(primary.id);
  const chosen =
    wanted ??
    sources.find((s) => s.display_id === primaryId) ??
    sources.find((s) => s.id.startsWith('screen:')) ??
    sources[0];

  const img = chosen.thumbnail;
  if (!img || img.isEmpty()) {
    return {
      ok: false,
      error:
        process.platform === 'darwin'
          ? '빈 화면이 캡처되었습니다 — 화면 기록 권한을 확인하세요.'
          : '빈 화면이 캡처되었습니다.',
    };
  }

  const size = img.getSize();
  return {
    ok: true,
    // JPEG: 화면 한 장에 PNG 는 과하다 (무손실이 필요한 그림이 아니다).
    dataUrl: `data:image/jpeg;base64,${img.toJPEG(JPEG_QUALITY).toString('base64')}`,
    width: size.width,
    height: size.height,
    sourceName: chosen.name,
  };
}
