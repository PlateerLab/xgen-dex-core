import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { WebContents } from 'electron';
import { CdpPageProxy } from '../src/main/cdp-page-proxy';

class FakeDebugger extends EventEmitter {
  attached = false;
  attachCount = 0;

  isAttached(): boolean {
    return this.attached;
  }

  attach(): void {
    this.attached = true;
    this.attachCount += 1;
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }

  simulateProcessSwap(): void {
    this.attached = false;
    this.emit('detach', {}, 'target closed');
  }

  async sendCommand(): Promise<Record<string, never>> {
    return {};
  }
}

function fakeContents(debuggerApi: FakeDebugger): WebContents {
  return {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getTitle: () => 'Proxy test',
    getURL: () => 'https://example.com/',
    getUserAgent: () => 'XGEN test',
  } as unknown as WebContents;
}

test('debugger detach keeps the page CDP port and reattaches in place', async () => {
  const debuggerApi = new FakeDebugger();
  const detachReasons: string[] = [];
  const proxy = new CdpPageProxy(
    'stable-page',
    fakeContents(debuggerApi),
    (reason) => detachReasons.push(reason),
  );
  try {
    const port = await proxy.start();
    assert.ok(port > 0);
    assert.equal(debuggerApi.attachCount, 1);

    debuggerApi.simulateProcessSwap();
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(proxy.port, port);
    assert.equal(await proxy.start(), port);
    assert.ok(debuggerApi.attachCount >= 2);
    assert.deepEqual(detachReasons, ['target closed']);

    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.Browser, 'Electron/XGEN');
  } finally {
    await proxy.stop();
  }
});
