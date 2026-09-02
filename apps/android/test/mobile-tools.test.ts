// 모바일 도구 — 카탈로그 형상, 경로 안전, 디스패치 (인메모리 DevicePort).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertiseMobileTools,
  callMobileTool,
  safeRelPath,
  type DevicePort,
} from '../src/lib/mobile-tools';

function fakePort(): DevicePort & { files: Map<string, string>; notified: string[] } {
  const files = new Map<string, string>();
  const notified: string[] = [];
  let clip = '';
  return {
    files,
    notified,
    async readFile(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`파일 없음: ${path}`);
      return v;
    },
    async writeFile(path, content, append) {
      files.set(path, append ? (files.get(path) ?? '') + content : content);
    },
    async listDir(path) {
      const prefix = path ? `${path}/` : '';
      const names = new Set<string>();
      const out: Array<{ name: string; isDir: boolean; size: number }> = [];
      for (const [p, v] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (names.has(seg)) continue;
        names.add(seg);
        const isDir = rest.includes('/');
        out.push({ name: seg, isDir, size: isDir ? 0 : v.length });
      }
      return out;
    },
    async deleteFile(path) {
      if (!files.delete(path)) throw new Error(`파일 없음: ${path}`);
    },
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
    async takePhoto(fileName) {
      files.set(fileName, '<jpeg>');
      return fileName;
    },
    async location() {
      return { latitude: 37.5665, longitude: 126.978, accuracy: 12 };
    },
    async requestPermission() {
      return 'granted' as const;
    },
  };
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
  for (const required of ['ReadFile', 'WriteFile', 'ListDir', 'Notify', 'Clipboard', 'DeviceInfo', 'TakePhoto']) {
    assert.ok(names.includes(required), `${required} 누락`);
  }
});

test('경로 안전 — 루트 탈출/절대경로 거부, 정규화', () => {
  assert.equal(safeRelPath('메모/할일.txt'), '메모/할일.txt');
  assert.equal(safeRelPath('/절대/경로.txt'), '절대/경로.txt'); // 루트 기준으로 강등
  assert.equal(safeRelPath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.throws(() => safeRelPath('../탈출.txt'));
  assert.throws(() => safeRelPath('a/../../b'));
});

test('파일 왕복 — 쓰기/덧붙이기/읽기/나열/삭제', async () => {
  const port = fakePort();
  await callMobileTool(port, 'WriteFile', { path: '메모/할일.txt', content: '1. 우유' });
  await callMobileTool(port, 'WriteFile', { path: '메모/할일.txt', content: '\n2. 빵', append: true });
  const read = await callMobileTool(port, 'ReadFile', { path: '메모/할일.txt' });
  assert.equal(read.content[0].text, '1. 우유\n2. 빵');

  const list = await callMobileTool(port, 'ListDir', { path: '메모' });
  assert.match(list.content[0].text, /할일\.txt \(\d+B\)/);

  const del = await callMobileTool(port, 'DeleteFile', { path: '메모/할일.txt' });
  assert.equal(del.isError, undefined);
  const missing = await callMobileTool(port, 'ReadFile', { path: '메모/할일.txt' });
  assert.equal(missing.isError, true); // 예외는 isError 결과로 — 브리지가 죽지 않는다
});

test('알림/클립보드/기기정보 — 결과가 LocalToolResult 계약을 따른다', async () => {
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
  assert.ok(!names.includes('TakePhoto'));
  assert.ok(names.includes('ReadFile')); // 다른 그룹은 그대로

  const port = fakePort();
  const blocked = await callMobileTool(port, 'Location', {}, enabled);
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /꺼 두었습니다/);
  assert.equal(TOOL_TO_GROUP.Location, 'location');
});

test('Location — 위도/경도/지도 링크를 돌려준다', async () => {
  const port = fakePort();
  const r = await callMobileTool(port, 'Location', {});
  const parsed = JSON.parse(r.content[0].text);
  assert.equal(parsed.latitude, 37.5665);
  assert.match(parsed.maps, /maps\.google\.com/);
});

test('OpenUrl — http(s) 만, TakePhoto — 기본 파일명 자동', async () => {
  const port = fakePort();
  const bad = await callMobileTool(port, 'OpenUrl', { url: 'file:///etc/passwd' });
  assert.equal(bad.isError, true);
  const okUrl = await callMobileTool(port, 'OpenUrl', { url: 'https://xgen.example' });
  assert.equal(okUrl.isError, undefined);

  const photo = await callMobileTool(port, 'TakePhoto', {});
  assert.match(photo.content[0].text, /photo-\d+\.jpg/);

  const unknown = await callMobileTool(port, 'NoSuchTool', {});
  assert.equal(unknown.isError, true);
});
