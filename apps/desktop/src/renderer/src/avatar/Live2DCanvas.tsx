/**
 * Live2DCanvas — the connector overlay's avatar renderer (registered into the
 * AvatarSlot seam). Ported from Geny (pixi v7 + pixi-live2d-display/cubism4 +
 * spine-pixi-v7), idle-only.
 *
 * XGEN model: the avatar is the user's GLOBAL default from 개인 설정
 * (preferences.avatar.defaultAvatarId). This fetches it, renders it, and — like
 * Geny's connector — lets you **wheel-zoom + left-drag-pan the avatar** when the
 * overlay is unlocked; the adjusted scale/position are persisted back to
 * preferences.avatar (so they stick and sync to the 개인 설정 preview).
 *
 * Assets load through the main-process `xgenavatar://` proxy (no CORS/CSP), and
 * pixi is patched with @pixi/unsafe-eval for the overlay's strict CSP.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import { XgenMark } from '../brand/Logo';
import type { AvatarState } from './AvatarSlot';
import type { AvatarConfig, AvatarDescriptor } from '../../../core/preferences';

const CUBISM_CORE_SRC = './live2dcubismcore.min.js';
let _spineAliasSeq = 0;
let _unsafeEvalInstalled = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function installUnsafeEval(PIXI: any): Promise<void> {
  if (_unsafeEvalInstalled) return;
  const { install } = await import('@pixi/unsafe-eval');
  install(PIXI);
  _unsafeEvalInstalled = true;
}

function ensureCubismCore(): Promise<void> {
  const win = window as unknown as { Live2DCubismCore?: unknown };
  if (win.Live2DCubismCore) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector('script[src*="live2dcubismcore"]');
    if (existing) {
      const poll = () => (win.Live2DCubismCore ? resolve() : setTimeout(poll, 50));
      poll();
      return;
    }
    const s = document.createElement('script');
    s.src = CUBISM_CORE_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Live2D Cubism Core'));
    document.head.appendChild(s);
  });
}

export interface AvatarTransform {
  scale: number;
  position: { x: number; y: number };
}

/** The pixi renderer for one avatar. Interactive: wheel zoom + left-drag pan,
 *  reporting the adjusted transform via onTransform. `interactive: false` 는
 *  정적 미리보기(설정 뷰의 스토어 카드/이름 모달)용 — 입력 리스너를 달지
 *  않아 스크롤/휠을 방해하지 않는다. Exported for the AvatarSettings view. */
export const AvatarModel: React.FC<{
  avatar: AvatarDescriptor;
  serverUrl: string;
  onTransform?: (t: AvatarTransform) => void;
  interactive?: boolean;
}> = ({ avatar, serverUrl, onTransform, interactive = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const genRef = useRef(0);
  const onTransformRef = useRef(onTransform);
  onTransformRef.current = onTransform;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const gen = ++genRef.current;
    const isStale = () => gen !== genRef.current;
    setPhase('loading');
    setErr('');

    // Route assets through the main-process proxy (no CORS/CSP); relative
    // moc3/textures/atlas siblings resolve against the same scheme.
    const url = (u: string) => {
      if (/^xgenavatar:/.test(u)) return u;
      let path = u;
      if (/^https?:\/\//.test(u)) {
        const p = new URL(u);
        path = p.pathname + p.search;
      }
      if (!path.startsWith('/')) path = `/${path}`;
      return `xgenavatar://a${path}`;
    };

    // interaction state, seeded from the saved descriptor
    let scaleMul = avatar.scale || (avatar.runtime === 'spine' ? 0.7 : 0.85);
    const pos = { x: avatar.position?.x || 0, y: avatar.position?.y || 0 };
    let naturalW = 600;
    let naturalH = 600;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let app: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let display: any = null;
    let ro: ResizeObserver | null = null;
    let emitTimer: ReturnType<typeof setTimeout> | null = null;

    const applyTransform = () => {
      if (!app || !display) return;
      const b = Math.min(app.screen.width / naturalW, app.screen.height / naturalH);
      display.scale.set(b * scaleMul);
      display.x = app.screen.width / 2 + pos.x;
      display.y = app.screen.height / 2 + pos.y;
    };
    const scheduleEmit = () => {
      if (emitTimer) clearTimeout(emitTimer);
      emitTimer = setTimeout(() => onTransformRef.current?.({ scale: scaleMul, position: { x: pos.x, y: pos.y } }), 500);
    };

    // wheel zoom + left-drag pan (only fires when the overlay is unlocked → not
    // click-through; when locked the OS window swallows these events).
    const onWheel = (e: WheelEvent) => {
      if (!display) return;
      e.preventDefault();
      scaleMul = Math.min(5, Math.max(0.05, scaleMul * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      applyTransform();
      scheduleEmit();
    };
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !display) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      container.setPointerCapture?.(e.pointerId);
      container.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || !display) return;
      pos.x += e.clientX - lastX;
      pos.y += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      applyTransform();
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      container.releasePointerCapture?.(e.pointerId);
      container.style.cursor = 'grab';
      scheduleEmit();
    };

    const init = async () => {
      const PIXI = await import('pixi.js');
      if (isStale()) return;
      await installUnsafeEval(PIXI);
      if (isStale()) return;
      app = new PIXI.Application({
        width: container.clientWidth || 300,
        height: container.clientHeight || 400,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
      });
      app.ticker.maxFPS = 30;
      const canvas = app.view as HTMLCanvasElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      container.appendChild(canvas);

      if (avatar.runtime === 'image') {
        // Static photo avatar — a plain sprite, same fit + zoom/pan.
        const tex = await PIXI.Assets.load(url(avatar.modelUrl));
        if (isStale()) return;
        const sprite = new PIXI.Sprite(tex);
        display = sprite;
        sprite.anchor.set(0.5, 0.5);
        naturalW = tex.width || 600;
        naturalH = tex.height || 600;
        applyTransform();
        app.stage.addChild(sprite);
      } else if (avatar.runtime === 'spine') {
        const { Spine } = await import('@esotericsoftware/spine-pixi-v7');
        if (isStale()) return;
        const seq = ++_spineAliasSeq;
        const skel = `xgen-avatar:${seq}:skel`;
        const atlas = `xgen-avatar:${seq}:atlas`;
        PIXI.Assets.add({ alias: skel, src: url(avatar.modelUrl) });
        PIXI.Assets.add({ alias: atlas, src: url(avatar.atlasUrl || '') });
        await PIXI.Assets.load([skel, atlas]);
        if (isStale()) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const spine: any = (Spine as any).from({ skeleton: skel, atlas });
        display = spine;
        naturalW = spine.skeleton?.data?.width || 600;
        naturalH = spine.skeleton?.data?.height || 800;
        applyTransform();
        app.stage.addChild(spine);
        const anims: Array<{ name: string }> = spine.skeleton?.data?.animations || [];
        const pick =
          anims.find((a) => a.name === avatar.idleMotionGroupName) ||
          anims.find((a) => /idle/i.test(a.name)) ||
          anims[0];
        if (pick) spine.state.setAnimation(0, pick.name, true);
      } else {
        await ensureCubismCore();
        if (isStale()) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const l2d: any = await import('pixi-live2d-display/cubism4');
        if (isStale()) return;
        l2d.Live2DModel.registerTicker(PIXI.Ticker);
        const idle = avatar.idleMotionGroupName || 'Idle';
        const model = await l2d.Live2DModel.from(url(avatar.modelUrl), {
          autoHitTest: false,
          autoFocus: false,
          idleMotionGroup: idle,
        });
        if (isStale()) {
          model.destroy?.();
          return;
        }
        display = model;
        model.anchor.set(0.5, 0.5);
        naturalW = model.width || 600; // read at scale 1, before applyTransform
        naturalH = model.height || 600;
        applyTransform();
        app.stage.addChild(model);
        try {
          await model.motion(idle, undefined, l2d.MotionPriority?.IDLE ?? 1);
        } catch {
          /* idle optional */
        }
      }

      ro = new ResizeObserver(() => {
        if (isStale() || !app || !display) return;
        app.renderer.resize(container.clientWidth || 300, container.clientHeight || 400);
        applyTransform(); // uses stored natural size — never the scaled display size
      });
      ro.observe(container);

      if (interactive) {
        container.style.cursor = 'grab';
        container.addEventListener('wheel', onWheel, { passive: false });
        container.addEventListener('pointerdown', onDown);
        container.addEventListener('pointermove', onMove);
        container.addEventListener('pointerup', onUp);
        container.addEventListener('pointercancel', onUp);
      }

      if (!isStale()) setPhase('ready');
    };

    init().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[Live2DCanvas] init error:', e);
      if (!isStale()) {
        setPhase('error');
        setErr(msg);
      }
    });

    return () => {
      genRef.current++;
      if (emitTimer) clearTimeout(emitTimer);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
      try {
        ro?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        if (display && app) app.stage?.removeChild(display);
        display?.destroy?.({ children: true });
      } catch {
        /* ignore */
      }
      try {
        app?.destroy(true, { children: true });
      } catch {
        /* ignore */
      }
      if (container) container.innerHTML = '';
    };
    // Re-init only on avatar IDENTITY / server change — NOT on scale/position
    // (those are driven live by interaction + persisted; re-seeding would reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar.id, avatar.modelUrl, avatar.atlasUrl, avatar.runtime, avatar.idleMotionGroupName, serverUrl]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {phase !== 'ready' && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 8,
            textAlign: 'center',
            fontSize: 10,
            color: phase === 'error' ? '#fecaca' : 'rgba(255,255,255,0.75)',
            background: 'rgba(0,0,0,0.55)',
            padding: '3px 6px',
            borderRadius: 6,
            margin: '0 8px',
            wordBreak: 'break-all',
          }}
        >
          {phase === 'error' ? `모델 로드 실패: ${err}` : '아바타 로딩 중…'}
        </div>
      )}
    </div>
  );
};

function selectedFrom(cfg: AvatarConfig | null): AvatarDescriptor | null {
  if (!cfg || !cfg.enabled) return null;
  return cfg.avatars.find((a) => a.id === cfg.defaultAvatarId) ?? cfg.avatars[0] ?? null;
}

/** The registered AvatarRenderer: resolves the global default avatar, renders +
 *  lets you adjust it (persisted), else the branded placeholder. */
export const Live2DCanvas: React.FC<{ state: AvatarState }> = ({ state }) => {
  const [selected, setSelected] = useState<AvatarDescriptor | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [diag, setDiag] = useState('init');
  const sigRef = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let loaded = false; // at least one successful (authed) fetch has landed

    // Self-rescheduling poll: retry FAST (2s) until the first success — the
    // overlay boots before the main window restores the session, so the initial
    // fetch usually 401s — then settle to a slow 15s steady poll. A transient
    // failure keeps the current avatar on screen (no flicker to placeholder).
    const tick = async () => {
      if (!alive) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      let nextMs = 15000;
      try {
        if (!xgen.user || typeof xgen.user.avatarConfig !== 'function') {
          setDiag('구버전 접속기 — 업데이트 필요');
        } else {
          const [cfg, conf] = await Promise.all([xgen.user.avatarConfig(), xgen.config.get()]);
          if (!alive) return;
          loaded = true;
          const su = conf.serverUrl || '';
          const a = selectedFrom(cfg);
          setDiag(`en=${cfg?.enabled} n=${cfg?.avatars?.length ?? 0} def=${cfg?.defaultAvatarId ? 'y' : 'n'} srv=${su ? 'y' : 'n'} → ${a ? 'avatar' : 'none'}`);
          // IDENTITY-only signature: a scale/position change (from here or the web)
          // must NOT reload the model — only a different avatar / server does.
          const sig = `${su}|${a ? `${a.id}|${a.modelUrl}|${a.atlasUrl ?? ''}|${a.runtime}` : 'none'}`;
          if (sig !== sigRef.current) {
            sigRef.current = sig;
            setServerUrl(su);
            setSelected(a);
          }
        }
      } catch (e) {
        if (!alive) return;
        // Startup auth race / network blip: keep any avatar we already have and
        // retry soon. Only surface a "connecting" note when nothing loaded yet.
        if (!loaded) setDiag('연결 중…');
        nextMs = 2000;
        console.debug('[Live2DCanvas] avatar config not ready, retrying:', e);
      }
      if (alive) timer = setTimeout(() => void tick(), nextMs);
    };

    void tick();
    const offCfg = xgen.config.onChange(() => void tick());
    // Main broadcasts this the moment the session is restored / login succeeds.
    const offAvatar = xgen.user?.onAvatarRefresh?.(() => void tick());
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offCfg?.();
      offAvatar?.();
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Persist an in-overlay adjustment onto the avatar BEING RENDERED (debounced).
  // Read-modify-write in main against the CURRENT server config, patching only
  // this avatar's scale/position — a cached whole-config save here used to
  // revert a selection changed on the web in between (아바타 변경이 커넥터에
  // 적용되지 않던 원인 계열).
  const selectedRef = useRef<AvatarDescriptor | null>(null);
  selectedRef.current = selected;
  const onTransform = useCallback((tf: AvatarTransform) => {
    const id = selectedRef.current?.id;
    if (!id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      xgen.user.saveAvatarTransform?.(id, tf).catch(() => undefined);
    }, 700);
  }, []);

  if (selected && serverUrl) {
    return <AvatarModel avatar={selected} serverUrl={serverUrl} onTransform={onTransform} />;
  }
  return (
    <div className={`ov-placeholder ${state.speaking ? 'speaking' : ''}`}>
      <div className="ov-orb">
        <XgenMark height={44} variant="color" />
      </div>
      <div className="ov-name">{state.workflowName || 'XGEN'}</div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.75)', background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 6, maxWidth: 260, textAlign: 'center', wordBreak: 'break-all' }}>
        avatar: {diag}
      </div>
    </div>
  );
};
