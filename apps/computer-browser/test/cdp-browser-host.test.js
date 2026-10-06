"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireCdpBrowser, resolveEndpoint, findChromium, launchFlags, isLoopbackEndpoint } = require("../main/harness/cdp-browser-host");
const { openCdpView, connectCdpTransport } = require("../main/harness/cdp-web-contents");

const CHROMIUM = findChromium(process.env, fs.existsSync) || [path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find(fs.existsSync);

test("endpoints must be loopback and carry no credentials", async () => {
  assert.equal(isLoopbackEndpoint(new URL("http://127.0.0.1:9222")), true);
  assert.equal(isLoopbackEndpoint(new URL("http://example.com:9222")), false);
  await assert.rejects(resolveEndpoint("http://example.com:9222"), /endpoint_not_local/);
  await assert.rejects(resolveEndpoint("http://user:pw@127.0.0.1:9222"), /invalid_endpoint/);
  await assert.rejects(resolveEndpoint("file:///etc/passwd"), /invalid_endpoint/);
  await assert.rejects(resolveEndpoint("not a url"), /invalid_endpoint/);
  assert.equal(await resolveEndpoint("ws://127.0.0.1:9222/devtools/browser/abc"), "ws://127.0.0.1:9222/devtools/browser/abc");
});

test("a browser advertising a non-local websocket is refused", async () => {
  const fake = async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://evil.example/devtools/browser/x" }) });
  await assert.rejects(resolveEndpoint("http://127.0.0.1:9222", fake), /endpoint_not_local/);
  const ok = async () => ({ json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) });
  assert.equal(await resolveEndpoint("http://127.0.0.1:9222", ok), "ws://127.0.0.1:9222/devtools/browser/x");
});

test("launch flags keep a private profile and reject profile, sandbox and port overrides", () => {
  const flags = launchFlags(["--mute-audio"], true, "/tmp/p");
  assert.ok(flags.includes("--user-data-dir=/tmp/p"));
  assert.ok(flags.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(flags.includes("--mute-audio"));
  assert.ok(flags.includes("--disable-extensions"));
  assert.ok(!flags.includes("--no-sandbox"));
  for (const bad of ["--user-data-dir=/Users/me", "--remote-debugging-port=9222", "--no-sandbox", "--disable-web-security", "--disable-site-isolation-trials", "--load-extension=/x", "mute"]) {
    assert.throws(() => launchFlags([bad], true, "/tmp/p"), /forbidden_flag/, bad);
  }
});

test("findChromium honours HALO_CHROMIUM and returns null when nothing exists", () => {
  assert.equal(findChromium({ HALO_CHROMIUM: "/x/chrome" }, (p) => p === "/x/chrome"), "/x/chrome");
  assert.equal(findChromium({}, () => false), null);
});

test("a missing or relative executable is rejected before anything is spawned", async () => {
  await assert.rejects(acquireCdpBrowser({ executablePath: "chrome" }), /executable_missing/);
  await assert.rejects(acquireCdpBrowser({ executablePath: "/nonexistent/chrome" }), /executable_missing/);
});

test("launch then attach: a second client reaches the same browser through its endpoint", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const launched = await acquireCdpBrowser({ executablePath: CHROMIUM });
  t.after(() => launched.close());
  assert.equal(launched.launched, true);
  const port = new URL(launched.wsUrl).port;
  const attached = await acquireCdpBrowser({ endpoint: `http://127.0.0.1:${port}` });
  assert.equal(attached.launched, false);
  assert.equal(attached.wsUrl, launched.wsUrl);
  const transport = await connectCdpTransport(attached.wsUrl);
  t.after(() => transport.close());
  const view = await openCdpView(transport, { isolated: true });
  assert.equal(await view.webContents.executeJavaScript("1 + 1"), 2);
  view.webContents.close();
});
