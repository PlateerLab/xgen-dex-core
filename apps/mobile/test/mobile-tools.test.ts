// 모바일 도구 — 카탈로그 형상, 대화별 폴더 범위, 디스패치 (인메모리 포트·폴더).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertiseMobileTools,
  callMobileTool,
  FOLDER_TOOLS,
  TOOL_GROUPS,
  type DevicePort,
  type FolderEntry,
  type FolderFs,
  type FolderScope,
} from '../src/lib/mobile-tools';
import { NO_FOLDER_MESSAGE, type MobileFolder } from '../src/lib/mobile-folders';

function fakePort(): DevicePort & { notified: string[]; opened: string[] } {
  const notified: string[] = [];
  const opened: string[] = [];
  let clip = '';
  return {
    notified,
    opened,
    async notify(title, body) {
      notified.push(`${title}|${body}`);
    },
    async clipboardRead() {
      return clip;
    },
    async clipboardWrite(text) {
      clip = text;
    },
    async deviceInfo() {
      return { model: 'Pixel-테스트', platform: 'android' };
    },
    async batteryInfo() {
      return { level: 0.8, isCharging: false };
    },
    async networkStatus() {
      return { connected: true, connectionType: 'wifi' };
    },
    async share() {},
    async openUrl() {},
    async vibrate() {},
    async capturePhoto() {
      return 'file:///cache/camera/shot.jpg';
    },
    async openFileWith(uri) {
      opened.push(uri);
    },
    async location() {
      return { latitude: 37.5665, longitude: 126.978, accuracy: 12 };
    },
    async requestPermission() {
      return 'granted' as const;
    },
  };
}

/** 폴더 URI → (상대 경로 → 내용). 폴더는 경로 끝이 '/' 인 항목으로 둔다. */
function fakeFs(): FolderFs & { files: Map<string, Map<string, string>> } {
  const files = new Map<string, Map<string, string>>();
  const of = (folder: MobileFolder) => {
    if (!files.has(folder.uri)) files.set(folder.uri, new Map());
    return files.get(folder.uri)!;
  };
  const isDir = (tree: Map<string, string>, rel: string) =>
    rel === '' || [...tree.keys()].some((key) => key.startsWith(`${rel}/`));
  return {
    files,
    async list(folder, rel) {
      const tree = of(folder);
      if (!isDir(tree, rel)) throw new Error(`폴더를 찾을 수 없습니다: ${rel}`);
      const prefix = rel ? `${rel}/` : '';
      const seen = new Map<string, FolderEntry>();
      for (const [key, value] of tree) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const name = rest.split('/')[0];
        const dir = rest.includes('/');
        if (!seen.has(name)) seen.set(name, { name, isDir: dir, size: dir ? 0 : value.length });
      }
      return [...seen.values()];
    },
    async stat(folder, rel) {
      const tree = of(folder);
      if (tree.has(rel)) return { exists: true, isDir: false, size: tree.get(rel)!.length };
      return { exists: isDir(tree, rel), isDir: isDir(tree, rel), size: 0 };
    },
    async readText(folder, rel, maxBytes) {
      const text = of(folder).get(rel);
      if (text === undefined) throw new Error(`파일이 없습니다: ${rel}`);
      return { text: text.slice(0, maxBytes), size: text.length, truncated: text.length > maxBytes };
    },
    async writeText(folder, rel, content, append) {
      const tree = of(folder);
      tree.set(rel, append ? (tree.get(rel) ?? '') + content : content);
    },
    async importFile(folder, rel, sourceUri) {
      of(folder).set(rel, `<copy of ${sourceUri}>`);
    },
    async remove(folder, rel) {
      const tree = of(folder);
      if (!tree.delete(rel)) throw new Error(`파일이 없습니다: ${rel}`);
    },
    async exportFile(folder, rel) {
      if (!of(folder).has(rel)) throw new Error(`파일이 없습니다: ${rel}`);
      return `file:///cache/xgen-open/${rel.split('/').pop()}`;
    },
  };
}

const notes: MobileFolder = { id: 'f-notes', name: 'Notes', uri: 'content://tree/notes' };
const photos: MobileFolder = { id: 'f-photos', name: 'Photos', uri: 'content://tree/photos' };

function scope(folders: MobileFolder[] = [notes, photos]): FolderScope & { fs: ReturnType<typeof fakeFs> } {
  return { folders, fs: fakeFs() };
}

test('카탈로그 — mobile 네임스페이스 + JSON Schema 형상 (hello 프레임 계약)', () => {
  const tools = advertiseMobileTools();
  assert.ok(tools.length >= 10);
  for (const t of tools) {
    assert.equal(t.server, 'mobile'); // 데스크톱 local 과 이름 불충돌
    assert.ok(t.name && t.description);
    assert.equal((t.inputSchema as { type?: string }).type, 'object');
  }
  const names = tools.map((t) => t.name);
  for (const required of [...FOLDER_TOOLS, 'Notify', 'Clipboard', 'DeviceInfo']) {
    assert.ok(names.includes(required), `${required} 누락`);
  }
  // 파일은 설정의 도구 그룹이 아니다 — 대화마다 [폴더 연결]이 범위를 정한다.
  assert.ok(!TOOL_GROUPS.some((g) => (g.id as string) === 'files'));
});

test('폴더가 없는 대화에서는 파일 도구를 모두 거부하고 방법을 알린다', async () => {
  const port = fakePort();
  for (const tool of FOLDER_TOOLS) {
    const r = await callMobileTool(port, tool, { path: 'a.txt', query: 'x', content: '' }, undefined, scope([]));
    assert.equal(r.isError, true, tool);
    assert.equal(r.content[0].text, NO_FOLDER_MESSAGE, tool);
  }
  const none = await callMobileTool(port, 'ReadFile', { path: 'a.txt' });
  assert.equal(none.content[0].text, NO_FOLDER_MESSAGE);
});

test('파일 왕복 — 가상 경로 /<폴더>/…, 상대 경로는 첫 폴더', async () => {
  const port = fakePort();
  const s = scope();
  const w = await callMobileTool(port, 'WriteFile', { path: '메모/할일.txt', content: '1. 우유' }, undefined, s);
  assert.equal(w.content[0].text, '저장했습니다: /Notes/메모/할일.txt');
  await callMobileTool(port, 'WriteFile', { path: '/Notes/메모/할일.txt', content: '\n2. 빵', append: true }, undefined, s);
  const read = await callMobileTool(port, 'ReadFile', { path: '/Notes/메모/할일.txt' }, undefined, s);
  assert.equal(read.content[0].text, '1. 우유\n2. 빵');

  await callMobileTool(port, 'WriteFile', { path: '/Photos/목록.txt', content: 'x' }, undefined, s);
  assert.equal(s.fs.files.get(photos.uri)?.get('목록.txt'), 'x'); // 두 번째 폴더로 간다

  const list = await callMobileTool(port, 'ListDir', { path: '/Notes/메모' }, undefined, s);
  assert.match(list.content[0].text, /^\/Notes\/메모  \(times are the phone's local time\)\n- 할일\.txt \(\d+B\)/);
  const root = await callMobileTool(port, 'ListDir', {}, undefined, s);
  assert.match(root.content[0].text, /d 메모\//);

  const del = await callMobileTool(port, 'DeleteFile', { path: '/Notes/메모/할일.txt' }, undefined, s);
  assert.equal(del.isError, undefined);
  const missing = await callMobileTool(port, 'ReadFile', { path: '/Notes/메모/할일.txt' }, undefined, s);
  assert.equal(missing.isError, true); // 예외는 isError 결과로 — 브리지가 죽지 않는다
});

test('연결된 폴더 밖·폴더 자체·상위 이동은 거부한다', async () => {
  const port = fakePort();
  const s = scope();
  const outside = await callMobileTool(port, 'ReadFile', { path: '/Download/secret.txt' }, undefined, s);
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /PATH_DOMAIN_MISMATCH/);
  const up = await callMobileTool(port, 'ReadFile', { path: '/Notes/../Photos/a.txt' }, undefined, s);
  assert.match(up.content[0].text, /PATH_DOMAIN_MISMATCH/);
  const rootDelete = await callMobileTool(port, 'DeleteFile', { path: '/Notes' }, undefined, s);
  assert.equal(rootDelete.isError, true);
  assert.match(rootDelete.content[0].text, /폴더 자체/);
});

test('Search — 하위 폴더까지 찾아 가상 경로와 줄 번호로 알린다', async () => {
  const port = fakePort();
  const s = scope();
  await callMobileTool(port, 'WriteFile', { path: 'a.md', content: 'hello\nNEEDLE one' }, undefined, s);
  await callMobileTool(port, 'WriteFile', { path: 'sub/b.txt', content: 'x\ny\nNEEDLE two' }, undefined, s);
  await callMobileTool(port, 'WriteFile', { path: 'img.png', content: 'NEEDLE binary' }, undefined, s);
  const r = await callMobileTool(port, 'Search', { query: 'NEEDLE' }, undefined, s);
  const lines = r.content[0].text.split('\n').sort();
  assert.deepEqual(lines, ['/Notes/a.md:2: NEEDLE one', '/Notes/sub/b.txt:3: NEEDLE two']);
  const none = await callMobileTool(port, 'Search', { query: 'absent' }, undefined, s);
  assert.match(none.content[0].text, /찾지 못했습니다/);
});

test('OpenFile·TakePhoto — 연결한 폴더의 파일을 열고, 사진은 폴더에 저장한다', async () => {
  const port = fakePort();
  const s = scope();
  await callMobileTool(port, 'WriteFile', { path: 'doc.txt', content: 'x' }, undefined, s);
  const opened = await callMobileTool(port, 'OpenFile', { path: '/Notes/doc.txt' }, undefined, s);
  assert.equal(opened.isError, undefined);
  assert.deepEqual(port.opened, ['file:///cache/xgen-open/doc.txt']);

  const shot = await callMobileTool(port, 'TakePhoto', { path: '/Photos/현장' }, undefined, s);
  assert.equal(shot.content[0].text, '사진을 저장했습니다: /Photos/현장.jpg');
  assert.equal(s.fs.files.get(photos.uri)?.get('현장.jpg'), '<copy of file:///cache/camera/shot.jpg>');
  const auto = await callMobileTool(port, 'TakePhoto', {}, undefined, s);
  assert.match(auto.content[0].text, /\/Notes\/photo-\d+\.jpg/);
});

test('알림/클립보드/기기정보 — 폴더와 무관하고 LocalToolResult 계약을 따른다', async () => {
  const port = fakePort();
  const n = await callMobileTool(port, 'Notify', { title: '빌드', body: '완료' });
  assert.deepEqual(n, { content: [{ type: 'text', text: '알림을 표시했습니다.' }] });
  assert.deepEqual(port.notified, ['빌드|완료']);

  await callMobileTool(port, 'Clipboard', { action: 'write', text: '복사본' });
  const read = await callMobileTool(port, 'Clipboard', { action: 'read' });
  assert.equal(read.content[0].text, '복사본');
  const bad = await callMobileTool(port, 'Clipboard', { action: 'paste' });
  assert.equal(bad.isError, true);

  const info = await callMobileTool(port, 'DeviceInfo', {});
  const parsed = JSON.parse(info.content[0].text);
  assert.equal(parsed.model, 'Pixel-테스트');
  assert.equal(parsed.network.connectionType, 'wifi');
});

test('그룹 게이트 — 꺼진 그룹의 도구는 카탈로그에서 빠지고 호출도 거부된다', async () => {
  const { advertiseMobileTools: adv, TOOL_TO_GROUP } = await import('../src/lib/mobile-tools');
  const enabled = { location: false, camera: false } as const;
  const names = adv(enabled).map((t) => t.name);
  assert.ok(!names.includes('Location'));
  assert.ok(!names.includes('TakePhoto')); // 카메라 그룹이 꺼지면 사진도 없다
  assert.ok(names.includes('ReadFile')); // 파일 도구는 그룹이 아니다

  const port = fakePort();
  const blocked = await callMobileTool(port, 'Location', {}, enabled);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /꺼 두었습니다/);
  const noCamera = await callMobileTool(port, 'TakePhoto', {}, enabled, scope());
  assert.match(noCamera.content[0].text, /꺼 두었습니다/);
  assert.equal(TOOL_TO_GROUP.Location, 'location');
});

test('Location — 위도/경도/지도 링크를 돌려준다', async () => {
  const port = fakePort();
  const r = await callMobileTool(port, 'Location', {});
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.latitude, 37.5665);
  assert.match(parsed.maps, /maps\.google\.com/);
});

test('OpenUrl — http(s) 만, 모르는 도구는 오류', async () => {
  const port = fakePort();
  const bad = await callMobileTool(port, 'OpenUrl', { url: 'file:///etc/passwd' });
  assert.equal(bad.isError, true);
  const okUrl = await callMobileTool(port, 'OpenUrl', { url: 'https://xgen.example' });
  assert.equal(okUrl.isError, undefined);
  const unknown = await callMobileTool(port, 'NoSuchTool', {});
  assert.equal(unknown.isError, true);
});

test('다른 화면에서 온 요청은 휴대폰 앞에 사람이 있어야 하는 도구를 쓰지 않는다', async () => {
  const port = fakePort();
  const s = { ...scope(), remoteFrom: '사무실 PC' };
  await callMobileTool(port, 'WriteFile', { path: 'doc.txt', content: 'x' }, undefined, s);
  for (const tool of ['OpenFile', 'TakePhoto']) {
    const r = await callMobileTool(port, tool, { path: '/Notes/doc.txt' }, undefined, s);
    assert.equal(r.isError, true, tool);
    assert.match(r.content[0].text, /사무실 PC에서 왔습니다/);
  }
  assert.deepEqual(port.opened, []);
  const read = await callMobileTool(port, 'ReadFile', { path: '/Notes/doc.txt' }, undefined, s);
  assert.equal(read.isError, undefined);
});

test('ListDir 은 수정 시각을 폰의 현지 시각으로 보여 준다 — "오늘 받은 파일" 의 근거', async () => {
  const s = scope();
  const at = new Date(2026, 9, 2, 9, 5).getTime();
  s.fs.list = async () => [{ name: '확인요청.docx', isDir: false, size: 120, modified: at }];
  const r = await callMobileTool(fakePort(), 'ListDir', {}, undefined, s);
  assert.match(r.content[0].text, /- 확인요청\.docx \(120B, modified 2026-10-02 09:05\)/);
});

function fakeTransfer() {
  const uploads: string[] = [];
  const discarded: string[] = [];
  return {
    uploads,
    discarded,
    async upload(localUri: string, name: string, relDir: string) {
      uploads.push(`${relDir}|${name}|${localUri}`);
      return { path: `uploads/users_1/conv/${relDir ? `${relDir}/` : ''}${name}`, size: 3, sha256: 'h' };
    },
    async download(url: string, token: string | undefined, name: string) {
      return `file:///cache/xgen-copy/${name}?${url}&${token ?? ''}`;
    },
    async discard(localUri: string) {
      discarded.push(localUri);
    },
  };
}

test('CopyToWorkspace — 파일은 첨부 폴더 바로 아래로, 폴더는 이름부터 구조째, 사본은 지운다', async () => {
  const s = scope();
  const tree = new Map([
    ['KakaoTalk/확인요청.docx', 'abc'],
    ['KakaoTalk/sub/보고.hwp', 'abcd'],
    ['KakaoTalk/.nomedia', ''],
    ['a.pdf', 'x'],
  ]);
  s.fs.files.set(notes.uri, tree);
  const transfer = fakeTransfer();
  const r = await callMobileTool(
    fakePort(),
    'CopyToWorkspace',
    { paths: ['/Notes/a.pdf', '/Notes/KakaoTalk', '/Notes/없음.txt'] },
    undefined,
    { ...s, workspace: transfer },
  );
  assert.equal(r.isError, undefined);
  assert.deepEqual(transfer.uploads.map((u) => u.split('|').slice(0, 2).join('|')), [
    '|a.pdf',
    'KakaoTalk/sub|보고.hwp',
    'KakaoTalk|확인요청.docx',
  ]);
  assert.equal(transfer.discarded.length, 3, '앱 캐시에 만든 사본은 올린 뒤 지운다');
  assert.deepEqual(
    (r.structuredContent?.workspaceFiles as Array<{ path: string }>).map((f) => f.path),
    ['uploads/users_1/conv/a.pdf', 'uploads/users_1/conv/KakaoTalk/sub/보고.hwp', 'uploads/users_1/conv/KakaoTalk/확인요청.docx'],
  );
  assert.match(r.content[0].text, /\/Notes\/없음\.txt: not found/);
  const noCtx = await callMobileTool(fakePort(), 'CopyToWorkspace', { paths: ['a.pdf'] }, undefined, s);
  assert.equal(noCtx.isError, true, '이 호출의 대화를 모르면 옮기지 않는다');
});

test('CopyFromWorkspace — 서버가 실은 파일을 폴더에 두고, 있는 파일은 덮어쓰라고 할 때만 바꾼다', async () => {
  const s = scope();
  const transfer = fakeTransfer();
  const download = { url: '/api/agentflow/files/artifacts/abc/download', token: 't', name: 'report.docx' };
  const ctx = { ...s, workspace: transfer };
  const saved = await callMobileTool(fakePort(), 'CopyFromWorkspace', { source: 'out/report.docx', path: '/Notes', download }, undefined, ctx);
  assert.equal(saved.content[0].text, 'Saved report.docx to /Notes/report.docx.');
  assert.match(s.fs.files.get(notes.uri)?.get('report.docx') ?? '', /copy of file:\/\/\/cache\/xgen-copy\/report\.docx/);
  const again = await callMobileTool(fakePort(), 'CopyFromWorkspace', { source: 'x', path: '/Notes/report.docx', download }, undefined, ctx);
  assert.equal(again.isError, true);
  const over = await callMobileTool(
    fakePort(),
    'CopyFromWorkspace',
    { source: 'x', path: '/Notes/report.docx', download, overwrite: true },
    undefined,
    ctx,
  );
  assert.equal(over.isError, undefined);
  const nested = await callMobileTool(fakePort(), 'CopyFromWorkspace', { source: 'x', path: '/Photos/결과/', download }, undefined, ctx);
  assert.equal(nested.content[0].text, 'Saved report.docx to /Photos/결과/report.docx.');
  const old = await callMobileTool(fakePort(), 'CopyFromWorkspace', { source: 'x', path: '/Notes' }, undefined, ctx);
  assert.equal(old.isError, true, '옛 서버는 받을 거리를 싣지 않는다');
  assert.equal(transfer.discarded.length, 3, '받은 사본은 폴더에 넣은 뒤 지운다');
});
