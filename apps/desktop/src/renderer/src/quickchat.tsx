import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuickChatApp } from './overlay/QuickChatApp';
import './styles.css';

// Transparent window — never paint the shared body background.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QuickChatApp />
  </React.StrictMode>,
);
