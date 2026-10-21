import { copyFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arch, platform } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const output = join(root, 'prebuilds', `${platform}-${arch}`, 'native-fs.node');
await mkdir(dirname(output), { recursive: true });

const source = join(root, 'src', 'native_fs.cc');
const nodeInclude = process.env.NODE_INCLUDE_DIR || (
  platform === 'darwin' ? '/opt/homebrew/include/node' : '/usr/include/node'
);
const localHeader = join(nodeInclude, 'node_api.h');
if (platform === 'win32' || !existsSync(localHeader)) {
  const nodeGyp = resolve(root, '..', '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  if (!existsSync(nodeGyp)) {
    throw new Error('node-gyp is required to build native-fs when NODE_INCLUDE_DIR is unavailable');
  }
  const built = spawnSync(process.execPath, [nodeGyp, 'rebuild'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`native-fs node-gyp build failed (exit ${built.status})`);
  await copyFile(join(root, 'build', 'Release', 'native_fs.node'), `${output}.tmp`);
  await rename(`${output}.tmp`, output);
  console.log(output);
  process.exit(0);
}
let command;
let args;
if (platform === 'darwin') {
  command = process.env.CXX || 'clang++';
  args = ['-std=c++17', '-O2', '-fvisibility=hidden', '-DNODE_GYP_MODULE_NAME=native_fs', '-bundle', '-undefined', 'dynamic_lookup',
    '-I', nodeInclude, source, '-o', `${output}.tmp`];
} else if (platform === 'linux') {
  command = process.env.CXX || 'c++';
  args = ['-std=c++17', '-O2', '-fPIC', '-fvisibility=hidden', '-DNODE_GYP_MODULE_NAME=native_fs', '-shared',
    '-I', nodeInclude, source, '-o', `${output}.tmp`];
} else if (platform === 'win32') {
  command = process.env.CXX || 'cl.exe';
  args = ['/nologo', '/std:c++17', '/O2', '/LD', '/DNODE_GYP_MODULE_NAME=native_fs', `/I${nodeInclude}`, source,
    `/link`, `/OUT:${output}.tmp`];
} else {
  throw new Error(`Unsupported native-fs build platform: ${platform}`);
}
const built = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
if (built.status !== 0) throw new Error(`native-fs build failed (${command}, exit ${built.status})`);
await rename(`${output}.tmp`, output);
console.log(output);
