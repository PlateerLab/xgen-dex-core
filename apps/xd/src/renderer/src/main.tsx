import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Dex 와 같은 화면 — 스타일도 같은 파일이다(IDE 스타일을 먼저 실어 앱 스타일이 그 색 변수를 덮게).
import '@dex/ide/ide.css';
import '../../../../desktop/src/renderer/src/styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
