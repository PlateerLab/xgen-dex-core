/** Test entry uses the production component and production preload. No credential mocks. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { NativeSessionSettings } from '../src/renderer/src/views/NativeSessionSettings';
import { Workspace } from '../src/renderer/src/views/Workspace';
import '../src/renderer/src/styles.css';
import '../src/renderer/src/views/canonical-chat.css';

const query = new URLSearchParams(location.search);
const origin = query.get('origin')!;
const config = { serverUrl: origin, browser: { enabled: false } };
createRoot(document.getElementById('root')!).render(query.get('workspace') === '1'
  ? <Workspace user={{ userId: query.get('userId')!, username: 'Fixture user', isSuperuser: false, roles: [], permissions: [] }}
    config={config} onLogout={() => {}} onConfigChange={async () => config} />
  : <NativeSessionSettings origin={origin} />);
