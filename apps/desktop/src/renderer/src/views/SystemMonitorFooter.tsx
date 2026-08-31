import React, { useEffect, useState } from 'react';
import type { AppMemoryProcessKind, SystemMetrics } from '../../../core/system-metrics';
import { xgen } from '../bridge';
import { formatMemorySize, formatNetworkRate } from './system-monitor-model';

const POLL_INTERVAL_MS = 1_500;
const GIB = 1024 ** 3;

const MEMORY_KIND_LABELS: Record<AppMemoryProcessKind, string> = {
  main: '메인',
  renderer: '렌더러',
  gpu: 'GPU',
  utility: '유틸리티',
  other: 'Electron 기타',
  external: '외부 자식 프로세스',
};

const MEMORY_KIND_ORDER: AppMemoryProcessKind[] = [
  'main',
  'renderer',
  'gpu',
  'utility',
  'other',
  'external',
];

function percent(value: number): string {
  return `${Math.round(value)}%`;
}

const UsageMetric: React.FC<{
  label: string;
  value: string;
  usage: number | null;
  title: string;
}> = ({ label, value, usage, title }) => (
  <div className="system-metric" title={title}>
    <span className="system-metric-label">{label}</span>
    <span className="system-metric-value">{value}</span>
    <span className="system-meter" aria-hidden>
      <span style={{ width: `${usage ?? 0}%` }} />
    </span>
  </div>
);

const MemoryMetric: React.FC<{ metrics: SystemMetrics | null }> = ({ metrics }) => {
  const systemMemory = metrics
    ? `${(metrics.memoryUsedBytes / GIB).toFixed(1)}/${(metrics.memoryTotalBytes / GIB).toFixed(0)} GB`
    : '—';
  const appMemory = metrics ? formatMemorySize(metrics.appMemoryUsedBytes) : '—';
  const grouped = new Map<AppMemoryProcessKind, number>();
  for (const item of metrics?.appMemoryProcesses ?? []) {
    grouped.set(item.kind, (grouped.get(item.kind) ?? 0) + item.memoryBytes);
  }
  const externalProcesses =
    metrics?.appMemoryProcesses.filter((item) => item.kind === 'external') ?? [];

  return (
    <div
      className="system-metric system-memory-metric"
      tabIndex={0}
      aria-label={
        metrics ? `전체 RAM ${systemMemory}, 앱 RAM ${appMemory}` : 'RAM 사용량을 수집하는 중입니다'
      }
      aria-describedby="system-memory-tooltip"
    >
      <span className="system-metric-label">RAM</span>
      <span className="system-metric-value system-memory-value">
        전체 {systemMemory} · 앱 {appMemory}
      </span>
      <span className="system-meter" aria-hidden>
        <span style={{ width: `${metrics?.memoryPercent ?? 0}%` }} />
      </span>
      <div id="system-memory-tooltip" className="system-memory-tooltip" role="tooltip">
        <div className="system-memory-tooltip-title">RAM 상세</div>
        {metrics ? (
          <>
            <div className="system-memory-tooltip-row system-memory-tooltip-total">
              <span>전체 사용량</span>
              <span>
                {(metrics.memoryUsedBytes / GIB).toFixed(1)} /{' '}
                {(metrics.memoryTotalBytes / GIB).toFixed(0)} GB ({percent(metrics.memoryPercent)})
              </span>
            </div>
            <div className="system-memory-tooltip-row system-memory-tooltip-total">
              <span>앱 합계</span>
              <span>
                {formatMemorySize(metrics.appMemoryUsedBytes)} ({percent(metrics.appMemoryPercent)})
              </span>
            </div>
            <div className="system-memory-tooltip-divider" />
            {MEMORY_KIND_ORDER.filter((kind) => (grouped.get(kind) ?? 0) > 0).map((kind) => (
              <div className="system-memory-tooltip-row" key={kind}>
                <span>{MEMORY_KIND_LABELS[kind]}</span>
                <span>{formatMemorySize(grouped.get(kind) ?? 0)}</span>
              </div>
            ))}
            {externalProcesses.length > 0 && (
              <>
                <div className="system-memory-tooltip-divider" />
                <div className="system-memory-tooltip-section">외부 프로세스</div>
                {externalProcesses.map((item) => (
                  <div
                    className="system-memory-tooltip-row system-memory-process-row"
                    key={item.pid}
                  >
                    <span title={item.name}>
                      {item.name} <small>PID {item.pid}</small>
                    </span>
                    <span>{formatMemorySize(item.memoryBytes)}</span>
                  </div>
                ))}
              </>
            )}
          </>
        ) : (
          <div className="system-memory-tooltip-empty">수집 중…</div>
        )}
      </div>
    </div>
  );
};

export const SystemMonitorFooter: React.FC = () => {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let mounted = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await xgen.system.metrics();
        if (mounted) {
          setMetrics(next);
          setAvailable(true);
        }
      } catch {
        if (mounted) setAvailable(false);
      } finally {
        if (mounted) timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, []);

  const cpu = metrics ? percent(metrics.cpuPercent) : '—';
  const gpu = metrics ? (metrics.gpuPercent === null ? 'N/A' : percent(metrics.gpuPercent)) : '—';
  return (
    <footer className="system-monitor-footer" aria-label="시스템 리소스 사용량">
      <div className={`system-monitor-state ${available ? '' : 'offline'}`}>
        <span className="system-live-dot" aria-hidden />
        <span>시스템</span>
      </div>
      <UsageMetric
        label="CPU"
        value={cpu}
        usage={metrics?.cpuPercent ?? null}
        title={`CPU 사용량 ${cpu}`}
      />
      <UsageMetric
        label="GPU"
        value={gpu}
        usage={metrics?.gpuPercent ?? null}
        title={`GPU 사용량 ${gpu}`}
      />
      <MemoryMetric metrics={metrics} />
      <div className="system-metric system-network" title="현재 네트워크 다운로드 및 업로드 속도">
        <span className="system-metric-label">NET</span>
        <span className="system-metric-value network-down">
          ↓ {metrics ? formatNetworkRate(metrics.networkDownloadBytesPerSecond) : '—'}
        </span>
        <span className="system-metric-value network-up">
          ↑ {metrics ? formatNetworkRate(metrics.networkUploadBytesPerSecond) : '—'}
        </span>
      </div>
    </footer>
  );
};
