"use strict";

// Local-only navigation probe. Uses a disposable profile supplied by the test
// runner, a loopback server, and a harmless repository-owned file canary.
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, WebContentsView } = require("electron");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { applyBrowserHardening } = require("../main/harness/agent-viewport-host");

async function main() {
  await app.whenReady();
  const destinations = {
    file: pathToFileURL(path.join(__dirname, "../fixtures/navigation-canary.html")).href,
    data: "data:text/html,HALO_LOCAL_NAVIGATION_CANARY",
    safe: "/ok",
  };
  const server = http.createServer((req, res) => {
    const target = destinations[req.url.slice(1)];
    if (target) { res.writeHead(302, { Location: target }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>Safe local page</title><p>HALO_SAFE_PAGE</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const results = [];
  try {
    for (const kind of Object.keys(destinations)) {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `halo-nav-probe-${kind}` } });
      applyBrowserHardening(view.webContents);
      const browser = new BrowserAdapter({ view });
      window.contentView.addChildView(view);
      const redirects = [];
      view.webContents.on("will-redirect", (event, url) => redirects.push({ url, blockedByHost: event.defaultPrevented }));
      try {
        await view.webContents.loadURL(`${base}/ok`);
        const result = await browser.execute({ type: "navigate", url: `${base}/${kind}` });
        const finalUrl = view.webContents.getURL();
        const body = await view.webContents.executeJavaScript("document.body?.textContent || ''");
        if (kind === "safe") {
          assert.equal(result.status, "ok");
          assert.equal(finalUrl, `${base}/ok`);
          assert.match(body, /HALO_SAFE_PAGE/);
          assert.ok(redirects.length > 0, "benign redirect control must reach the event handler");
        } else {
          assert.equal(result.status, "failed");
          assert.ok(!finalUrl.startsWith("file:") && !finalUrl.startsWith("data:"));
          assert.doesNotMatch(body, /HALO_LOCAL_NAVIGATION_CANARY/);
          assert.ok(redirects.every((r) => r.blockedByHost), "unsafe redirects reaching HALO must be blocked by HALO");
        }
        results.push({ kind, status: result.status, redirectEvents: redirects.length,
          blockedByHost: redirects.some((r) => r.blockedByHost), canaryLoaded: body.includes("HALO_LOCAL_NAVIGATION_CANARY") });
      } finally {
        window.contentView.removeChildView(view);
        await browser.dispose();
      }
    }
    return { real: true, results };
  } finally {
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().then((result) => { console.log(`RESULT_JSON:${JSON.stringify(result)}`); app.exit(0); })
  .catch((error) => { console.error(error); app.exit(1); });
