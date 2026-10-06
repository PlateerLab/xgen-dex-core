import { NATIVE_ATTACHMENT_PICK_CANCEL, NATIVE_ATTACHMENT_PICK_ID_PREFIX, NATIVE_ATTACHMENT_PICK_METHOD,
  pickerLimits, pickerPaths, pickerRecord, type NativeAttachmentPicker } from './native-attachment-picker-wire';

/** Runs only a constructor-supplied trusted extension-host dialog, never a webview callback. */
export class NativeAttachmentPickerResponder {
  private enabled = false;
  private pending: { id: string; controller: AbortController } | null = null;
  constructor(private readonly picker: NativeAttachmentPicker | undefined, private readonly send: (frame: unknown) => void) {}
  negotiate(enabled: boolean): void { this.reset(); this.enabled = enabled && Boolean(this.picker); }
  reset(): void {
    this.enabled = false; this.pending?.controller.abort();
    // Native dialogs may ignore AbortSignal. Keep the single slot until that callback settles.
  }

  handle(value: Record<string, unknown>): boolean {
    if (value.method === NATIVE_ATTACHMENT_PICK_CANCEL) {
      try {
        const frame = pickerRecord(value, ['jsonrpc', 'method', 'params']);
        const params = pickerRecord(frame.params, ['id']);
        const operation = this.pending;
        if (frame.jsonrpc === '2.0' && operation && operation.id === params.id) {
          operation.controller.abort();
        }
      } catch { /* invalid control frame cannot affect another chooser */ }
      return true;
    }
    if (value.method !== NATIVE_ATTACHMENT_PICK_METHOD) return false;
    const id = value.id;
    if (typeof id !== 'string' || !/^native-picker:[0-9a-f-]{36}$/.test(id) || !id.startsWith(NATIVE_ATTACHMENT_PICK_ID_PREFIX)) return true;
    let limits;
    try {
      const frame = pickerRecord(value, ['jsonrpc', 'id', 'method', 'params']);
      if (frame.jsonrpc !== '2.0' || !this.enabled || !this.picker || this.pending) throw new TypeError();
      limits = pickerLimits(frame.params);
    } catch { this.failure(id); return true; }
    const operation = { id, controller: new AbortController() };
    this.pending = operation;
    void (async () => {
      try {
        const paths = pickerPaths(await this.picker!(operation.controller.signal, limits), limits);
        if (this.pending !== operation || operation.controller.signal.aborted) return;
        this.send({ jsonrpc: '2.0', id, result: { paths } });
      } catch {
        if (this.pending === operation && !operation.controller.signal.aborted) this.failure(id);
      } finally { if (this.pending === operation) this.pending = null; }
    })();
    return true;
  }
  private failure(id: string): void {
    try { this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: '파일 선택을 완료할 수 없습니다.' } }); } catch { /* closed pipe */ }
  }
}
