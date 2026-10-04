"use strict";

// Real Chromium smoke: this intentionally reaches a public HTTPS origin and
// verifies the same ControlApi/WebContentsView path used by the idle address bar.
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");
const { ControlApi } = require("../main/control-api");

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800 });
  const control = new ControlApi({ window, socketPath: "/tmp/halo-direct-internet-unused.sock" });
  try {
    control.setBrowserBounds({ x: 0, y: 94, width: 900, height: 650 });
    const snapshot = await control.navigate("https://example.com/");
    assert.equal(snapshot.page.loadState, "ready");
    assert.equal(new URL(snapshot.page.url).hostname, "example.com");
    assert.match(snapshot.page.title, /Example Domain/i);
    process.stdout.write(JSON.stringify({ url: snapshot.page.url, title: snapshot.page.title, loadState: snapshot.page.loadState }) + "\n");
  } finally {
    window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
