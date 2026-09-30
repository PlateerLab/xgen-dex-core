/** Test entry uses the production component and production preload. No credential mocks. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NativeSessionSettings } from '../src/renderer/src/views/NativeSessionSettings';
import '../src/renderer/src/styles.css';

createRoot(document.getElementById('root')!).render(<NativeSessionSettings origin={new URLSearchParams(location.search).get('origin')!} />);
