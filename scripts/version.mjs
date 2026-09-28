#!/usr/bin/env node
/**
 * 버전은 하나다 — 루트 package.json 이 정본이고, 이 저장소에서 나가는 모든 것
 * (데스크톱·CLI·VS Code 확장·패키지·모바일 앱)이 같은 버전을 단다.
 *
 * 예전에는 모바일만 따로 놀았다(package.json 1.38.0 · app.json 1.37.1 ·
 * iOS Info.plist 1.25.0). 그러면 "이 APK 가 어느 릴리스의 것인가"를 아무도 모른다.
 *
 *   node scripts/version.mjs check        # 전부 같은지 — CI 가 매번 본다
 *   node scripts/version.mjs set 1.60.0   # 전부 바꾼다 — 릴리스 워크플로가 부른다
 *
 * 모바일 빌드 번호(안드로이드 versionCode · iOS CFBundleVersion)는 버전에서
 * 파생한다: M·10⁶ + m·10³ + p. 버전이 오르면 번호도 오르므로 설치본이 업데이트된다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+$/;

/** 최상위 "version" 을 가진 package.json 들. */
const PACKAGES = [
  'package.json',
  'packages/engine/package.json',
  'packages/protocol/package.json',
  'packages/rpc/package.json',
  'apps/cli/package.json',
  'apps/vscode/package.json',
  'apps/desktop/package.json',
  'apps/mobile/package.json',
];
/** 우리 패키지의 버전이 적혀 있는 잠금 파일들. */
const LOCKS = ['package-lock.json', 'apps/desktop/package-lock.json', 'apps/mobile/package-lock.json'];
const EXPO_APP = 'apps/mobile/app.json';
const IOS_PLIST = 'apps/mobile/ios/XGENDex/Info.plist';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const write = (rel, text) => writeFileSync(join(ROOT, rel), text);

export function buildNumber(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return String(major * 1_000_000 + minor * 1_000 + patch);
}

/** 잠금 파일에서 우리 것(루트·워크스페이스)의 버전 항목들. node_modules/ 아래는 남의 것이다. */
function lockEntries(lock) {
  const out = [['(header)', lock]];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key.startsWith('node_modules/') || key.includes('/node_modules/')) continue;
    if (entry && typeof entry === 'object' && 'version' in entry) out.push([key || '(root)', entry]);
  }
  return out;
}

function plistValue(text, key) {
  const m = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return m ? m[1] : null;
}

/** 지금 적혀 있는 버전들 — [위치, 값]. */
export function collect() {
  const found = [];
  for (const rel of PACKAGES) found.push([rel, JSON.parse(read(rel)).version]);
  for (const rel of LOCKS) {
    for (const [key, entry] of lockEntries(JSON.parse(read(rel)))) found.push([`${rel} ${key}`, entry.version]);
  }
  found.push([`${EXPO_APP} expo.version`, JSON.parse(read(EXPO_APP)).expo?.version]);
  const plist = read(IOS_PLIST);
  found.push([`${IOS_PLIST} CFBundleShortVersionString`, plistValue(plist, 'CFBundleShortVersionString')]);
  return { found, iosBuild: plistValue(plist, 'CFBundleVersion') };
}

export function check() {
  const version = JSON.parse(read('package.json')).version;
  const { found, iosBuild } = collect();
  const wrong = found.filter(([, value]) => value !== version);
  if (iosBuild !== buildNumber(version)) {
    wrong.push([`${IOS_PLIST} CFBundleVersion (빌드 번호)`, `${iosBuild} ≠ ${buildNumber(version)}`]);
  }
  return { version, wrong };
}

/** package.json 은 모양을 건드리지 않으려고 최상위 version 한 줄만 바꾼다. */
function setPackage(rel, version) {
  const text = read(rel);
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(next).version !== version) throw new Error(`${rel}: 최상위 version 을 찾지 못했습니다`);
  write(rel, next);
}

/** 잠금 파일은 npm 이 쓰는 모양(2칸 JSON + 줄바꿈) 그대로 다시 쓴다. */
function setLock(rel, version) {
  const lock = JSON.parse(read(rel));
  for (const [, entry] of lockEntries(lock)) entry.version = version;
  write(rel, `${JSON.stringify(lock, null, 2)}\n`);
}

function setExpo(version) {
  const text = read(EXPO_APP);
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(next).expo?.version !== version) throw new Error(`${EXPO_APP}: expo.version 을 찾지 못했습니다`);
  write(EXPO_APP, next);
}

function setPlist(version) {
  let text = read(IOS_PLIST);
  for (const [key, value] of [
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', buildNumber(version)],
  ]) {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
    if (!re.test(text)) throw new Error(`${IOS_PLIST}: ${key} 를 찾지 못했습니다`);
    text = text.replace(re, `$1${value}$2`);
  }
  write(IOS_PLIST, text);
}

export function set(version) {
  if (!SEMVER.test(version)) throw new Error(`버전은 x.y.z 여야 합니다: ${version}`);
  for (const rel of PACKAGES) setPackage(rel, version);
  for (const rel of LOCKS) setLock(rel, version);
  setExpo(version);
  setPlist(version);
}

/** "patch" · "minor" · "major" 또는 x.y.z → 다음 버전. */
export function nextVersion(current, bump) {
  if (SEMVER.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`patch · minor · major 또는 x.y.z 여야 합니다: ${bump}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'check') {
    const { version, wrong } = check();
    if (wrong.length) {
      console.error(`버전이 ${version} 이 아닌 곳이 있습니다 — node scripts/version.mjs set ${version}`);
      for (const [where, value] of wrong) console.error(`  ${where}: ${value}`);
      process.exit(1);
    }
    console.log(`버전 ${version} — 모든 앱·패키지가 같습니다.`);
  } else if (command === 'set' && arg) {
    const current = JSON.parse(read('package.json')).version;
    const version = nextVersion(current, arg);
    set(version);
    console.log(version);
  } else {
    console.error('사용법: node scripts/version.mjs check | set <x.y.z|patch|minor|major>');
    process.exit(2);
  }
}
