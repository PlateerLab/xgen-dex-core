import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DexError, readSelectedNativeAttachments } from '@dex/engine';
import type { NativeAttachmentSelectionLimits, TrustedNativeAttachment } from './native-attachment-drafts';
import { NATIVE_ATTACHMENT_PICK_CANCEL, NATIVE_ATTACHMENT_PICK_ID_PREFIX, NATIVE_ATTACHMENT_PICK_METHOD,
  pickerLimits, pickerPaths, pickerRecord } from './native-attachment-picker-wire';

interface PendingPicker {
  id: string;
  limits: Readonly<NativeAttachmentSelectionLimits>;
  resolve(paths: readonly string[]): void;
  reject(error: Error): void;
  cancel(): void;
}

/** One engine-issued chooser response on the private extension-host stdio pipe. */
export class NativeAttachmentPickerBroker {
  private enabled = false;
  private pending: PendingPicker | null = null;
  constructor(private readonly send: (frame: unknown) => void) {}

  negotiate(enabled: boolean): void {
    if (enabled !== this.enabled) this.cancel();
    this.enabled = enabled;
  }
  get available(): boolean { return this.enabled; }
  close(): void { this.enabled = false; this.cancel(); }
  private cancel(): void { this.pending?.cancel(); }

  async pick(signal: AbortSignal, value: Readonly<NativeAttachmentSelectionLimits>): Promise<readonly TrustedNativeAttachment[]> {
    signal.throwIfAborted();
    if (!this.enabled) throw new DexError('protocol_mismatch', '확장 호스트 파일 선택을 지원하는 클라이언트가 필요합니다.');
    if (this.pending) throw new DexError('usage_error', '이전 파일 선택을 마친 뒤 다시 선택하세요.');
    const limits = pickerLimits(value);
    const id = `${NATIVE_ATTACHMENT_PICK_ID_PREFIX}${randomUUID()}`;
    let operation!: PendingPicker;
    const selected = new Promise<readonly string[]>((resolve, reject) => {
      operation = { id, limits, resolve, reject, cancel: () => {
        if (this.pending !== operation) return;
        this.pending = null;
        try { this.send({ jsonrpc: '2.0', method: NATIVE_ATTACHMENT_PICK_CANCEL, params: { id } }); } catch { /* closed pipe */ }
        reject(new DOMException('파일 선택이 취소되었습니다.', 'AbortError'));
      } };
    });
    this.pending = operation;
    signal.addEventListener('abort', operation.cancel, { once: true });
    try {
      if (signal.aborted) operation.cancel();
      else this.send({ jsonrpc: '2.0', id, method: NATIVE_ATTACHMENT_PICK_METHOD, params: limits });
      const paths = await selected;
      signal.throwIfAborted();
      return await readSelectedNativeAttachments(paths, signal, limits);
    } finally {
      signal.removeEventListener('abort', operation.cancel);
      if (this.pending === operation) this.pending = null;
    }
  }

  /** Unknown, cancelled and duplicate picker responses are consumed without interpreting paths. */
  receive(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const id = (value as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.startsWith(NATIVE_ATTACHMENT_PICK_ID_PREFIX)) return false;
    const operation = this.pending;
    if (!operation || operation.id !== id) return true;
    this.pending = null;
    try {
      const frame = pickerRecord(value, ['jsonrpc', 'id', 'result']);
      if (frame.jsonrpc !== '2.0') throw new TypeError();
      const result = pickerRecord(frame.result, ['paths']);
      const paths = pickerPaths(result.paths, operation.limits);
      if (paths.some((path) => !isAbsolute(path))) throw new TypeError();
      operation.resolve(paths);
    } catch {
      operation.reject(new DexError('usage_error', '선택한 로컬 파일을 확인할 수 없습니다. 다시 선택하세요.'));
    }
    return true;
  }
}
