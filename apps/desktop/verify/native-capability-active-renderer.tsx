/** Live ACTIVE acceptance: production renderer, production IPC and real services. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NativeCapabilities } from '../src/renderer/src/views/NativeCapabilities';
import '../src/renderer/src/views/native-capabilities.css';
const query = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<NativeCapabilities origin={query.get('origin')!}
  userId={query.get('userId')!} sessionId={query.get('sessionId')!} enabled />);
