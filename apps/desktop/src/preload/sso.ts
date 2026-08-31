// 원격 SSO 완료 응답만 메인 프로세스로 전달하는 격리된 팝업 브리지
import { contextBridge, ipcRenderer } from 'electron';

// sandbox preload는 로컬 require를 지원하지 않으므로 공용 IPC 모듈을 import하지 않는다.
const AUTH_SSO_COMPLETE_CHANNEL = 'auth:ssoComplete';

contextBridge.exposeInMainWorld('xgenDexSsoComplete', (payload: unknown): void => {
  ipcRenderer.send(AUTH_SSO_COMPLETE_CHANNEL, payload);
});
