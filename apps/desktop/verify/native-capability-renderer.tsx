import React from 'react';
import { createRoot } from 'react-dom/client';
import { NativeCapabilities } from '../src/renderer/src/views/NativeCapabilities';
import '../src/renderer/src/views/native-capabilities.css';

createRoot(document.getElementById('root')!).render(<NativeCapabilities origin="https://fixture.example.test" userId="7"
  sessionId="00000000-0000-4000-8000-000000000001" enabled />);
