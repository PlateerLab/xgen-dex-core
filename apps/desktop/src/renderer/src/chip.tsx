import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChipApp } from './overlay/ChipApp';

// ⚠ styles.css 를 **싣지 않는다.** 거기 `body { background: var(--app-bg) }` 가
// 있고 라이트 테마에서 그 값이 #f7f8fa 다 — 창이 내용보다 크면 그 흰색이
// 알약처럼 보인다 (실제로 잠금 칩이 토글 스위치처럼 보였다). 이 창은 버튼
// 몇 개짜리이므로 스타일을 스스로 든다.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChipApp />
  </React.StrictMode>,
);
