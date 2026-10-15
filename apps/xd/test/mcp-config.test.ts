import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMcpServers, engineMcpServers, mcpSlugs, splitCommand, splitMcpSecrets } from '../src/main/mcp-config';

test('MCP 설정 검사: 이름은 겹치지 않게, stdio 는 명령, http·sse 는 주소, OAuth 는 아직 받지 않는다', () => {
  const ok = cleanMcpServers([
    { name: 'GitHub', transport: 'stdio', command: 'npx -y @modelcontextprotocol/server-github', env: { GITHUB_TOKEN: 'ghp_1' } },
    { name: 'Docs', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' }, enabled: false },
  ]);
  assert.deepEqual(ok.map((s) => [s.name, s.transport, s.enabled]), [
    ['GitHub', 'stdio', true],
    ['Docs', 'http', false],
  ]);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return null;
  };
  assert.equal(code(() => cleanMcpServers([{ name: 'a', command: 'x' }, { name: 'A', command: 'y' }])), 'mcp_duplicate');
  assert.equal(code(() => cleanMcpServers([{ name: '', command: 'x' }])), 'mcp_name');
  assert.equal(code(() => cleanMcpServers([{ name: 'a', transport: 'stdio' }])), 'mcp_command');
  assert.equal(code(() => cleanMcpServers([{ name: 'a', transport: 'http', url: 'ftp://x' }])), 'mcp_url');
  assert.equal(code(() => cleanMcpServers([{ name: 'a', transport: 'http', url: 'https://x', auth: 'oauth' }])), 'mcp_oauth');
  assert.deepEqual(cleanMcpServers(undefined), []);
});

test('비밀은 갈라서 — 설정에는 키만, 빈 값은 저장된 값을 그대로', () => {
  const [gh] = cleanMcpServers([{ name: 'GitHub', command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_1', MODE: 'x' } }]);
  const first = splitMcpSecrets([gh], null);
  assert.deepEqual(first.servers[0].env, { GITHUB_TOKEN: '', MODE: '' });
  assert.deepEqual(first.secrets, { GitHub: { env: { GITHUB_TOKEN: 'ghp_1', MODE: 'x' }, headers: undefined } });
  // 화면은 저장된 값을 모른다 — 빈 칸으로 다시 보내면 그대로, 새 값이면 바뀐다
  const again = splitMcpSecrets(cleanMcpServers([{ name: 'GitHub', command: 'gh-mcp', env: { GITHUB_TOKEN: '', MODE: 'y' } }]), first.secrets);
  assert.deepEqual(again.secrets.GitHub.env, { GITHUB_TOKEN: 'ghp_1', MODE: 'y' });
});

test('엔진으로: 켜 둔 것만, 비밀을 되살리고, 한 줄 명령은 따옴표를 알아 쪼갠다', () => {
  const servers = cleanMcpServers([
    { name: 'GitHub', command: 'npx -y "@scope/server github" --flag', env: { TOKEN: '' } },
    { name: 'Off', command: 'x', enabled: false },
    { name: 'Raw', command: 'C:\\Program Files\\node.exe', args: ['server.js', 'a b'] },
    { name: 'Web', transport: 'sse', url: 'https://example.com/sse', headers: { Authorization: '' } },
  ]);
  const out = engineMcpServers(servers, { GitHub: { env: { TOKEN: 's1' } }, Web: { headers: { Authorization: 'Bearer z' } } });
  assert.deepEqual(out, [
    { slug: 'github', label: 'GitHub', transport: 'stdio', command: 'npx', args: ['-y', '@scope/server github', '--flag'], env: { TOKEN: 's1' } },
    { slug: 'raw', label: 'Raw', transport: 'stdio', command: 'C:\\Program Files\\node.exe', args: ['server.js', 'a b'] },
    // 'web' 은 런타임이 기기 도구(mcp_web_…)로 다루는 이름이라 피한다
    { slug: 'web-mcp', label: 'Web', transport: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'Bearer z' } },
  ]);
});

test('이름표: 소문자·숫자·하이픈 12자, 런타임이 쓰는 이름은 피하고, 이름에서만 정한다(목록 순서와 무관)', () => {
  const slugs0 = mcpSlugs(['GitHub Enterprise Server', 'local', '_x_', '깃허브']);
  assert.deepEqual(slugs0.slice(0, 3), ['github-enter', 'local-mcp', 'x']);
  assert.match(slugs0[3], /^m[0-9a-f]{7}$/);
  for (const s of slugs0) assert.match(s, /^[a-z0-9][a-z0-9-]{0,11}$/);
  // 앞의 서버를 지워도 뒤 서버의 이름표(= 지난 턴의 도구 이름)가 바뀌지 않는다
  const slugs = (names: string[]) => engineMcpServers(cleanMcpServers(names.map((name) => ({ name, command: 'x' }))), null).map((s) => s.slug);
  const [, notion] = slugs(['깃허브', '노션']);
  assert.equal(slugs(['노션'])[0], notion);
  // 다듬은 꼴이 겹쳐도 순서와 상관없이 같다
  const a = slugs(['GitHub!', 'GitHub?']);
  const b = slugs(['GitHub?', 'GitHub!']);
  assert.notEqual(a[0], a[1]);
  assert.deepEqual([a[0], a[1]], [b[1], b[0]]);
  for (const s of a) assert.match(s, /^github-[0-9a-f]{4}$/);
});

test('이름을 바꿔도 비밀은 따라간다(previousName), 저장할 때는 떼어 낸다', () => {
  const stored = { GitHub: { env: { TOKEN: 'ghp_1' } } };
  const renamed = cleanMcpServers([{ name: 'GitHub work', previousName: 'GitHub', command: 'gh', env: { TOKEN: '' } }]);
  const { servers, secrets } = splitMcpSecrets(renamed, stored);
  assert.deepEqual(secrets, { 'GitHub work': { env: { TOKEN: 'ghp_1' }, headers: undefined } });
  assert.equal('previousName' in servers[0], false);
});

test('이름 맞바꾸기 — 비밀은 원래 서버를 따라간다', () => {
  const stored = { Notion: { headers: { Authorization: 'Bearer NOTION' } }, Docs: { headers: { Authorization: 'Bearer DOCS' } } };
  const swapped = cleanMcpServers([
    { name: 'Notion', previousName: 'Docs', transport: 'http', url: 'https://docs.example/mcp', headers: { Authorization: '' } },
    { name: 'Docs', previousName: 'Notion', transport: 'http', url: 'https://notion.example/mcp', headers: { Authorization: '' } },
  ]);
  const { secrets } = splitMcpSecrets(swapped, stored);
  assert.equal(secrets.Notion.headers?.Authorization, 'Bearer DOCS');
  assert.equal(secrets.Docs.headers?.Authorization, 'Bearer NOTION');
});

test('쪼갠 뒤 빈 명령은 받지 않는다(엔진과 같은 규칙)', () => {
  assert.throws(() => cleanMcpServers([{ name: 'a', command: '""' }]), (e: Error & { code?: string }) => e.code === 'mcp_command');
  assert.equal(cleanMcpServers([{ name: 'a', command: 'x', args: [] }]).length, 1);
});

test('한 줄 명령 쪼개기', () => {
  assert.deepEqual(splitCommand('uvx mcp-server-fetch'), ['uvx', 'mcp-server-fetch']);
  assert.deepEqual(splitCommand(`node "C:\\My Tools\\srv.js" --name 'a b' ""`), ['node', 'C:\\My Tools\\srv.js', '--name', 'a b', '']);
});
