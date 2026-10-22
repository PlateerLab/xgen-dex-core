import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previousWindowsRelease } from '../scripts/installer-release.mjs';

const release = (version, extra = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ name: `XGen-Dex-Setup-${version}.exe`, browser_download_url: `https://example.invalid/${version}` }],
  ...extra,
});

test('an older candidate cannot count a downgrade or same-version replacement as upgrade', () => {
  const selected = previousWindowsRelease([
    release('1.101.0'), release('1.100.0'), release('1.98.0'), release('1.99.0'),
  ], '1.100.0');
  assert.equal(selected.release.tag_name, 'v1.99.0');
});

test('draft, prerelease and mismatched installers cannot become an upgrade baseline', () => {
  const selected = previousWindowsRelease([
    release('1.99.0', { draft: true }), release('1.98.0', { prerelease: true }),
    release('1.97.0', { assets: release('1.96.0').assets }), release('1.95.0'),
    release('1.94.0', { tag_name: 'v1.99.0-rc.1' }),
  ], '1.100.0');
  assert.equal(selected.release.tag_name, 'v1.95.0');
});

test('missing lower stable Windows assets never fall back to latest', () => {
  assert.equal(previousWindowsRelease([release('1.101.0'), release('1.100.0')], '1.100.0'), null);
  assert.throws(() => previousWindowsRelease([], '1.100.0-rc.1'));
});
