/** Minimal VSCode webview shell for the opt-in production UI fixture. */
const { contextBridge, ipcRenderer } = require('electron');
let state;
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  getState: () => state,
  setState: (value) => { state = value; ipcRenderer.send('fixture/persist', value); },
  postMessage: (value) => ipcRenderer.send('fixture/message', value),
}));
