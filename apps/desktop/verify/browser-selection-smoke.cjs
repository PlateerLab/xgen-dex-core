const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const {
  captureBrowserSelection,
  collectBrowserSelection,
  inspectBrowserSelection,
} = require('../src/main/browser-selection.ts');

async function main() {
  await app.whenReady();

  const window = new BrowserWindow({
    show: false,
    width: 520,
    height: 360,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    const html = encodeURIComponent(`<!doctype html>
      <style>
        body { margin: 0; font-family: sans-serif; }
        button { position: absolute; left: 40px; top: 40px; width: 140px; height: 52px; }
        input { position: absolute; left: 40px; top: 120px; width: 180px; height: 32px; }
      </style>
      <button aria-label="저장">저장</button>
      <input type="password" autocomplete="current-password" value="never-expose-this" />
    `);
    await window.loadURL(`data:text/html;charset=utf-8,${html}`);

    const preview = await inspectBrowserSelection(window.webContents, { x: 80, y: 60 });
    assert.equal(preview?.tag, 'button');
    assert.equal(preview?.label, '저장');

    const button = await collectBrowserSelection(window.webContents, 'element', {
      point: { x: 80, y: 60 },
    });
    assert.equal(button?.elements[0]?.tag, 'button');
    assert.equal(button?.elements[0]?.name, '저장');
    assert.ok(!JSON.stringify(button).includes('never-expose-this'));

    const password = await collectBrowserSelection(window.webContents, 'element', {
      point: { x: 80, y: 135 },
    });
    assert.equal(password?.elements[0]?.name, '[redacted]');
    assert.ok(!JSON.stringify(password).includes('never-expose-this'));

    assert.ok(button);
    const image = await captureBrowserSelection(window.webContents, button, 'selection-smoke');
    assert.match(image.dataUrl, /^data:image\/(?:png|jpeg);base64,/);
    assert.ok(image.width > 0 && image.height > 0 && image.size > 0);

    process.stdout.write(
      `browser selection smoke ok: ${button.elements[0].tag}, ${image.width}x${image.height}\n`,
    );
  } finally {
    window.destroy();
    app.quit();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.quit();
  process.exitCode = 1;
});
