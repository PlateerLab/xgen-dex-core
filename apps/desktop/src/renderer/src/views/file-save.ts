/** 받은 바이트·data URL 을 이 PC 에 저장 — 브라우저 다운로드 경로(Electron 이 저장 위치를 정한다). */

export function saveBytes(bytes: Uint8Array, contentType: string, fileName: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  saveBlob(new Blob([buffer], { type: contentType || 'application/octet-stream' }), fileName);
}

export function saveDataUrl(dataUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  a.click();
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
