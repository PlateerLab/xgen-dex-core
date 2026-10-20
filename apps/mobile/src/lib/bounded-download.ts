/** Native downloads write to private cache; never import a cancelled/oversized result into a connected folder. */
export interface NativeDownloadPort {
  create(progress: (written: number, expected: number) => void): {
    downloadAsync(): Promise<{ uri: string; status: number } | undefined>;
    cancelAsync(): Promise<void>;
  };
  size(uri: string): Promise<number>;
  remove(): Promise<void>;
}

export async function boundedDownload(
  port: NativeDownloadPort,
  options: { signal?: AbortSignal; maxBytes: number; timeoutMs?: number },
): Promise<string> {
  const { signal, maxBytes, timeoutMs = 600_000 } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid download limits.');
  }
  const aborted = (): Error => Object.assign(new Error('Download cancelled or timed out.'), { name: 'AbortError' });
  if (signal?.aborted) throw aborted();
  let failure: Error | undefined;
  let rejectStop: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  void stopped.catch(() => undefined);
  let task: ReturnType<NativeDownloadPort['create']> | undefined;
  const stop = (error: Error): void => {
    if (failure) return;
    failure = error;
    rejectStop(error);
    void task?.cancelAsync().catch(() => undefined);
  };
  task = port.create((written, expected) => {
    if (written > maxBytes || expected > maxBytes) stop(new Error('Download exceeds the workspace copy byte limit.'));
  });
  const onAbort = (): void => stop(aborted());
  const timer = setTimeout(onAbort, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let complete = false;
  let pending: Promise<{ uri: string; status: number } | undefined> | undefined;
  try {
    if (failure) throw failure;
    pending = task.downloadAsync();
    // Some native backends finish after cancellation. Delete that late cache result as well.
    void pending.then(() => { if (failure) return port.remove().catch(() => undefined); }, () => undefined);
    const result = await Promise.race([pending, stopped]);
    if (!result) throw aborted();
    if (result.status < 200 || result.status >= 300) throw new Error(`Workspace download failed (${result.status}).`);
    const size = await Promise.race([port.size(result.uri), stopped]);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error('Invalid or oversized workspace download.');
    if (failure || signal?.aborted) throw failure ?? aborted();
    complete = true;
    return result.uri;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!complete) {
      void task.cancelAsync().catch(() => undefined);
      await port.remove().catch(() => undefined);
    }
  }
}
