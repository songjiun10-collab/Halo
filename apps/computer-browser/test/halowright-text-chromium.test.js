"use strict";

// get_text against a real Chromium page: the host resolves the locator and
// reads the element's text with no input and no navigation. Skipped without a
// Chromium binary, like halowright-locator.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { runHwStep } = require("../main/harness/halowright");
const { CdpEngine } = require("../main/harness/cdp-engine");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

const LONG = "한".repeat(4000);
const FIXTURE = `<!doctype html><title>gettext</title>
<h1 data-testid="policy-heading">Refund policy</h1>
<label for="em">Email</label><input id="em" value="a@b.co">
<div data-testid="long">${LONG}</div>
<button data-testid="act">Go</button>`;

test("get_text reads real page text with no input and no navigation", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(FIXTURE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const page = engine.createPage("halo-task-gettext");
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.webContents.loadURL(url);
  const wc = page.webContents;
  const opts = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs: 5000, authorize: () => true };

  const heading = await runHwStep(wc, { op: "get_text", locator: { testid: "policy-heading" } }, opts);
  assert.equal(heading.status, "ok");
  assert.equal(heading.text, "Refund policy");
  assert.equal(heading.truncated, false);

  const field = await runHwStep(wc, { op: "get_text", locator: { label: "Email" } }, opts);
  assert.equal(field.status, "ok");
  assert.equal(field.text, "a@b.co");

  const long = await runHwStep(wc, { op: "get_text", locator: { testid: "long" } }, opts);
  assert.equal(long.status, "ok");
  assert.equal(long.truncated, true);
  assert.ok(Buffer.byteLength(long.text, "utf8") <= 4096);

  const missing = await runHwStep(wc, { op: "get_text", locator: { testid: "nope" } }, opts);
  assert.equal(missing.status, "failed");
  assert.equal(missing.errorCode, "locator_not_found");

  // Reading never navigates and never types: the URL and the field are untouched.
  assert.equal(wc.getURL(), url);
  const value = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: "document.getElementById('em').value" }]);
  assert.equal(Array.isArray(value) ? value[0] : value, "a@b.co");
});
