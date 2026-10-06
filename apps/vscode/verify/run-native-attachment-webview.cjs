/** Production webview rendering/actions with a disposable shell and mocked attachment state.
 * Run from any directory after building the CLI and installing Desktop dependencies.
 * No user credentials or real file chooser are used; controller/transport have separate tests.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-attachment-ui-context-'));
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ version: 1, currentProfile: 'fixture',
  profiles: { fixture: { serverUrl: 'https://localhost:3443' } }, localTools: { enabled: false } }));
const electron = require(path.join(root, 'apps/desktop/node_modules/electron'));
const child = spawn(electron, ['-r', 'tsx/cjs', 'apps/vscode/verify/native-turn-webview.cjs',
  '--origin=https://localhost:3443', '--user-id=7', `--node=${process.execPath}`],
  { cwd: root, env: { ...process.env, DEX_CLI_HOME: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = ''; let complete = false; let failure = false;
const timer = setTimeout(() => { failure = true; child.kill(); }, 60_000);
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let result; try { result = JSON.parse(line); } catch { continue; }
    if (result.id === 1) {
      if (result.error) { failure = true; process.stderr.write(`${JSON.stringify(result)}\n`); child.kill(); }
      else child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'verify/attachment-ui' })}\n`);
    } else if (result.id === 2) {
      complete = !result.error; failure = !!result.error; process.stdout.write(`${JSON.stringify(result)}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`);
    }
  }
});
child.on('error', () => { failure = true; });
child.on('close', (code) => {
  clearTimeout(timer); fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = complete && !failure && code === 0 ? 0 : 1;
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
