import React from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayApp } from './overlay/OverlayApp';
import { setAvatarRenderer } from './avatar/AvatarSlot';
import { Live2DCanvas } from './avatar/Live2DCanvas';
import './styles.css';

// Register the real avatar renderer BEFORE first render — hasAvatarRenderer() is
// read non-reactively in OverlayApp, so this must run before createRoot. The
// renderer resolves the user's global default avatar itself (and falls back to
// the branded placeholder when none is set), so the empty state is preserved.
setAvatarRenderer(Live2DCanvas);

// The overlay window must be transparent so the avatar composites onto the
// desktop — never let the shared body background paint here.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
