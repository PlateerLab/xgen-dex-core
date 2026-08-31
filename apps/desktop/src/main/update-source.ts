// XGEN 다운로드 센터에서 현재 운영체제에 맞는 Connector 업데이트를 선택한다.
export type UpdateServer = 'github' | 'xgen';

export interface XgenInstallerPackage {
  id: number | string;
  product?: string;
  display_name?: string;
  version?: string;
  platform?: string;
  original_name?: string;
  file_size?: number;
  content_type?: string;
  file_hash?: string;
  release_notes?: string;
  created_at?: string;
}

/** 진행 UI를 표시하면서 업데이트 모드와 설치 후 재실행을 유지한다. */
export function windowsNsisUpdateArgs(): string[] {
  return ['--updated', '--force-run'];
}

/** Connector 종료 안전망 이후 NSIS를 여는 고정 Windows launcher 명령이다. */
export function windowsNsisLauncherCommand(): string {
  return `ping 127.0.0.1 -n 5 > nul & start "" "%XGEN_UPDATE_INSTALLER%" ${windowsNsisUpdateArgs().join(' ')}`;
}

/** 점으로 구분된 버전을 비교한다. a가 크면 양수, b가 크면 음수다. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const difference = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isCompatiblePlatform(pkg: XgenInstallerPackage, platform: NodeJS.Platform): boolean {
  const declared = (pkg.platform ?? '').trim().toLowerCase();
  const filename = (pkg.original_name ?? '').toLowerCase();
  if (platform === 'win32') {
    return ['windows', 'win32', 'win'].includes(declared) || filename.endsWith('.exe');
  }
  if (platform === 'darwin') {
    return ['macos', 'mac', 'darwin', 'osx'].includes(declared) || filename.endsWith('.dmg');
  }
  if (platform === 'linux') {
    return declared === 'linux' || filename.endsWith('.appimage') || filename.endsWith('.deb');
  }
  return false;
}

/** 목록의 is_latest 값은 플랫폼 공통이므로 OS 호환 패키지 중 버전으로 직접 고른다. */
export function selectXgenUpdate(
  packages: XgenInstallerPackage[],
  platform: NodeJS.Platform,
  currentVersion: string,
): XgenInstallerPackage | null {
  const candidates = packages.filter(
    (pkg) =>
      (pkg.product ?? '').toLowerCase() === 'connector' &&
      !!pkg.version &&
      compareVersions(pkg.version, currentVersion) > 0 &&
      isCompatiblePlatform(pkg, platform),
  );
  candidates.sort((a, b) => {
    const versionOrder = compareVersions(b.version ?? '', a.version ?? '');
    if (versionOrder !== 0) return versionOrder;
    return Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? '');
  });
  return candidates[0] ?? null;
}
