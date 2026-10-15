import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Dex 와 같은 스타일(색 변수·부품 클래스)을 그대로 싣고, 그 위에 XD 화면만 더한다(xd.css).
import '@dex/ide/ide.css';
import '../../../../desktop/src/renderer/src/styles.css';
// 작업 과정 타임라인·채팅 머리 단추 — Dex 도 따로 싣는 파일이다.
import '../../../../desktop/src/renderer/src/views/process-timeline.css';
import './xd.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
