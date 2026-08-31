export type AppMemoryProcessKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'other' | 'external';

/** One process included in the application's RAM total. */
export interface AppMemoryProcess {
  pid: number;
  name: string;
  kind: AppMemoryProcessKind;
  memoryBytes: number;
}

/** A point-in-time snapshot of this computer's resource usage. */
export interface SystemMetrics {
  sampledAt: number;
  cpuPercent: number;
  /** null when the operating system does not expose a readable GPU counter. */
  gpuPercent: number | null;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  /** Electron processes plus every currently attached descendant process. */
  appMemoryUsedBytes: number;
  /** Application RAM as a percentage of total physical RAM. */
  appMemoryPercent: number;
  /** Per-process data used by the RAM hover detail. */
  appMemoryProcesses: AppMemoryProcess[];
  networkDownloadBytesPerSecond: number;
  networkUploadBytesPerSecond: number;
}
