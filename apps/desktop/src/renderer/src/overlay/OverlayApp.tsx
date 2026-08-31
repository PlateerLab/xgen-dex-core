/**
 * OverlayApp — the floating avatar space (Geny-style, faithful port of Geny's
 * /overlay page, WITHOUT TTS / STT / screen-capture).
 *
 * A transparent, frameless, always-on-top window that floats an AVATAR (an
 * extension point via AvatarSlot; a branded placeholder until one is registered)
 * with a visual-novel SPEECH BUBBLE that types out what the agent is saying.
 *
 * 잠금 모델 (기본 잠김) — 상태는 **main 이 소유한다**:
 *   • 잠김   → 이 창은 입력을 통과시킨다. 아바타를 옮기거나 크기를 바꿀 수
 *     없고 클릭은 뒤의 데스크톱으로 간다. 컨트롤 버튼은 **별도 창**
 *     (chip.html)에 있어 언제나 눌린다 — 입력이 통과하는 창은 자기 잠금
 *     해제 버튼을 담을 수 없기 때문이다. 예전에는 여기서 hover 로 입력을
 *     되살렸는데, 리눅스에서는 이벤트가 아예 안 오고 darwin/win32 에서도
 *     클릭이 IPC 왕복 사이에 사라져 "버튼이 보이는데 눌리지 않는" 상태가
 *     됐다 (geny-connector 가 같은 버그를 별도 창으로 해결했다).
 *   • 풀림   → 이 창이 입력을 잡는다. 점선 리사이즈 프레임(8방향)이 나타나고
 *     바를 끌면 창이 움직인다. 컨트롤은 이 창 안의 상단 바로 돌아온다.
 *
 * Drag uses movementX/movementY → moveBy, and main uses setPosition (not
 * setBounds) so the window never grows on fractional-DPI displays (150% scaling).
 */
import React, { useEffect, useRef, useState } from 'react';
import { xgen } from '../bridge';
import type { OverlayState } from '../../../preload/index';
import { AvatarSlot, hasAvatarRenderer, type AvatarState } from '../avatar/AvatarSlot';
import { SubtitleMarkdown } from '../views/Markdown';
import { XgenMark } from '../brand/Logo';
import { EyeIcon, EyeOffIcon } from '../brand/icons';
// 컨트롤 버튼은 잠금 창(chip)과 **같은 컴포넌트**를 쓴다 — 두 곳이 갈리면
// "잠갔을 때만 없는 버튼" 이 생기고 사용자는 의도인지 버그인지 알 수 없다.
import { LockIcon, VoiceButtons, useVoiceControls } from './ActionBar';

const EMPTY: OverlayState = { workflowId: '', workflowName: '', streamingText: '', speaking: false };
const SUBTITLE_DISMISS_MS = 4000;

function GripIcon(): React.ReactElement {
  return (
    <svg width="13" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {[6, 12, 18].map((cy) => (
        <g key={cy}>
          <circle cx="9" cy={cy} r="1.7" />
          <circle cx="15" cy={cy} r="1.7" />
        </g>
      ))}
    </svg>
  );
}
function CloseIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function ChatBubbleIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-5.5a8.38 8.38 0 0 1-.9-4 8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 8.5 8.5z" />
    </svg>
  );
}
function GearIcon(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Speech bubble — types the streaming reply out at a FIXED, user-set pace
 * (charMs = ms/char), so even when the model emits many tokens at once the
 * bubble reveals them steadily and stays readable. A new turn (text that isn't a
 * prefix-extension of the previous) restarts the reveal from 0. Auto-hides ~4s
 * after it settles (typewriter caught up AND streaming stopped). Ported from
 * Geny's AvatarSubtitle.
 */
function Subtitle({
  text,
  speaking,
  charMs,
  size,
}: {
  text: string;
  speaking: boolean;
  charMs: number;
  size: 'sm' | 'md' | 'lg';
}): React.ReactElement | null {
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fullRef = useRef(text);
  fullRef.current = text;
  const charMsRef = useRef(charMs);
  charMsRef.current = charMs;
  const shownRef = useRef(0);
  const prevRef = useRef('');

  // Restart the reveal only when NEW content arrives (not a live prefix-grow).
  useEffect(() => {
    if (!text.startsWith(prevRef.current)) {
      shownRef.current = 0;
      setShown(0);
    }
    prevRef.current = text;
  }, [text]);

  // Typewriter loop — advances `shown` toward the full length at a fixed pace,
  // then idles (stops scheduling frames) until `text` changes.
  useEffect(() => {
    if (!text) return;
    let raf = 0;
    let last = 0;
    const tick = (ts: number) => {
      if (!last) last = ts;
      const dt = Math.min(0.1, (ts - last) / 1000);
      last = ts;
      const target = fullRef.current;
      let s = shownRef.current;
      if (s > target.length) s = 0;
      if (s < target.length) {
        const cps = 1000 / Math.max(20, charMsRef.current); // chars per second
        s = Math.min(target.length, s + cps * dt);
        if (Math.floor(s) !== Math.floor(shownRef.current)) setShown(Math.floor(s));
        shownRef.current = s;
        raf = requestAnimationFrame(tick);
      } else {
        shownRef.current = s;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  const revealed = text.slice(0, shown);
  const revealDone = shown >= text.length;
  const full = text.trim();

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [revealed]);

  useEffect(() => {
    if (!full) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (timer.current) clearTimeout(timer.current);
    // Settled = the reveal caught up AND streaming finished.
    if (revealDone && !speaking) timer.current = setTimeout(() => setVisible(false), SUBTITLE_DISMISS_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [full, revealDone, speaking]);

  if (!full) return null;
  const showCursor = speaking || !revealDone;
  return (
    <div className="ov-subtitle-wrap">
      <div className={`ov-subtitle sz-${size} ${visible ? 'show' : ''}`} ref={bodyRef}>
        {/* 타자기 reveal 된 프리픽스를 인라인 마크다운으로 — 말풍선에 표/코드
            블록은 어울리지 않으니 인라인(볼드/코드) + 블록마커 정리만 한다. */}
        <SubtitleMarkdown text={revealed} />
        {showCursor && <span className="cursor" />}
      </div>
    </div>
  );
}

const RESIZE_HANDLES: { edge: string; className: string }[] = [
  { edge: 'n', className: 'ov-rh n' },
  { edge: 's', className: 'ov-rh s' },
  { edge: 'w', className: 'ov-rh w' },
  { edge: 'e', className: 'ov-rh e' },
  { edge: 'nw', className: 'ov-rh nw' },
  { edge: 'ne', className: 'ov-rh ne' },
  { edge: 'sw', className: 'ov-rh sw' },
  { edge: 'se', className: 'ov-rh se' },
];

function ResizeFrame(): React.ReactElement {
  const start = (edge: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* optional */
    }
    const onMove = (ev: PointerEvent) => xgen.overlay.resizeBy(edge, ev.movementX, ev.movementY);
    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      xgen.overlay.commitBounds(); // gesture end → persist size/pos immediately
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div className="ov-resize-frame">
      <div className="ov-resize-label">크기 조절</div>
      {RESIZE_HANDLES.map((h) => (
        <div key={h.edge} className={h.className} onPointerDown={start(h.edge)} />
      ))}
    </div>
  );
}

export function OverlayApp(): React.ReactElement {
  const [state, setState] = useState<OverlayState>(EMPTY);
  // 잠금은 **main 이 소유한다** — 아바타 창과 컨트롤 창이 서로 다르게 알고
  // 있으면 "잠겼다는데 잠기지 않은" 상태가 보인다.
  const [locked, setLockedLocal] = useState(true);
  //: 컨트롤 창이 이 창의 바닥을 덮는 높이. 자막을 그만큼 들어 올린다 —
  //: 별도 창이라 페이지는 그 존재를 알 수 없고, 그대로 두면 마지막 대사 위에
  //: 버튼이 겹쳐 그려진다.
  const [chipInset, setChipInset] = useState(0);
  const [subtitles, setSubtitles] = useState(true);
  const [charMs, setCharMs] = useState(50);
  const [subtitleSize, setSubtitleSize] = useState<'sm' | 'md' | 'lg'>('sm');
  const [avatarHidden, setAvatarHidden] = useState(false);
  // 핸즈프리 음성 대화 (Geny 방식): 로컬 토글 + 서버 STT 게이트
  const voice = useVoiceControls();
  const dragging = useRef(false);
  const hasAvatar = hasAvatarRenderer();

  useEffect(() => xgen.overlay.onState((s) => setState(s)), []);

  useEffect(() => {
    const apply = (c: {
      subtitles?: boolean;
      subtitleCharMs?: number;
      subtitleSize?: 'sm' | 'md' | 'lg';
      avatarHidden?: boolean;
    }) => {
      setSubtitles(c.subtitles !== false);
      setCharMs(typeof c.subtitleCharMs === 'number' ? c.subtitleCharMs : 50);
      setSubtitleSize(c.subtitleSize ?? 'sm');
      setAvatarHidden(!!c.avatarHidden);
    };
    xgen.config.get().then(apply);
    return xgen.config.onChange(apply);
  }, []);

  // 잠금은 main 이 정한다 — 이 창은 따라갈 뿐이다. 여기서 직접
  // setClickThrough 를 부르면 두 창의 상태가 어긋난다.
  useEffect(() => {
    void xgen.overlay.getLocked().then(setLockedLocal);
    return xgen.overlay.onLocked(setLockedLocal);
  }, []);

  useEffect(() => xgen.overlay.onChipInset(setChipInset), []);

  const setLocked = (next: boolean): void => xgen.overlay.setLocked(next);
  const onDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    // Stop the browser from starting a text selection / native drag on the
    // press — that gesture would otherwise capture the pointer and block the
    // window move.
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => xgen.overlay.moveBy(ev.movementX, ev.movementY);
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      xgen.overlay.commitBounds(); // drag end → persist position immediately
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const avatarState: AvatarState = {
    workflowId: state.workflowId,
    workflowName: state.workflowName,
    streamingText: state.streamingText,
    speaking: state.speaking,
  };
  const name = state.workflowName || 'XGEN';

  const toggleAvatarHidden = () => void xgen.config.set({ avatarHidden: !avatarHidden });

  return (
    <div className={`ov-root ${avatarHidden ? 'avatar-hidden' : ''}`}>
      {/* 컨트롤 창이 바닥을 덮는 만큼 무대를 들어 올린다. 별도 창이라
          페이지는 그 존재를 알 수 없고, 0 이면(잠금 해제) 레이아웃은 그대로다. */}
      <div className="ov-stage" style={chipInset ? { paddingBottom: chipInset } : undefined}>
        {!avatarHidden &&
          (hasAvatar ? (
            <AvatarSlot state={avatarState} />
          ) : (
            <div className={`ov-placeholder ${state.speaking ? 'speaking' : ''}`}>
              <div className="ov-orb">
                <XgenMark height={44} variant="color" />
              </div>
              <div className="ov-name">{name}</div>
            </div>
          ))}
        {subtitles && (
          <Subtitle text={state.streamingText} speaking={state.speaking} charMs={charMs} size={subtitleSize} />
        )}
      </div>

      {!locked && <ResizeFrame />}

      {/* 잠김: 이 창에는 아무 컨트롤도 두지 않는다. 입력이 통과하므로 어차피
          누를 수 없고, 눌리는 척하는 UI 는 사용자를 헤매게 만든다. 컨트롤은
          chip.html 창이 담당한다 (main 이 위치·가시성을 관리). */}
      {locked ? null : (
        <div className="ov-bar" onMouseDown={onDrag}>
          <span className="ov-grip" title="드래그하여 이동">
            <GripIcon />
          </span>
          <button className="ov-icon-btn" onClick={() => xgen.overlay.focusMain()} title="채팅 창 열기">
            <ChatBubbleIcon />
          </button>
          <VoiceButtons voice={voice} />
          <button className="ov-icon-btn" onClick={() => xgen.overlay.openSettings()} title="설정 열기">
            <GearIcon />
          </button>
          <span className="ov-divider" />
          <button
            className="ov-icon-btn"
            onClick={toggleAvatarHidden}
            title={avatarHidden ? '아바타 표시' : '아바타 숨기기'}
          >
            {avatarHidden ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
          </button>
          <button className="ov-icon-btn" onClick={() => setLocked(true)} title="잠금">
            <LockIcon open />
          </button>
          <button className="ov-icon-btn ov-danger" onClick={() => xgen.overlay.hide()} title="미니 채팅 숨기기">
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
