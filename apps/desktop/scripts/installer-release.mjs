/** Select a real lower stable version, even when this branch trails releases. */
export function stableVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '');
  return match ? match.slice(1).map(BigInt) : null;
}

function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function previousWindowsRelease(releases, candidate) {
  const current = stableVersion(candidate);
  if (!current) throw new Error('Candidate must have a stable semantic version');
  const eligible = [];
  for (const release of releases) {
    const version = stableVersion(release.tag_name);
    if (release.draft || release.prerelease || !version || compare(version, current) >= 0) continue;
    const name = `XGen-Dex-Setup-${version.join('.')}.exe`;
    const asset = (release.assets ?? []).find((entry) => entry.name === name && entry.browser_download_url);
    if (asset) eligible.push({ release, asset, version });
  }
  eligible.sort((left, right) => compare(right.version, left.version));
  return eligible[0] ?? null;
}
