/**
 * AvatarCropModal — dependency-free crop editor for photo avatars.
 * Web(마이페이지)과 동일 로직: 미리보기 캔버스가 곧 내보내기 캔버스라
 * "보이는 그대로" 잘린다. 휠 확대/축소 + 드래그 이동, 균일 스케일만 사용.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useModalDismiss } from './use-modal-dismiss';

const FRAME_W = 300; // CSS px
const FRAME_H = 380; // portrait — avatars read best tall
const RES = 2; // export resolution = 600×760

export const AvatarCropModal: React.FC<{
  file: File;
  onCrop: (cropped: File) => void;
  onClose: () => void;
}> = ({ file, onCrop, onClose }) => {
  // Esc 로도 닫힌다 (바깥 클릭은 backdrop 이 처리).
  useModalDismiss(onClose);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const drag = useRef<{ on: boolean; x: number; y: number }>({ on: false, x: 0, y: 0 });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const im = imgRef.current;
    if (!canvas || !im) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { scale, x, y } = view.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2 + x * RES, canvas.height / 2 + y * RES);
    ctx.scale(scale * RES, scale * RES);
    ctx.drawImage(im, -im.naturalWidth / 2, -im.naturalHeight / 2, im.naturalWidth, im.naturalHeight);
    ctx.restore();
  }, []);

  useEffect(() => {
    const objUrl = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      imgRef.current = im;
      view.current = { scale: Math.max(FRAME_W / im.naturalWidth, FRAME_H / im.naturalHeight), x: 0, y: 0 };
      setReady(true);
      draw();
    };
    im.src = objUrl;
    return () => URL.revokeObjectURL(objUrl);
  }, [file, draw]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      view.current.scale = Math.min(8, Math.max(0.02, view.current.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
      draw();
    },
    [draw],
  );
  const onDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { on: true, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);
  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current.on) return;
      view.current.x += e.clientX - drag.current.x;
      view.current.y += e.clientY - drag.current.y;
      drag.current.x = e.clientX;
      drag.current.y = e.clientY;
      draw();
    },
    [draw],
  );
  const onUp = useCallback(() => {
    drag.current.on = false;
  }, []);

  const confirm = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 원본 base 이름 보존 — 고정 이름('avatar.png')은 전부 같은 이름의
    // 아바타를 만들어 구분 불가 (기본 이름은 파일명에서 온다).
    const base = (file.name.replace(/\.[^.]+$/, '') || 'avatar').trim();
    canvas.toBlob((blob) => {
      if (blob) onCrop(new File([blob], `${base}.png`, { type: 'image/png' }));
    }, 'image/png');
  }, [onCrop, file.name]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>사진 편집</h2>
          <button className="link" onClick={onClose}>
            닫기
          </button>
        </div>
        <p className="small muted" style={{ margin: '0 0 12px' }}>
          휠로 확대/축소, 드래그로 위치를 맞춘 뒤 프레임 안 영역이 아바타가 됩니다.
        </p>
        <div className="avset-crop-frame" style={{ width: FRAME_W, height: FRAME_H }}>
          <canvas
            ref={canvasRef}
            width={FRAME_W * RES}
            height={FRAME_H * RES}
            onWheel={onWheel}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{ width: FRAME_W, height: FRAME_H, display: 'block', cursor: 'grab', userSelect: 'none' }}
          />
        </div>
        <div className="avset-modal-actions">
          <button className="secondary" onClick={onClose}>
            취소
          </button>
          <button className="primary" onClick={confirm} disabled={!ready}>
            이 영역으로 사용
          </button>
        </div>
      </div>
    </div>
  );
};
