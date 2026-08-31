import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { basename } from 'node:path';
import type { AppMemoryProcess, AppMemoryProcessKind, SystemMetrics } from '../core/system-metrics';

interface CpuCounters {
  idle: number;
  total: number;
}

interface NetworkCounters {
  interfaceName: string;
  receivedBytes: number;
  transmittedBytes: number;
}

interface MemoryUsage {
  usedBytes: number;
  totalBytes: number;
}

export interface ElectronProcessMemorySnapshot {
  pid: number;
  type: string;
  name?: string;
  memoryBytes: number;
}

export interface ProcessMemoryRow {
  pid: number;
  parentPid: number;
  memoryBytes: number;
  name: string;
}

interface ProcessListSnapshot {
  rows: ProcessMemoryRow[];
}

/** Short-lived commands used to collect metrics must not count as app workloads. */
const metricCollectorPids = new Set<number>();

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function readCpuCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuCounters, current: CpuCounters): number {
  const elapsed = current.total - previous.total;
  if (elapsed <= 0) return 0;
  return clampPercent((1 - (current.idle - previous.idle) / elapsed) * 100);
}

function run(command: string, args: string[], timeout = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
    if (child.pid) metricCollectorPids.add(child.pid);
  });
}

export function parseUnixProcessMemoryRows(output: string): ProcessMemoryRow[] {
  const rows: ProcessMemoryRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      memoryBytes: Number(match[3]) * 1024,
      name: match[4],
    });
  }
  return rows;
}

export function parseWindowsProcessMemoryRows(output: string): ProcessMemoryRow[] {
  const rows: ProcessMemoryRow[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split('\t');
    if (fields.length < 4) continue;
    const [pid, parentPid, memoryBytes] = fields.slice(0, 3).map(Number);
    if (![pid, parentPid, memoryBytes].every(Number.isFinite)) continue;
    rows.push({
      pid,
      parentPid,
      memoryBytes,
      name: fields.slice(3).join('\t').trim(),
    });
  }
  return rows;
}

function runProcessList(
  command: string,
  args: string[],
  parser: (output: string) => ProcessMemoryRow[],
): Promise<ProcessListSnapshot> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 3_000, windowsHide: true },
      (error, stdout) => resolve({ rows: error ? [] : parser(stdout) }),
    );
    if (child.pid) metricCollectorPids.add(child.pid);
  });
}

async function readProcessList(): Promise<ProcessListSnapshot> {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return runProcessList('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], parseUnixProcessMemoryRows);
  }
  if (process.platform === 'win32') {
    const script = [
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,Name',
      'ForEach-Object { Write-Output "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.Name)" }',
    ].join(' | ');
    return runProcessList(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      parseWindowsProcessMemoryRows,
    );
  }
  return { rows: [] };
}

function descendantPids(rows: ProcessMemoryRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid) ?? [];
    siblings.push(row.pid);
    children.set(row.parentPid, siblings);
  }
  const result = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length) {
    const parentPid = pending.pop()!;
    for (const childPid of children.get(parentPid) ?? []) {
      if (result.has(childPid)) continue;
      result.add(childPid);
      pending.push(childPid);
    }
  }
  return result;
}

function electronProcessKind(type: string): AppMemoryProcessKind {
  switch (type.toLowerCase()) {
    case 'browser':
      return 'main';
    case 'tab':
    case 'renderer':
      return 'renderer';
    case 'gpu':
      return 'gpu';
    case 'utility':
      return 'utility';
    default:
      return 'other';
  }
}

function electronProcessName(metric: ElectronProcessMemorySnapshot): string {
  if (metric.name?.trim()) return metric.name.trim();
  switch (electronProcessKind(metric.type)) {
    case 'main':
      return '메인 프로세스';
    case 'renderer':
      return '렌더러';
    case 'gpu':
      return 'GPU 프로세스';
    case 'utility':
      return '유틸리티';
    default:
      return metric.type || 'Electron 프로세스';
  }
}

function externalProcessName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '외부 프로세스';
  return basename(trimmed.replace(/\\/g, '/')) || trimmed;
}

/** Merge Electron's own metrics with non-Electron descendants without double counting. */
export function buildAppMemoryProcesses(
  rows: ProcessMemoryRow[],
  electronProcesses: ElectronProcessMemorySnapshot[],
  rootPid: number,
  collectorPids: Iterable<number> = [],
): AppMemoryProcess[] {
  const processes: AppMemoryProcess[] = [];
  const included = new Set<number>();

  for (const metric of electronProcesses) {
    if (
      !Number.isInteger(metric.pid) ||
      metric.pid <= 0 ||
      included.has(metric.pid) ||
      !Number.isFinite(metric.memoryBytes)
    ) {
      continue;
    }
    processes.push({
      pid: metric.pid,
      name: electronProcessName(metric),
      kind: electronProcessKind(metric.type),
      memoryBytes: Math.max(0, metric.memoryBytes),
    });
    included.add(metric.pid);
  }

  const appPids = descendantPids(rows, rootPid);
  const excludedPids = new Set<number>();
  for (const collectorPid of collectorPids) {
    for (const pid of descendantPids(rows, collectorPid)) excludedPids.add(pid);
  }
  for (const row of rows) {
    if (!appPids.has(row.pid) || excludedPids.has(row.pid) || included.has(row.pid)) continue;
    processes.push({
      pid: row.pid,
      name: row.pid === rootPid ? '메인 프로세스' : externalProcessName(row.name),
      kind: row.pid === rootPid ? 'main' : 'external',
      memoryBytes: Math.max(0, row.memoryBytes),
    });
    included.add(row.pid);
  }

  const order: Record<AppMemoryProcessKind, number> = {
    main: 0,
    renderer: 1,
    gpu: 2,
    utility: 3,
    other: 4,
    external: 5,
  };
  return processes.sort(
    (left, right) => order[left.kind] - order[right.kind] || right.memoryBytes - left.memoryBytes,
  );
}

export function parseDarwinDefaultInterface(output: string): string | null {
  return output.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
}

export function parseDarwinNetworkCounters(
  output: string,
  interfaceName: string,
): NetworkCounters | null {
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== interfaceName || !fields[2]?.startsWith('<Link#')) continue;
    const receivedBytes = Number(fields[6]);
    const transmittedBytes = Number(fields[9]);
    if (Number.isFinite(receivedBytes) && Number.isFinite(transmittedBytes)) {
      return { interfaceName, receivedBytes, transmittedBytes };
    }
  }
  return null;
}

export function parseLinuxDefaultInterface(output: string): string | null {
  for (const line of output.trim().split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === '00000000') return fields[0] ?? null;
  }
  return null;
}

export function parseLinuxNetworkCounters(
  output: string,
  interfaceName: string,
): NetworkCounters | null {
  for (const line of output.split('\n')) {
    const [name, values] = line.split(':', 2);
    if (name?.trim() !== interfaceName || !values) continue;
    const fields = values.trim().split(/\s+/);
    const receivedBytes = Number(fields[0]);
    const transmittedBytes = Number(fields[8]);
    if (Number.isFinite(receivedBytes) && Number.isFinite(transmittedBytes)) {
      return { interfaceName, receivedBytes, transmittedBytes };
    }
  }
  return null;
}

export function parseGpuPercent(output: string): number | null {
  const values: number[] = [];
  const patterns = [
    /"Device Utilization %"\s*=\s*([\d.]+)/g,
    /"GPU Activity\(%\)"\s*=\s*([\d.]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (!values.length) return null;
  return clampPercent(Math.max(...values));
}

function vmStatPages(output: string, label: string): number {
  const match = output.match(new RegExp(`^${label}:\\s*(\\d+)\\.?$`, 'm'));
  return match ? Number(match[1]) : 0;
}

export function parseDarwinMemoryUsage(output: string): MemoryUsage | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/i)?.[1]);
  const reportedTotal = Number(output.match(/system has (\d+) bytes/i)?.[1]);
  const totalBytes = Number.isFinite(reportedTotal) ? reportedTotal : totalmem();
  if (!Number.isFinite(pageSize)) return null;
  const usedPages =
    vmStatPages(output, 'Pages active') +
    vmStatPages(output, 'Pages wired down') +
    vmStatPages(output, 'Pages occupied by compressor');
  return { usedBytes: Math.min(totalBytes, usedPages * pageSize), totalBytes };
}

export function parseLinuxMemoryUsage(output: string): MemoryUsage | null {
  const totalKib = Number(output.match(/^MemTotal:\s*(\d+)\s+kB$/m)?.[1]);
  const availableKib = Number(output.match(/^MemAvailable:\s*(\d+)\s+kB$/m)?.[1]);
  if (!Number.isFinite(totalKib) || !Number.isFinite(availableKib)) return null;
  return {
    usedBytes: Math.max(0, totalKib - availableKib) * 1024,
    totalBytes: totalKib * 1024,
  };
}

async function darwinNetworkCounters(): Promise<NetworkCounters | null> {
  const route = await run('/sbin/route', ['-n', 'get', 'default']);
  const interfaceName = route ? parseDarwinDefaultInterface(route) : null;
  if (!interfaceName) return null;
  const stats = await run('/usr/sbin/netstat', ['-ibn', '-I', interfaceName]);
  return stats ? parseDarwinNetworkCounters(stats, interfaceName) : null;
}

async function linuxNetworkCounters(): Promise<NetworkCounters | null> {
  try {
    const [routes, stats] = await Promise.all([
      readFile('/proc/net/route', 'utf8'),
      readFile('/proc/net/dev', 'utf8'),
    ]);
    const interfaceName = parseLinuxDefaultInterface(routes);
    return interfaceName ? parseLinuxNetworkCounters(stats, interfaceName) : null;
  } catch {
    return null;
  }
}

async function windowsNetworkCounters(): Promise<NetworkCounters | null> {
  const script = [
    "$r=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop",
    '$r=$r | Sort-Object RouteMetric | Select-Object -First 1',
    '$s=Get-NetAdapterStatistics -Name $r.InterfaceAlias -ErrorAction Stop',
    'Write-Output "$($r.InterfaceIndex),$($s.ReceivedBytes),$($s.SentBytes)"',
  ].join(';');
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const match = output?.trim().match(/^(\d+),(\d+),(\d+)$/);
  if (!match) return null;
  return {
    interfaceName: match[1],
    receivedBytes: Number(match[2]),
    transmittedBytes: Number(match[3]),
  };
}

async function readNetworkCounters(): Promise<NetworkCounters | null> {
  if (process.platform === 'darwin') return darwinNetworkCounters();
  if (process.platform === 'linux') return linuxNetworkCounters();
  if (process.platform === 'win32') return windowsNetworkCounters();
  return null;
}

async function readMemoryUsage(): Promise<MemoryUsage> {
  if (process.platform === 'darwin') {
    const output = await run('/usr/bin/vm_stat', []);
    const parsed = output ? parseDarwinMemoryUsage(output) : null;
    if (parsed) return parsed;
  }
  if (process.platform === 'linux') {
    try {
      const parsed = parseLinuxMemoryUsage(await readFile('/proc/meminfo', 'utf8'));
      if (parsed) return parsed;
    } catch {
      /* Fall through to Node's portable counters. */
    }
  }
  const totalBytes = totalmem();
  return { usedBytes: Math.max(0, totalBytes - freemem()), totalBytes };
}

async function darwinGpuPercent(): Promise<number | null> {
  const output = await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-l', '-w', '0']);
  return output ? parseGpuPercent(output) : null;
}

async function linuxGpuPercent(): Promise<number | null> {
  try {
    const entries = await readdir('/sys/class/drm', { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      if (!/^card\d+$/.test(entry.name)) continue;
      try {
        const value = Number(
          await readFile(`/sys/class/drm/${entry.name}/device/gpu_busy_percent`, 'utf8'),
        );
        if (Number.isFinite(value)) return clampPercent(value);
      } catch {
        /* This driver does not expose gpu_busy_percent. */
      }
    }
  } catch {
    /* DRM is unavailable, so try NVIDIA's user-space counter below. */
  }
  const output = await run('nvidia-smi', [
    '--query-gpu=utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  const values = output?.split('\n').map(Number).filter(Number.isFinite);
  return values?.length ? clampPercent(Math.max(...values)) : null;
}

async function windowsGpuPercent(): Promise<number | null> {
  const script = [
    "$v=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples",
    '$v=$v | ForEach-Object {$_.CookedValue}',
    'if ($v) {($v | Measure-Object -Maximum).Maximum}',
  ].join(';');
  const output = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    3_000,
  );
  const value = Number(output?.trim());
  return output?.trim() && Number.isFinite(value) ? clampPercent(value) : null;
}

async function readGpuPercent(): Promise<number | null> {
  if (process.platform === 'darwin') return darwinGpuPercent();
  if (process.platform === 'linux') return linuxGpuPercent();
  if (process.platform === 'win32') return windowsGpuPercent();
  return null;
}

class SystemMetricsSampler {
  private cpu = readCpuCounters();
  private network: NetworkCounters | null = null;
  private networkSampledAt = Date.now();
  private pending: Promise<SystemMetrics> | null = null;

  sample(electronProcesses: ElectronProcessMemorySnapshot[] = []): Promise<SystemMetrics> {
    if (this.pending) return this.pending;
    this.pending = this.collect(electronProcesses).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async collect(
    electronProcesses: ElectronProcessMemorySnapshot[],
  ): Promise<SystemMetrics> {
    metricCollectorPids.clear();
    const cpu = readCpuCounters();
    const cpuPercent = cpuPercentBetween(this.cpu, cpu);
    this.cpu = cpu;

    const [network, gpuPercent, memory, processList] = await Promise.all([
      readNetworkCounters(),
      readGpuPercent(),
      readMemoryUsage(),
      readProcessList(),
    ]);
    const sampledAt = Date.now();
    let networkDownloadBytesPerSecond = 0;
    let networkUploadBytesPerSecond = 0;
    if (network && this.network?.interfaceName === network.interfaceName) {
      const elapsedSeconds = Math.max(0.001, (sampledAt - this.networkSampledAt) / 1_000);
      networkDownloadBytesPerSecond = Math.max(
        0,
        (network.receivedBytes - this.network.receivedBytes) / elapsedSeconds,
      );
      networkUploadBytesPerSecond = Math.max(
        0,
        (network.transmittedBytes - this.network.transmittedBytes) / elapsedSeconds,
      );
    }
    this.network = network;
    this.networkSampledAt = sampledAt;

    const memoryTotalBytes = memory.totalBytes;
    const memoryUsedBytes = memory.usedBytes;
    const appMemoryProcesses = buildAppMemoryProcesses(
      processList.rows,
      electronProcesses,
      process.pid,
      metricCollectorPids,
    );
    const appMemoryUsedBytes = appMemoryProcesses.reduce(
      (total, item) => total + item.memoryBytes,
      0,
    );
    return {
      sampledAt,
      cpuPercent,
      gpuPercent,
      memoryUsedBytes,
      memoryTotalBytes,
      memoryPercent: clampPercent((memoryUsedBytes / Math.max(1, memoryTotalBytes)) * 100),
      appMemoryUsedBytes,
      appMemoryPercent: clampPercent((appMemoryUsedBytes / Math.max(1, memoryTotalBytes)) * 100),
      appMemoryProcesses,
      networkDownloadBytesPerSecond,
      networkUploadBytesPerSecond,
    };
  }
}

export const systemMetricsSampler = new SystemMetricsSampler();
