#!/usr/bin/env node
/**
 * XD 엔진 동봉본 — 이 OS·아키텍처용 Python 하나에 엔진과 의존성을 넣는다.
 *
 *   node apps/xd/scripts/bundle-engine.mjs [--skip-verify]
 *
 * 결과: apps/xd/engine/dist/<platform>-<arch>/python  (설치본은 이 폴더를 그대로 싣는다 — M6)
 *
 * 순서:
 *   1. python-build-standalone 압축본을 받아 sha256 을 확인한다(engine/bundle/bundle.json).
 *   2. 잠금(requirements.lock · nodeps.lock)을 **해시 검증·의존성 따라가지 않기·바이너리만** 으로 넣는다.
 *   3. xd_engine 을 site-packages 에 넣고, 쓰지 않는 것(tcl/tk·idle·pip…)을 걷어 낸다.
 *   4. pyc 를 만든다(unchecked-hash — 읽기 전용 설치 폴더에서 매번 다시 컴파일하지 않게).
 *   5. 도장(xd-engine.json)을 찍고, 동봉된 인터프리터로 검증한다(engine/bundle/verify.py).
 *
 * 다른 아키텍처용은 그 아키텍처에서 만든다 — 패키지 설치를 그 인터프리터가 직접 하므로(플랫폼 표지·
 * wheel 선택이 정확하다). Geny 앱은 맥 두 dmg 에 arm64 인터프리터 하나를 넣어 Intel 맥에서 돌지 않았다.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const XD = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(XD, 'engine');
const BUNDLE = join(ENGINE, 'bundle');
const manifest = JSON.parse(readFileSync(join(BUNDLE, 'bundle.json'), 'utf8'));
const skipVerify = process.argv.includes('--skip-verify');

const target = `${process.platform}-${process.arch}`;
const spec = manifest.python.targets[target];
if (!spec) {
  console.error(`이 플랫폼(${target})용 Python 이 bundle.json 에 없습니다: ${Object.keys(manifest.python.targets).join(', ')}`);
  process.exit(2);
}
const isWin = process.platform === 'win32';
const outDir = join(ENGINE, 'dist', target);
const pyDir = join(outDir, 'python');
const python = isWin ? join(pyDir, 'python.exe') : join(pyDir, 'bin', 'python3');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 디스크 크기(바이트). 심볼릭 링크(python3 → python3.12)는 세지 않고, 하드링크는 한 번만 센다. */
function dirSize(path, seen = new Set()) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) {
    const key = `${st.dev}:${st.ino}`;
    if (st.nlink > 1 && seen.has(key)) return 0;
    seen.add(key);
    return st.size;
  }
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name), seen), 0);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

// ── 1. 인터프리터 ─────────────────────────────────────────────────────
async function fetchPython() {
  const cache = join(ENGINE, '.cache', 'python');
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `cpython-${manifest.python.version}-${manifest.python.release}-${spec.triple}.tar.gz`);
  if (!existsSync(archive) || sha256(archive) !== spec.sha256) {
    const url = manifest.python.url.replace('{triple}', spec.triple);
    console.log(`받는 중: ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`다운로드 실패 ${res.status} ${url}`);
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }
  const got = sha256(archive);
  if (got !== spec.sha256) throw new Error(`sha256 불일치: ${got} (기대 ${spec.sha256})`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // Windows 는 System32 의 tar(bsdtar)를 쓴다 — PATH 에 Git 의 GNU tar 가 먼저 있으면 `D:\…` 를 원격 호스트로 읽는다.
  const tar = isWin ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  run(tar, ['-xzf', archive, '-C', outDir]);
  if (!existsSync(python)) throw new Error(`압축을 풀었지만 인터프리터가 없습니다: ${python}`);
}

// ── 2·3. 패키지 ───────────────────────────────────────────────────────
function scriptsDir() {
  return isWin ? join(pyDir, 'Scripts') : join(pyDir, 'bin');
}

function install() {
  const before = new Set(existsSync(scriptsDir()) ? readdirSync(scriptsDir()) : []);
  // --isolated: 이 PC 의 pip 설정·환경 변수를 무시한다. 해시가 맞지 않거나 wheel 이 없으면 실패한다.
  run(python, [
    '-I', '-m', 'pip', 'install', '--isolated', '--no-input', '--disable-pip-version-check',
    '--no-deps', '--require-hashes', '--only-binary=:all:', '--no-compile', '--no-warn-script-location',
    '-r', join(BUNDLE, 'requirements.lock'),
    '-r', join(BUNDLE, 'nodeps.lock'),
  ]);
  // 패키지가 깐 실행 스크립트(openai·httpx 같은 CLI)는 빌드 경로를 shebang 에 박는다 — 쓰지 않고 옮기면 깨진다.
  if (existsSync(scriptsDir())) {
    for (const name of readdirSync(scriptsDir())) {
      if (!before.has(name)) rmSync(join(scriptsDir(), name), { recursive: true, force: true });
    }
  }
  const site = capture(python, ['-I', '-c', "import sysconfig;print(sysconfig.get_paths()['purelib'])"]);
  cpSync(join(ENGINE, 'xd_engine'), join(site, 'xd_engine'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  });
  run(python, ['-I', '-m', 'pip', 'uninstall', '--isolated', '-y', '--disable-pip-version-check', 'pip']);
  return site;
}

function matchPrune(pattern, base = pyDir) {
  const parts = pattern.split('/');
  const last = parts.pop();
  const dir = join(base, ...parts);
  if (!existsSync(dir)) return [];
  if (!last.includes('*')) return existsSync(join(dir, last)) ? [join(dir, last)] : [];
  const [head, tail] = last.split('*');
  return readdirSync(dir)
    .filter((name) => name.startsWith(head) && name.endsWith(tail) && name.length >= head.length + tail.length)
    .map((name) => join(dir, name));
}

/** 이름이 `names` 중 하나인 폴더를 어느 깊이에서든 찾는다(찾은 폴더 안으로는 더 들어가지 않는다). */
function dirsNamed(root, names, found = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (names.includes(entry.name)) found.push(path);
    else dirsNamed(path, names, found);
  }
  return found;
}

function prune(site) {
  const targets = [
    // 리눅스 인터프리터는 libpython 을 정적으로 품는다 — 따로 든 .so 는 아무도 쓰지 않는다(확장 모듈 67개 확인).
    ...[...(isWin ? [] : manifest.prune.posix), ...(manifest.prune[process.platform] ?? [])].flatMap((pattern) =>
      matchPrune(pattern),
    ),
    ...manifest.prunePackages.paths.flatMap((pattern) => matchPrune(pattern, site)),
    ...dirsNamed(site, manifest.prunePackages.dirsNamed),
  ];
  let removed = 0;
  for (const path of targets) {
    removed += dirSize(path);
    rmSync(path, { recursive: true, force: true });
  }
  return removed;
}

// ── 4. pyc ────────────────────────────────────────────────────────────
function compile() {
  const stdlib = capture(python, ['-I', '-c', "import sysconfig;print(sysconfig.get_paths()['stdlib'])"]);
  // 실패(어떤 파일이 이 파이썬 문법이 아님)는 숨기지 않는다 — 그 파일은 import 될 때 깨진다.
  const skip = manifest.compileSkip.patterns.join('|');
  run(python, ['-I', '-m', 'compileall', '-q', '-j', '0', '--invalidation-mode', 'unchecked-hash', '-x', skip, stdlib]);
}

// ── 5. 도장 · 검증 ────────────────────────────────────────────────────
function stamp() {
  const app = JSON.parse(readFileSync(join(XD, 'package.json'), 'utf8'));
  const runtime = capture(python, ['-I', '-c', "from importlib.metadata import version;print(version('xgen-agent-runtime'))"]);
  const info = {
    app: app.version,
    target,
    python: manifest.python.version,
    pythonRelease: manifest.python.release,
    runtime,
    locks: {
      requirements: sha256(join(BUNDLE, 'requirements.lock')),
      nodeps: sha256(join(BUNDLE, 'nodeps.lock')),
    },
  };
  writeFileSync(join(pyDir, 'xd-engine.json'), JSON.stringify(info, null, 2) + '\n');
  return info;
}

await fetchPython();
const base = dirSize(pyDir);
const site = install();
const pruned = prune(site);
compile();
const info = stamp();
console.log(
  `\nXD 엔진 동봉본 ${target}: ${mb(dirSize(pyDir))} (인터프리터 ${mb(base)}, site-packages ${mb(dirSize(site))}, 걷어 낸 것 ${mb(pruned)})`,
);
console.log(`  runtime ${info.runtime} · python ${info.python} · ${pyDir}`);
if (!skipVerify) run(python, ['-I', join(BUNDLE, 'verify.py')]);
