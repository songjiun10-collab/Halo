"use strict";

// selection-copy.js: the shared selection read + clipboard copy behind the
// human Mod+C path and the agent `copy` action. The writer is injected, so no
// test ever touches the user's real clipboard.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { readSelection, copySelectionOn, MAX_RETURN_CHARS } = require("../main/harness/selection-copy");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
const { openCdpView } = require("../main/harness/cdp-web-contents");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell"), path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));

test("readSelection returns the page's selection and fails closed on broken targets", async () => {
  const script = [];
  const wc = { executeJavaScript: async (code, userGesture) => { script.push(code); assert.equal(userGesture, true); return "hello world"; } };
  assert.deepEqual(await readSelection(wc), { ok: true, text: "hello world" });
  assert.ok(script[0].includes("window.getSelection"));

  assert.equal((await readSelection(null)).errorCode, "selection_target_unavailable");
  assert.equal((await readSelection({ isDestroyed: () => true })).errorCode, "selection_target_unavailable");
  assert.equal((await readSelection({})).errorCode, "selection_unsupported");
  assert.equal((await readSelection({ executeJavaScript: async () => null })).errorCode, "selection_unsupported");
  assert.equal((await readSelection({ executeJavaScript: async () => { throw new Error("gone"); } })).errorCode, "selection_failed");
});

test("copySelectionOn writes the selection and returns a bounded copy of it", async () => {
  const written = [];
  const long = "x".repeat(MAX_RETURN_CHARS + 500);
  const wc = { executeJavaScript: async () => long };
  const result = await copySelectionOn(wc, (text) => { written.push(text); return true; });
  assert.equal(result.ok, true);
  assert.equal(result.chars, long.length, "the clipboard gets the bounded full selection");
  assert.equal(written[0].length, long.length);
  assert.equal(result.text.length, MAX_RETURN_CHARS, "the return value is truncated for the planner");
});

test("copySelectionOn reports an empty selection as ok/chars:0 and a failed write as an error", async () => {
  const empty = await copySelectionOn({ executeJavaScript: async () => "" }, () => { throw new Error("must not be called"); });
  assert.deepEqual(empty, { ok: true, chars: 0, text: "" });

  const refused = await copySelectionOn({ executeJavaScript: async () => "abc" }, () => false);
  assert.equal(refused.ok, false);
  assert.equal(refused.errorCode, "clipboard_write_failed");

  const unsupported = await copySelectionOn({}, () => true);
  assert.equal(unsupported.errorCode, "selection_unsupported");
});

test("real Chromium: select_all then copy returns the page text through the injected writer", { skip: CHROMIUM ? false : "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>copy</title><body><h1>Support</h1><p>Ticket 4821 refund policy note.</p></body>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const view = await openCdpView(launched.wsUrl, { width: 1440, height: 900 });
  const written = [];
  const adapter = new BrowserAdapter({ view, navigationTimeoutMs: 20000, permissionMode: "interact", writeClipboard: (text) => { written.push(text); return true; } });
  t.after(async () => {
    try { adapter.dispose?.(); } catch { /* best effort */ }
    try { view.closeConnection(); } catch { /* best effort */ }
    await launched.close().catch(() => undefined);
    await new Promise((resolve) => server.close(resolve));
  });

  assert.equal((await adapter.execute({ type: "navigate", url })).status, "ok");
  assert.deepEqual(await adapter.execute({ type: "select_all" }), { status: "ok" });
  const copied = await adapter.execute({ type: "copy" });
  assert.equal(copied.status, "ok");
  assert.ok(copied.chars > 0, "the page text was selected and copied");
  assert.match(copied.text, /4821 refund policy/);
  assert.match(written[0], /4821 refund policy/, "the injected writer received the real page text, not the system clipboard");

  assert.equal((await adapter.execute({ type: "zoom", direction: "reset" })).status, "ok");
});
