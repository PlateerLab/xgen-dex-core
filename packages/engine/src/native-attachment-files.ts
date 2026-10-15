import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { AGENT_ATTACHMENT_MAX_BYTES, AGENT_ATTACHMENT_MAX_COUNT } from '@dex/protocol/agent-session-attachments';

export interface SelectedNativeAttachment {
  filename: string;
  media_type: string;
  bytes: Uint8Array;
}

interface SelectionLimits { readonly max_files: number; readonly max_bytes: number }

const READ_CHUNK_BYTES = 64 * 1024;
const READ_ERROR = '선택한 일반 파일을 읽지 못했습니다. 최대 10개, 합계 100 MiB 이내의 파일을 다시 선택하세요.';

function filename(path: string): string {
  const name = basename(path).normalize('NFC');
  if (!name || name === '.' || name === '..' || new TextEncoder().encode(name).length > 255
    || /[\\/\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)
    || /[\ud800-\udfff]/u.test(name)) throw new Error(READ_ERROR);
  return name;
}

/** Only a trusted host picker or explicit terminal input supplies paths. Returned buffers transfer to the RPC host. */
export async function readSelectedNativeAttachments(paths: readonly string[], signal: AbortSignal,
  limits: SelectionLimits = { max_files: AGENT_ATTACHMENT_MAX_COUNT, max_bytes: AGENT_ATTACHMENT_MAX_BYTES },
): Promise<readonly SelectedNativeAttachment[]> {
  const selected: SelectedNativeAttachment[] = [];
  let currentBytes: Uint8Array | null = null;
  try {
    signal.throwIfAborted();
    if (!Number.isInteger(limits.max_files) || limits.max_files < 0 || limits.max_files > AGENT_ATTACHMENT_MAX_COUNT
      || !Number.isInteger(limits.max_bytes) || limits.max_bytes < 0 || limits.max_bytes > AGENT_ATTACHMENT_MAX_BYTES
      || !Array.isArray(paths) || paths.length > limits.max_files) throw new Error(READ_ERROR);
    let total = 0;
    for (const path of paths) {
      signal.throwIfAborted();
      if (typeof path !== 'string' || path.length > 4096 || !isAbsolute(path)) throw new Error(READ_ERROR);
      const name = filename(path);
      const before = await lstat(path);
      signal.throwIfAborted();
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(READ_ERROR);
      // NOFOLLOW prevents final-component swaps; NONBLOCK avoids waiting on a swapped FIFO.
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        signal.throwIfAborted();
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino
          || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs
          || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > AGENT_ATTACHMENT_MAX_BYTES
          || total + stat.size > limits.max_bytes) throw new Error(READ_ERROR);
        currentBytes = new Uint8Array(stat.size);
        let position = 0;
        while (position < currentBytes.length) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(currentBytes, position, Math.min(READ_CHUNK_BYTES, currentBytes.length - position), position);
          signal.throwIfAborted();
          if (bytesRead === 0) throw new Error(READ_ERROR);
          position += bytesRead;
        }
        const after = await handle.stat();
        signal.throwIfAborted();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error(READ_ERROR);
        selected.push(Object.freeze({ filename: name, media_type: 'application/octet-stream', bytes: currentBytes }));
        total += stat.size;
        currentBytes = null;
      } finally { await handle.close(); }
    }
    return Object.freeze(selected);
  } catch (error) {
    currentBytes?.fill(0);
    for (const file of selected) file.bytes.fill(0);
    if (signal.aborted) throw new DOMException('파일 선택이 취소되었습니다.', 'AbortError');
    // Node filesystem errors contain local paths. Never forward them to the renderer or RPC.
    void error;
    throw new Error(READ_ERROR);
  }
}
