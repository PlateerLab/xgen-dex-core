/**
 * 앱 카드의 미리보기 그림 — 받고(그림 → data URL), 찍어 올린다(앱을 띄워 한 장).
 *
 * 왜 데스크톱이 찍는가: 서버는 앱을 그리지 못한다(앱이 도는 샌드박스에 브라우저가 없다). 앱을 그릴 줄
 * 아는 곳은 브라우저를 가진 클라이언트이고, 사람 손 없이 화면 한 장을 확실히 얻을 수 있는 것은 Electron
 * 이다(웹은 다른 문서의 화면을 찍을 수 없다). 그래서 데스크톱이 찍어 서버에 올리고, 웹·데스크톱·모바일의
 * 카드가 모두 그 한 장을 본다.
 *
 * 언제 찍는가 — 웹의 살아 있는 미리보기와 같은 선:
 *   사이트(project)   열리면(ready) 찍는다
 *   앱(service)       **지금 돌고 있을 때만** — 미리보기를 위해 멈춘 앱을 깨우지 않는다
 *   화면(component)   찍지 않는다(옛 모양, 격리 프레임 안에서만 돈다) — 기본 그림
 * 사람이 메뉴에서 [미리보기 다시 찍기]를 누르면 쉬는 시간 없이 바로 찍는다. 멈춘 앱은 그때도 찍지
 * 않는다 — 깨우는 동안의 "준비 중" 화면이 그 앱의 얼굴로 남는다.
 *
 * 한 번에 하나씩, 실패하면 한동안 다시 시도하지 않는다 — 열리지 않는 앱 때문에 목록을 열 때마다
 * 창을 띄우지 않게.
 *
 * Electron 을 모른다(찍는 함수 `shoot` 를 받는다) — 그래서 여기 판정은 단위 시험으로 지킨다.
 */
import type { XgenClient } from '@dex/protocol';
import { isAppPreviewPath, isAppSitePath } from '@dex/protocol/agent-data';
import { publicAppUrl } from './app-links';

export interface PreviewTarget {
  workflow_id: string;
  slug: string;
  kind: string;
  /** 서버가 준 여는 주소(서버 기준 경로). 사이트·앱에만 있다. */
  app_url?: string;
  /** 사람이 직접 눌렀다 — 쉬는 시간을 무시한다. */
  force?: boolean;
}

export type CaptureOutcome =
  | { ok: true; preview_url: string }
  | { ok: false; reason: 'kind' | 'url' | 'stopped' | 'cooldown' | 'empty' | 'error'; detail?: string };

export interface PreviewDeps {
  client: () => XgenClient;
  serverBase: () => string;
  /** 주소를 숨은 창에 띄워 JPEG 한 장을 돌려준다. 못 찍었으면 null. */
  shoot: (url: string) => Promise<Uint8Array | null>;
  now?: () => number;
}

/** 실패한 앱을 다시 찍기 전에 쉬는 시간. */
export const PREVIEW_RETRY_MS = 30 * 60_000;
/** 받은 그림을 기억하는 수(주소에 판이 실려 오므로 주소가 같으면 그림도 같다). */
const IMAGE_CACHE = 80;

export class AppPreviewService {
  private readonly images = new Map<string, string>();
  private readonly lastTry = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<CaptureOutcome>>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreviewDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 미리보기 그림 → data URL(렌더러의 CSP 는 서버 그림을 직접 받지 못한다). 없거나 실패면 빈 문자열. */
  async image(previewUrl: string): Promise<string> {
    if (!isAppPreviewPath(previewUrl)) return '';
    const hit = this.images.get(previewUrl);
    if (hit) return hit;
    try {
      const { bytes, contentType } = await this.deps.client().agentData.appPreviewImage(previewUrl);
      const type = /^image\/(jpeg|png|webp)\b/i.test(contentType) ? contentType.split(';')[0] : '';
      if (!type || bytes.byteLength === 0) return '';
      const url = `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.images.set(previewUrl, url);
      if (this.images.size > IMAGE_CACHE) this.images.delete(this.images.keys().next().value as string);
      return url;
    } catch {
      return '';
    }
  }

  /** 앱을 찍어 올린다. 같은 앱의 요청이 겹치면 하나로, 앱끼리는 차례로. */
  capture(target: PreviewTarget): Promise<CaptureOutcome> {
    const key = `${target.workflow_id}/${target.slug}`;
    const running = this.inflight.get(key);
    if (running) return running;
    if (!target.force) {
      const last = this.lastTry.get(key);
      if (last !== undefined && this.now() - last < PREVIEW_RETRY_MS) {
        return Promise.resolve({ ok: false, reason: 'cooldown' });
      }
    }
    const job = this.chain.then(() => this.run(key, target));
    this.chain = job.catch(() => undefined);
    this.inflight.set(key, job);
    void job.finally(() => this.inflight.delete(key));
    return job;
  }

  private async run(key: string, target: PreviewTarget): Promise<CaptureOutcome> {
    this.lastTry.set(key, this.now());
    if (target.kind !== 'project' && target.kind !== 'service') return { ok: false, reason: 'kind' };
    if (!isAppSitePath(target.app_url)) return { ok: false, reason: 'url' };
    const url = publicAppUrl(this.deps.serverBase(), target.app_url);
    if (!url) return { ok: false, reason: 'url' };
    const api = this.deps.client().agentData;
    try {
      if (target.kind === 'service') {
        const state = await api.appServiceState(target.workflow_id, target.slug).catch(() => null);
        if (!state?.running) return { ok: false, reason: 'stopped' };
      }
      const jpeg = await this.deps.shoot(url);
      if (!jpeg || jpeg.byteLength === 0) return { ok: false, reason: 'empty' };
      const res = await api.appPreviewUpload(target.workflow_id, target.slug, jpeg, 'image/jpeg');
      return { ok: true, preview_url: res.preview_url };
    } catch (e) {
      return { ok: false, reason: 'error', detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
