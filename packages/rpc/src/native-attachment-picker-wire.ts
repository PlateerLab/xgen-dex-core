import { AGENT_ATTACHMENT_MAX_COUNT, AGENT_ATTACHMENT_MAX_TOTAL_BYTES } from '@dex/protocol/agent-session-attachments';
import type { NativeAttachmentSelectionLimits } from './native-attachment-drafts';

export const NATIVE_ATTACHMENT_PICK_METHOD = 'host/pick-native-attachments';
export const NATIVE_ATTACHMENT_PICK_CANCEL = 'host/cancel-native-attachments';
export const NATIVE_ATTACHMENT_PICK_ID_PREFIX = 'native-picker:';

export type NativeAttachmentPicker = (signal: AbortSignal,
  limits: Readonly<NativeAttachmentSelectionLimits>) => Promise<readonly string[]>;

export function pickerRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid picker frame');
  const result: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !keys.every((key) => typeof key === 'string' && fields.includes(key))) throw new TypeError('Invalid picker frame');
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Invalid picker frame');
    result[field] = descriptor.value;
  }
  return result;
}

export function pickerLimits(value: unknown): Readonly<NativeAttachmentSelectionLimits> {
  const fields = pickerRecord(value, ['max_files', 'max_bytes']);
  if (!Number.isInteger(fields.max_files) || Number(fields.max_files) < 1 || Number(fields.max_files) > AGENT_ATTACHMENT_MAX_COUNT
    || !Number.isInteger(fields.max_bytes) || Number(fields.max_bytes) < 0 || Number(fields.max_bytes) > AGENT_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new TypeError('Invalid picker limits');
  }
  return Object.freeze({ max_files: Number(fields.max_files), max_bytes: Number(fields.max_bytes) });
}

export function pickerPaths(value: unknown, limits: Readonly<NativeAttachmentSelectionLimits>): readonly string[] {
  if (!Array.isArray(value) || value.length > limits.max_files) throw new TypeError('Invalid selected files');
  const paths: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const path = value[index];
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || /[\u0000\r\n]/u.test(path)) throw new TypeError('Invalid selected files');
    paths.push(path);
  }
  return Object.freeze(paths);
}
